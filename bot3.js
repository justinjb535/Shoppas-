import dotenv from 'dotenv'
dotenv.config()
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import QRCode from 'qrcode'
import { createClient } from '@supabase/supabase-js'
import Imap from 'imap'
import { simpleParser } from 'mailparser'

const app = express()
app.use(express.json())
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const {
  YOUR_ZIM_SENDER,
  OWNER_NUMBER,
  FNB_EMAIL, FNB_PASS,
  FNB_HOST = 'imap.gmail.com',
  PROCESS_SECRET
} = process.env

// === AUTH SAVE TO SUPABASE (no disk needed) ===
async function loadAuth(){
  try{
    const {data} = await supabase.from('baileys_auth').select('data').eq('id',1).single()
    if(data?.data && Object.keys(data.data).length>0){
      if(!fs.existsSync('auth_info')) fs.mkdirSync('auth_info')
      for(let k in data.data) fs.writeFileSync(`auth_info/${k}.json`, JSON.stringify(data.data[k]))
      console.log('✅ Auth loaded from Supabase')
    }
  }catch(e){ console.log('loadAuth', e.message) }
}
async function saveAuth(){
  try{
    if(!fs.existsSync('auth_info')) return
    let obj={}
    fs.readdirSync('auth_info').forEach(f=>{
      if(f.endsWith('.json')) try{obj[f.replace('.json','')]=JSON.parse(fs.readFileSync(`auth_info/${f}`,'utf8'))}catch{}
    })
    await supabase.from('baileys_auth').upsert({id:1, data: obj})
  }catch{}
}

// === RATE ===
let MARKET_RATE = 17.50
const MARKUP = 1.00
const ECOCASH_FEE = 0.015
const Skyie_Fee = 0.025
let SELL_RATE = MARKET_RATE + MARKUP

async function fetchRate(){
  try{
    const r = await fetch('https://open.er-api.com/v6/latest/USD')
    const j = await r.json()
    if(j.rates?.ZAR){
      MARKET_RATE = Number(j.rates.ZAR)
      SELL_RATE = MARKET_RATE + MARKUP
      await supabase.from('settings').upsert({ key:'usd_zar_rate', value:MARKET_RATE, sell_rate:SELL_RATE }, {onConflict:'key'})
      console.log(`Rate Market R${MARKET_RATE} Sell R${SELL_RATE}`)
    }
  }catch{}
}
setInterval(fetchRate, 24*60*60*1000)
fetchRate()

function calculateCleanSend(usdWanted){
  const totalRand = usdWanted * SELL_RATE
  const usdToSend = usdWanted / (1 - ECOCASH_FEE)
  const marketCost = usdToSend * MARKET_RATE
  const profit = totalRand - marketCost
  return {
    usdWanted,
    usdToSend: Number(usdToSend.toFixed(2)),
    customerPaysRand: Number(totalRand.toFixed(2)),
    profitRand: Number(profit.toFixed(2)),
    message: `Rate R${SELL_RATE.toFixed(2)}/$1 (Market R${MARKET_RATE.toFixed(2)}+R1)\nSA pays R${totalRand.toFixed(2)} for $${usdWanted} ZIM clean`
  }
}
function genZPRef(){
  const t = Date.now().toString().slice(-6)
  const r = Math.floor(100+Math.random()*899)
  return `ZP-${t}-${r}`
}

// === BAILEYS CORE ===
let sock=null
let lastQR=null
function toJid(phone){ return `${phone.replace(/[^0-9]/g,'')}@s.whatsapp.net` }
function cleanPhone(jid){
  if(!jid) return ''
  let p = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
  if(p.length===13 && p.startsWith('263') && p.endsWith('0')) p=p.slice(0,-1)
  if(p.startsWith('0') && p.length>=10) p='263'+p.slice(1)
  if(p.length>12) p=p.slice(0,12)
  return `+${p}`
}
async function sendWhatsApp(to, text){
  try{
    if(!sock) return false
    await sock.sendMessage(toJid(to), { text })
    return true
  }catch(e){ console.log('WA fail', e.message); return false }
}
async function getAgent(phone){
  const {data} = await supabase.from('agents').select('*').eq('phone', phone).single()
  return data
}
async function addCredits(phone, amountRand){
  const ag = await getAgent(phone)
  if(!ag) return null
  const rate = ag.use_my_ecocash ? 15 : 10
  const creditsToAdd = Math.floor(amountRand / rate)
  const newBal = (ag.credits||0) + creditsToAdd
  await supabase.from('agents').update({ credits:newBal, paused:false }).eq('phone', phone)
  await sendWhatsApp(phone, `✅ Credited R${amountRand} = ${creditsToAdd} credits @ R${rate}/tx\nBal: ${newBal}\nBot resumed`)
  return newBal
}
async function canSend(phone){ if(phone===OWNER_NUMBER) return true; const ag=await getAgent(phone); return ag && !ag.paused && (ag.credits||0)>0 }
async function deductCredit(phone){
  if(phone===OWNER_NUMBER) return {left:9999}
  const ag=await getAgent(phone)
  const newBal=(ag.credits||0)-1
  await supabase.from('agents').update({ credits:newBal }).eq('phone', phone)
  if(newBal<=0){
    await supabase.from('agents').update({ paused:true }).eq('phone', phone)
    await sendWhatsApp(phone, `⚠️ Last credit used! PAUSED. Top up AGENT-${phone.slice(-4)}`)
  }
  return {left:newBal}
}

// === QUEUE - MULTI TENANT ===
const queues=new Map()
function getQueue(k){ if(!queues.has(k)) queues.set(k,{pending:[],lastSent:0,windowStart:Date.now(),count:0}); return queues.get(k) }
function queueWASend(queueKey, executorWhatsApp, waMessage, agentPhone, zpRef, calc, useMine){
  const q=getQueue(queueKey); q.pending.push({executorWhatsApp,waMessage,agentPhone,zpRef,calc,useMine}); console.log(`Queued ${zpRef} -> ${executorWhatsApp} useMine=${useMine}`)
}
async function processQueues(){
  for(const [k,q] of queues.entries()){
    if(!q.pending.length) continue
    const now=Date.now()
    if(now-q.windowStart>10*60*1000){q.windowStart=now;q.count=0}
    if(q.count>=5) continue
    if(now-q.lastSent<60*1000) continue
    const job=q.pending.shift()
    const ok=await sendWhatsApp(job.executorWhatsApp, job.waMessage)
    if(ok){
      q.lastSent=now;q.count++
      const d=await deductCredit(job.agentPhone)
      await supabase.from('payments').update({status:'SENT', sent_amount:job.calc.usdToSend, sent_at:new Date().toISOString()}).eq('zp_ref',job.zpRef)
      if(job.useMine) await sendWhatsApp(job.agentPhone, `${job.calc.message}\n✅ Sent by OWNER\nRef:${job.zpRef}\nLeft:${d.left}`)
      else await sendWhatsApp(job.agentPhone, `${job.calc.message}\n✅ Sent to YOUR EcoCash ${job.executorWhatsApp}\nRef:${job.zpRef}\nLeft:${d.left}`)
    }else q.pending.unshift(job)
  }
}
setInterval(processQueues,15*1000)

// === FNB SCANNER ===
function scanFNB(){
  return new Promise((resolve)=>{
    const found=[]; if(!FNB_EMAIL) return resolve(found)
    const imap=new Imap({user:FNB_EMAIL,password:FNB_PASS,host:FNB_HOST,port:993,tls:true,tlsOptions:{rejectUnauthorized:false}})
    imap.once('ready',()=>{
      imap.openBox('INBOX',false,(err)=>{
        if(err){imap.end();return resolve(found)}
        imap.search(['UNSEEN',['FROM','fnb']],(err,results)=>{
          if(!results?.length){imap.end();return resolve(found)}
          const f=imap.fetch(results,{bodies:''})
          f.on('message',(msg)=>{msg.on('body',async(s)=>{try{const p=await simpleParser(s);const b=`${p.subject} ${p.text} ${p.html||''}`;const amt=b.match(/R\s?([\d,]+\.?\d*)/);const ref=b.match(/(ZP-\d+-\d+|AGENT-\w+)/i);if(amt&&ref)found.push({ref:ref[1].toUpperCase(),amt:parseFloat(amt[1].replace(/,/g,''))})}catch{}})})
          f.once('end',()=>{imap.end();resolve(found)});f.once('error',()=>{imap.end();resolve(found)})
        })
      })
    })
    imap.once('error',()=>resolve(found))
    try{imap.connect()}catch{resolve(found)}
  })
}

// === WEB ===
app.get('/',(_,res)=>res.send(`v6 LIVE Rate R${SELL_RATE} Baileys ${sock?'✅':'❌'} <a href="/qr">/qr</a>`))
app.get('/qr', async (_,res)=>{ if(!lastQR) return res.send('✅ Connected'); const img=await QRCode.toDataURL(lastQR); res.send(`<h1>Scan with WhatsApp > Linked Devices</h1><img src="${img}" width="350"/>`) })

app.get('/process', async (req,res)=>{
  if(req.query.key!==PROCESS_SECRET) return res.status(403).send('bad key')
  const payments=await scanFNB()
  let log=`FNB found ${payments.length} | Rate R${SELL_RATE}\n`
  for(const p of payments){
    if(p.ref.startsWith('AGENT-')){
      const suffix=p.ref.split('-')[1]
      const {data:agents}=await supabase.from('agents').select('*').ilike('phone',`%${suffix}`)
      const ag=agents?.[0]; if(ag){const bal=await addCredits(ag.phone,p.amt); log+=`Topup ${ag.phone} R${p.amt} -> ${bal}\n`}
      continue
    }
    if(p.ref.startsWith('ZP-')){
      const {data:pay}=await supabase.from('payments').select('*, agents!inner(*)').eq('zp_ref',p.ref).eq('status','PENDING').maybeSingle()
      if(!pay){log+=`No pending ${p.ref}\n`;continue}
      const ag=pay.agents
      if(!await canSend(ag.phone)){await sendWhatsApp(ag.phone,`❌ ${p.ref} NO CREDITS`);log+=`Blocked ${ag.phone}\n`;continue}
      const calc=calculateCleanSend(pay.usd_amount)
      const waMsg=`PAY ${pay.customer_ecocash} ${calc.usdToSend} - Ref ${p.ref}`
      const useMine=ag.use_my_ecocash
      let executorWhatsApp, queueKey
      if(useMine){ executorWhatsApp=OWNER_NUMBER; queueKey=YOUR_ZIM_SENDER }
      else { executorWhatsApp=ag.sender_phone; queueKey=ag.sender_phone }
      queueWASend(queueKey, executorWhatsApp, waMsg, ag.phone, p.ref, calc, useMine)
      await supabase.from('payments').update({status:'QUEUED', fnb_amount:p.amt, queued_at:new Date().toISOString()}).eq('zp_ref',p.ref)
      log+=`Queued ${waMsg} -> ${executorWhatsApp} useMine=${useMine}\n`
    }
  }
  res.send(log + `\nQueues: ${Array.from(queues.entries()).map(([k,v])=>`${k}:${v.pending.length}`).join(', ')}`)
})

app.listen(process.env.PORT||10000, ()=>console.log('Web running'))

// === BOT START ===
async function startBot(){
  await loadAuth()
  const {state, saveCreds}=await useMultiFileAuthState('auth_info')
  sock=makeWASocket({ auth: state, browser:['EcoCash Bot','Chrome','1.0'], markOnlineOnConnect:false })
  sock.ev.on('creds.update', async ()=>{ await saveCreds(); await saveAuth() })
  sock.ev.on('connection.update', u=>{
    if(u.qr){ lastQR=u.qr; console.log('QR READY -> /qr') }
    if(u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) startBot()
    if(u.connection==='open'){ console.log('BOT CONNECTED ✅'); lastQR=null }
  })

  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]; if(!m?.message || m.key.fromMe) return
      const from=m.key.remoteJid; if(from.endsWith('@g.us')) return
      let phone=cleanPhone(from)
      try{ const mp=await sock.signalRepository?.lidMapping?.getPNForLID(from); if(mp) phone=cleanPhone(mp) }catch{}
      if(m.key.participant){ try{ const mp2=await sock.signalRepository?.lidMapping?.getPNForLID(m.key.participant); phone=cleanPhone(mp2||m.key.participant) }catch{ phone=cleanPhone(m.key.participant) } }

      const text=m.message.conversation||m.message.extendedTextMessage?.text||''
      const upper=text.trim().toUpperCase(); if(!upper) return
      console.log(`WA ${phone}: ${text}`)

      // REGISTER
      if(upper.startsWith('REGISTER')){
        const parts=text.split(/\s+/); const email=(parts[1]||'').toLowerCase(); const useMine=upper.includes('USEMINE'); const p2=parts[2]||''
        if(!email.includes('@')) return sendWhatsApp(phone,'Format: REGISTER email USEMINE  OR  REGISTER email +27712345678')
        const senderPhone=useMine? YOUR_ZIM_SENDER : (p2.startsWith('+')?p2:`+${p2.replace(/[^0-9]/g,'')}`)
        await supabase.from('agents').upsert({ phone, fnb_email:email, sender_phone:senderPhone, use_my_ecocash:useMine, credits: phone===OWNER_NUMBER?9999:0, paused:false }, {onConflict:'phone'})
        return sendWhatsApp(phone,`✅ Registered\nEmail:${email}\nSender:${senderPhone}\nMode:${useMine?'MY EcoCash (I send)':'YOUR EcoCash'}\nRef for topup: AGENT-${phone.slice(-4)}\n\nNow send: PAY 100 0771234567 to create order`)
      }

      if(upper==='BALANCE'){ const ag=await getAgent(phone); if(!ag) return sendWhatsApp(phone,'Not registered'); const q=getQueue(ag.sender_phone); return sendWhatsApp(phone,`💰 ${phone===OWNER_NUMBER?'OWNER ∞':ag.paused?'PAUSED':'ACTIVE'}\nCredits:${phone===OWNER_NUMBER?'∞':ag.credits}\nRate:R${SELL_RATE}\nSender:${ag.sender_phone}\nQueue:${q.pending.length}`) }
      if(upper==='RATE') return sendWhatsApp(phone,`Rate: R${SELL_RATE}/$1\nSA customer pays R${SELL_RATE} per $1 ZIM clean\n$50 = R${(50*SELL_RATE).toFixed(2)}\n$100 = R${(100*SELL_RATE).toFixed(2)}`)
      if(upper.startsWith('ADD') && phone===OWNER_NUMBER){ const parts=text.split(/\s+/); const tgt=parts[1]; const amt=parseFloat(parts[2])||0; const bal=await addCredits(tgt,amt); return sendWhatsApp(phone,`Added R${amt} to ${tgt} -> ${bal}`) }

      // === CREATE REF - SA CUSTOMER FLOW ===
      if(upper.startsWith('PAY ') || (!isNaN(upper.split(' ')[0]) && text.match(/07|263/))){
        let usd, eco
        const parts=text.trim().split(/\s+/)
        if(upper.startsWith('PAY')){ usd=parseFloat(parts[1]); eco=parts[2] } else { usd=parseFloat(parts[0]); eco=parts[1] }
        if(!usd || !eco){ return sendWhatsApp(phone,`❌ Use:\nPAY 100 0771234567\n\nSA customer pays RAND, ZIM gets $${usd||'100'} EcoCash clean`) }
        const ag=await getAgent(phone); if(!ag) return sendWhatsApp(phone,'Not registered. REGISTER first')
        if(!await canSend(phone)) return sendWhatsApp(phone,`❌ NO CREDITS. Top up AGENT-${phone.slice(-4)}`)
        const calc=calculateCleanSend(usd)
        const ref=genZPRef()
        await supabase.from('payments').insert({ zp_ref:ref, usd_amount:usd, customer_ecocash:eco, agent_phone:phone, status:'PENDING', created_at:new Date().toISOString() })
        const msg=`✅ *ORDER CREATED - SA -> ZIM*\n\n`+
        `Ref: *${ref}*\n`+
        `SA Customer Pays: *R${calc.customerPaysRand}* (FNB)\n`+
        `ZIM Receiver Gets: *$${usd} clean* EcoCash on ${eco}\n`+
        `You will send: $${calc.usdToSend} (covers 1.5% fee)\n`+
        `Rate: R${SELL_RATE}/$1\n`+
        `Profit: R${calc.profitRand}\n\n`+
        `*TELL SA CUSTOMER:*\n`+
        `Bank: FNB\n`+
        `Amount: R${calc.customerPaysRand}\n`+
        `Reference: *${ref}*\n\n`+
        `After FNB payment, bot auto sends EcoCash in 5 mins.`
        return sendWhatsApp(phone,msg)
      }

    }catch(e){console.log('handler',e.message)}
  })
}
startBot()
