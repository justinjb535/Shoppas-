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
  VERIFY_TOKEN, PROCESS_SECRET,
  FNB_EMAIL, FNB_PASS,
  FNB_HOST = 'imap.gmail.com'
} = process.env

// === SUPABASE AUTH STORAGE (from your shopping bot) ===
async function loadAuth(){
  try{
    const {data} = await supabase.from('baileys_auth').select('data').eq('id',1).single()
    if(data?.data){
      if(!fs.existsSync('auth_info')) fs.mkdirSync('auth_info')
      for(let k in data.data) fs.writeFileSync(`auth_info/${k}.json`, JSON.stringify(data.data[k]))
      console.log('Auth loaded from Supabase')
    }
  }catch(e){ console.log('loadAuth skip', e.message) }
}
async function saveAuth(){
  try{
    if(!fs.existsSync('auth_info')) return
    let obj={}
    fs.readdirSync('auth_info').forEach(f=>{
      if(f.endsWith('.json')) try{obj[f.replace('.json','')]=JSON.parse(fs.readFileSync(`auth_info/${f}`,'utf8'))}catch{}
    })
    await supabase.from('baileys_auth').upsert({id:1, data: obj})
    console.log('Auth saved to Supabase')
  }catch(e){ console.log('saveAuth err', e.message) }
}

// === RATE ===
let MARKET_RATE = 17.50
const MARKUP = 1.00
const Skyie_Fee = 0.025
const ECOCASH_FEE = 0.015
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
  }catch{ console.log('Rate fail') }
}
setInterval(fetchRate, 24*60*60*1000)
fetchRate()

function calculateCleanSend(usdWanted){
  const totalRand = usdWanted * SELL_RATE
  const usdToSend = usdWanted / (1 - ECOCASH_FEE)
  const marketCost = usdToSend * MARKET_RATE
  const totalProfitRand = totalRand - marketCost
  return {
    usdWanted,
    usdToSend: Number(usdToSend.toFixed(2)),
    customerPaysRand: Number(totalRand.toFixed(2)),
    profitRand: Number(totalProfitRand.toFixed(2)),
    message: `Rate: R${SELL_RATE.toFixed(2)}/$1\nPay: R${totalRand.toFixed(2)} for $${usdWanted}\nSend $${usdToSend.toFixed(2)}`
  }
}

// === BAILEYS ===
let sock=null
let lastQR=null

function toJid(phone){
  let p = phone.replace(/[^0-9]/g,'')
  return `${p}@s.whatsapp.net`
}
function cleanPhone(jid){
  if(!jid) return ''
  let p = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
  if(p.length === 13 && p.startsWith('263') && p.endsWith('0')) p = p.slice(0,-1)
  if(p.startsWith('0') && p.length>=10) p = '263'+p.slice(1)
  if(p.length>12) p = p.slice(0,12)
  return `+${p}`
}
async function sendWhatsApp(to, text){
  try{
    if(!sock) return false
    await sock.sendMessage(toJid(to), { text })
    console.log(`WA -> ${to}: ${text.slice(0,50)}`)
    return true
  }catch(e){ console.error('WA fail', e.message); return false }
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
  await sendWhatsApp(phone, `✅ Credited R${amountRand} = ${creditsToAdd} @ R${rate}/tx\nBal: ${newBal}`)
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
    await sendWhatsApp(phone, `⚠️ PAUSED. Top up AGENT-${phone.slice(-4)}`)
  }
  return {left:newBal}
}

// === QUEUE MULTI-TENANT ===
const SEND_DELAY_MS=60*1000, MAX_PER_WINDOW=5, WINDOW_MS=10*60*1000
const queues=new Map()
function getQueue(phone){ if(!queues.has(phone)) queues.set(phone,{pending:[],lastSent:0,windowStart:Date.now(),count:0}); return queues.get(phone) }
function queueWASend(queueKey, executorWhatsApp, waMessage, agentPhone, zpRef, calc, useMine){
  const q=getQueue(queueKey); q.pending.push({executorWhatsApp,waMessage,agentPhone,zpRef,calc,useMine}); console.log(`Queued ${zpRef} -> ${executorWhatsApp} useMine=${useMine}`)
}
async function processQueues(){
  for(const [k,q] of queues.entries()){
    if(!q.pending.length) continue
    const now=Date.now()
    if(now-q.windowStart>WINDOW_MS){q.windowStart=now;q.count=0}
    if(q.count>=MAX_PER_WINDOW) continue
    if(now-q.lastSent<SEND_DELAY_MS) continue
    const job=q.pending.shift()
    const ok=await sendWhatsApp(job.executorWhatsApp, job.waMessage)
    if(ok){
      q.lastSent=now;q.count++
      const d=await deductCredit(job.agentPhone)
      await supabase.from('payments').update({status:'SENT', sent_amount:job.calc.usdToSend, sent_at:new Date().toISOString()}).eq('zp_ref',job.zpRef)
      if(job.useMine) await sendWhatsApp(job.agentPhone, `${job.calc.message}\n ✅ Queued to MY EcoCash\nRef:${job.zpRef}\nLeft:${d.left}`)
      else await sendWhatsApp(job.agentPhone, `${job.calc.message}\n ✅ Sent to YOUR EcoCash\nRef:${job.zpRef}\nLeft:${d.left}`)
    }else q.pending.unshift(job)
  }
}
setInterval(processQueues,15*1000)

// === START BOT ===
app.get('/',(_,res)=>res.send(`EcoCash Bot LIVE Sell R${SELL_RATE} ${sock?'Connected':'No sock'}`))
app.get('/qr', async (_,res)=>{ if(!lastQR) return res.send('✅ Connected'); const img=await QRCode.toDataURL(lastQR); res.send(`<h1>Scan this</h1><img src="${img}" width="300"/>`) })
app.listen(process.env.PORT||10000, ()=>console.log('Web running'))

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
          f.on('message',(msg)=>{msg.on('body',async(stream)=>{try{const parsed=await simpleParser(stream);const body=`${parsed.subject} ${parsed.text} ${parsed.html||''}`;const amtM=body.match(/R\s?([\d,]+\.?\d*)/);const refM=body.match(/(ZP-\d+-\d+|AGENT-\w+)/i);if(amtM&&refM)found.push({ref:refM[1].toUpperCase(),amt:parseFloat(amtM[1].replace(/,/g,''))})}catch{}})})
          f.once('end',()=>{imap.end();resolve(found)});f.once('error',()=>{imap.end();resolve(found)})
        })
      })
    })
    imap.once('error',()=>resolve(found))
    try{imap.connect()}catch{resolve(found)}
  })
}

app.get('/process', async (req,res)=>{
  if(req.query.key!==PROCESS_SECRET) return res.status(403).send('bad key')
  const payments=await scanFNB()
  let log=`FNB ${payments.length} | Sell R${SELL_RATE}\n`
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
  res.send(log)
})

async function startBot(){
  await loadAuth()
  const {state, saveCreds}=await useMultiFileAuthState('auth_info')
  sock=makeWASocket({ auth: state, browser:['EcoCash','Chrome','1.0'], markOnlineOnConnect:false })
  sock.ev.on('creds.update', async ()=>{ await saveCreds(); await saveAuth() })
  sock.ev.on('connection.update', u=>{
    if(u.qr){ lastQR=u.qr; console.log('QR READY - go to /qr') }
    if(u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) startBot()
    if(u.connection==='open'){ console.log('BOT CONNECTED ✅'); lastQR=null }
  })
  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]; if(!m?.message || m.key.fromMe) return
      const from=m.key.remoteJid; if(from.endsWith('@g.us')) return
      let phone=cleanPhone(from)
      try{ const mapped=await sock.signalRepository?.lidMapping?.getPNForLID(from); if(mapped) phone=cleanPhone(mapped) }catch{}
      if(m.key.participant){ try{ const mp=await sock.signalRepository?.lidMapping?.getPNForLID(m.key.participant); phone=cleanPhone(mp||m.key.participant) }catch{ phone=cleanPhone(m.key.participant) } }
      const text=m.message.conversation||m.message.extendedTextMessage?.text||''
      const upper=text.trim().toUpperCase(); if(!upper) return
      console.log(`WA from ${phone}: ${text}`)
      if(upper.startsWith('REGISTER')){
        const parts=text.split(/\s+/); const fnbEmail=(parts[1]||'').toLowerCase(); const useMine=upper.includes('USEMINE'); const phonePart=parts[2]||''
        if(!fnbEmail.includes('@')) return sendWhatsApp(phone,'Format: REGISTER email +263... OR REGISTER email USEMINE')
        const senderPhone=useMine? YOUR_ZIM_SENDER : (phonePart.startsWith('+')?phonePart:`+${phonePart.replace(/[^0-9]/g,'')}`)
        await supabase.from('agents').upsert({ phone, fnb_email:fnbEmail, sender_phone:senderPhone, use_my_ecocash:useMine, credits: phone===OWNER_NUMBER?9999:0, paused:false }, {onConflict:'phone'})
        await sendWhatsApp(phone,`✅ Registered\nEmail:${fnbEmail}\nSender:${senderPhone}\nUseMine:${useMine}\nRef: AGENT-${phone.slice(-4)}`)
      }
      if(upper==='BALANCE'){ const ag=await getAgent(phone); if(!ag) return sendWhatsApp(phone,'Not registered'); const q=getQueue(ag.sender_phone); await sendWhatsApp(phone,`💰 ${phone===OWNER_NUMBER?'OWNER':'ACTIVE'}\nCredits:${phone===OWNER_NUMBER?'∞':ag.credits}\nSender:${ag.sender_phone}\nQueue:${q.pending.length}`) }
      if(upper==='RATE') await sendWhatsApp(phone,`Sell R${SELL_RATE}/$1\n$100 = R${(100*SELL_RATE).toFixed(2)}`)
      if(upper.startsWith('ADD') && phone===OWNER_NUMBER){ const parts=text.split(/\s+/); const target=parts[1]; const amt=parseFloat(parts[2])||0; const bal=await addCredits(target,amt); await sendWhatsApp(phone,`Added R${amt} to ${target} -> ${bal}`) }
    }catch(e){console.log('handler err',e.message)}
  })
}
startBot()
