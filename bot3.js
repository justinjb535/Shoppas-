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
  PROCESS_SECRET,
  FNB_ACCOUNT_NAME = 'YOUR NAME',
  FNB_ACCOUNT_NUMBER = '123456789',
  FNB_BRANCH = '250655',
  BANK_NAME = 'FNB'
} = process.env

// Auth to Supabase
async function loadAuth(){
  try{
    const {data} = await supabase.from('baileys_auth').select('data').eq('id',1).single()
    if(data?.data && Object.keys(data.data).length>0){
      if(!fs.existsSync('auth_info')) fs.mkdirSync('auth_info')
      for(let k in data.data) fs.writeFileSync(`auth_info/${k}.json`, JSON.stringify(data.data[k]))
    }
  }catch{}
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

// RATE
let MARKET_RATE=17.50, SELL_RATE=18.50
const ECOCASH_FEE=0.015
async function fetchRate(){
  try{
    const r=await fetch('https://open.er-api.com/v6/latest/USD')
    const j=await r.json()
    if(j.rates?.ZAR){ MARKET_RATE=Number(j.rates.ZAR); SELL_RATE=MARKET_RATE+1; }
  }catch{}
}
setInterval(fetchRate, 24*60*60*1000); fetchRate()
function calculate(usd){ const rand=usd*SELL_RATE; const toSend=usd/(1-ECOCASH_FEE); return {rand: Number(rand.toFixed(2)), toSend: Number(toSend.toFixed(2))} }
function genRef(){ return `ZP-${Date.now().toString().slice(-6)}-${Math.floor(100+Math.random()*899)}` }

// BAILEYS
let sock=null, lastQR=null
function toJid(p){ return `${p.replace(/[^0-9]/g,'')}@s.whatsapp.net` }
function cleanPhone(j){ if(!j) return ''; let p=j.split('@')[0].split(':')[0].replace(/[^0-9]/g,''); if(p.length===13&&p.startsWith('263')&&p.endsWith('0')) p=p.slice(0,-1); if(p.startsWith('0')) p='263'+p.slice(1); if(p.length>12) p=p.slice(0,12); return `+${p}` }
async function sendWA(to,txt){ try{ if(!sock) return false; await sock.sendMessage(toJid(to),{text:txt}); return true }catch{ return false } }

const queues=new Map()
function getQ(k){ if(!queues.has(k)) queues.set(k,{pending:[],lastSent:0}); return queues.get(k) }

async function processQueues(){
  for(const [k,q] of queues.entries()){
    if(!q.pending.length) continue
    if(Date.now()-q.lastSent<60*1000) continue
    const job=q.pending.shift()
    const waMsg=`PAY ${job.eco} ${job.calc.toSend} - Ref ${job.ref}`
    const ok=await sendWA(k, waMsg)
    if(ok){
      q.lastSent=Date.now()
      await supabase.from('payments').update({status:'SENT', sent_amount:job.calc.toSend, sent_at:new Date().toISOString()}).eq('zp_ref',job.ref)
      // Notify customer that money sent
      await sendWA(job.customerPhone, `✅ *SENT!* R${job.calc.rand} received\n$${job.usd} clean sent to ${job.eco}\nRef: ${job.ref}\nZIM gets it in <2 mins via EcoCash`)
      console.log(`Sent ${job.ref} ${waMsg}`)
    } else q.pending.unshift(job)
  }
}
setInterval(processQueues, 10*1000)

// FNB SCAN
function scanFNB(){
  return new Promise((resolve)=>{
    const found=[]; if(!FNB_EMAIL) return resolve(found)
    const imap=new Imap({user:FNB_EMAIL,password:FNB_PASS,host:FNB_HOST,port:993,tls:true,tlsOptions:{rejectUnauthorized:false}})
    imap.once('ready',()=>{
      imap.openBox('INBOX',false,()=>{
        imap.search(['UNSEEN',['FROM','fnb']],(e,results)=>{
          if(!results?.length){imap.end();return resolve(found)}
          const f=imap.fetch(results,{bodies:''})
          f.on('message',(msg)=>{msg.on('body',async(s)=>{try{const p=await simpleParser(s);const b=`${p.subject} ${p.text} ${p.html||''}`;const amt=b.match(/R\s?([\d,]+\.?\d*)/);const ref=b.match(/(ZP-\d+-\d+)/i);if(amt&&ref)found.push({ref:ref[1].toUpperCase(),amt:parseFloat(amt[1].replace(/,/g,''))})}catch{}})})
          f.once('end',()=>{imap.end();resolve(found)}); f.once('error',()=>{imap.end();resolve(found)})
        })
      })
    })
    imap.once('error',()=>resolve(found))
    try{imap.connect()}catch{resolve(found)}
  })
}

// WEB
app.get('/',(_,res)=>res.send(`Remii LIVE Rate R${SELL_RATE} <a href="/qr">QR</a>`))
app.get('/qr', async (_,res)=>{ if(!lastQR) return res.send('✅ Connected'); const img=await QRCode.toDataURL(lastQR); res.send(`<img src="${img}" width="350"/>`) })
app.get('/process', async (req,res)=>{
  if(req.query.key!==PROCESS_SECRET) return res.status(403).send('bad')
  const pays=await scanFNB()
  let log=`FNB ${pays.length}\n`
  for(const p of pays){
    const {data: pay} = await supabase.from('payments').select('*').eq('zp_ref',p.ref).eq('status','PENDING').maybeSingle()
    if(!pay){log+=`No pending ${p.ref}\n`;continue}
    const calc=calculate(pay.usd_amount)
    // Queue to YOUR_ZIM_SENDER - MacroDroid phone will catch PAY message and auto EcoCash
    const q=getQ(YOUR_ZIM_SENDER)
    q.pending.push({ref:p.ref, eco:pay.customer_ecocash, usd:pay.usd_amount, customerPhone:pay.customer_phone, calc})
    await supabase.from('payments').update({status:'QUEUED', fnb_amount:p.amt, queued_at:new Date().toISOString()}).eq('zp_ref',p.ref)
    log+=`Queued ${p.ref} -> ${YOUR_ZIM_SENDER} PAY ${pay.customer_ecocash} ${calc.toSend}\n`
  }
  res.send(log)
})
app.listen(process.env.PORT||10000)

// BOT
async function startBot(){
  await loadAuth()
  const {state, saveCreds}=await useMultiFileAuthState('auth_info')
  sock=makeWASocket({ auth: state, browser:['Remii','Chrome','1.0'], markOnlineOnConnect:false })
  sock.ev.on('creds.update', async ()=>{ await saveCreds(); await saveAuth() })
  sock.ev.on('connection.update', u=>{
    if(u.qr){ lastQR=u.qr }
    if(u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) startBot()
    if(u.connection==='open'){ console.log('CONNECTED ✅'); lastQR=null }
  })
/*  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]; if(!m?.message||m.key.fromMe) return
      const from=m.key.remoteJid; if(from.endsWith('@g.us')) return
      let phone=cleanPhone(from)
      const text=m.message.conversation||m.message.extendedTextMessage?.text||''; if(!text) return
      const upper=text.trim().toUpperCase()
      console.log(`${phone}: ${text}`)

      // CUSTOMER FLOW - ANYONE can do PAY
      // Customer sends: 100 0771234567  OR  PAY 100 0771234567
      if(text.match(/\d+/) && text.match(/07|263|77/)){
        let usd, eco
        const parts=text.trim().split(/\s+/)
        if(upper.startsWith('PAY')){ usd=parseFloat(parts[1]); eco=parts[2] } 
        else { usd=parseFloat(parts[0]); eco=parts[1] }
        if(!usd || !eco) return sendWA(phone, `Send like:\n100 0771234567\n\nMeaning $100 to 0771234567 ZIM`)

        const calc=calculate(usd)
        const ref=genRef()
        await supabase.from('payments').insert({ 
          zp_ref:ref, 
          usd_amount:usd, 
          customer_ecocash:eco, 
          customer_phone:phone,
          status:'PENDING', 
          created_at:new Date().toISOString() 
        })

        const msg=`💸 *Remii - SA to ZIM Instant*\n\n`+
        `You send: *$${usd} clean* to *${eco}* (ZIM)\n`+
        `Rate: R${SELL_RATE}/$1 (R1 + 2.5% incl)\n`+
        `Pay: *R${calc.rand}*\n\n`+
        `*BANK TO PAY (FNB):*\n`+
        `Bank: ${BANK_NAME}\n`+
        `Name: ${FNB_ACCOUNT_NAME}\n`+
        `Acc: ${FNB_ACCOUNT_NUMBER}\n`+
        `Branch: ${FNB_BRANCH}\n`+
        `Amount: R${calc.rand}\n`+
        `Reference: *${ref}*\n\n`+
        `⚡ After payment, ZIM gets money in <15 mins automatically\n`+
        `Send proof? Not needed, we auto-detect FNB`

        await sendWA(phone, msg)
        return
      }

      if(upper==='RATE') return sendWA(phone, `Remii Rate R${SELL_RATE}/$1\n$100 = R${(100*SELL_RATE).toFixed(2)}\nSA RAND -> ZIM USD clean`)

      if(upper.startsWith('REGISTER')){
        return sendWA(phone, `You are owner? Set env YOUR_ZIM_SENDER and FNB_EMAIL in .env\nCustomers don't need REGISTER, just send: 100 0771234567`)
      }

    }catch(e){console.log(e.message)}
  })*/
  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]; if(!m?.message||m.key.fromMe) return
      const from=m.key.remoteJid; if(from.endsWith('@g.us')) return
      let phone=cleanPhone(from)
      const text=m.message.conversation||m.message.extendedTextMessage?.text||m.message.imageMessage?.caption||''; 
      if(!text) return
      console.log(`IN: ${phone} => ${text}`)
      
      // ALWAYS reply something to confirm bot alive
      const upper=text.trim().toUpperCase()

      // DEBUG: just reply if pay
      if(upper.includes('PAY') || /^\d+\s+0/.test(text.trim())){
        try{
          let usd, eco
          const parts=text.trim().split(/\s+/)
          if(upper.startsWith('PAY')){ usd=parseFloat(parts[1]); eco=parts[2] } 
          else { usd=parseFloat(parts[0]); eco=parts[1] }
          
          if(!usd || !eco){
            await sendWA(phone, `Format: 100 0771234567\nYou sent: ${text}`)
            return
          }

          const calc=calculate(usd)
          const ref=genRef()
          
          const {error} = await supabase.from('payments').insert({ 
            zp_ref:ref, 
            usd_amount:usd, 
            customer_ecocash:eco, 
            customer_phone:phone,
            status:'PENDING', 
            created_at:new Date().toISOString() 
          })
          if(error){ console.log('DB error', error); await sendWA(phone, `DB Error: ${error.message}`); return }

          const msg=`💸 *Remii*\n\nYou send: $${usd} to ${eco}\nPay: *R${calc.rand}*\n\nBank: ${BANK_NAME}\nName: ${FNB_ACCOUNT_NAME}\nAcc: ${FNB_ACCOUNT_NUMBER}\nRef: *${ref}*\n\nRate R${SELL_RATE}`
          
          console.log(`OUT: ${msg}`)
          await sendWA(phone, msg)
        }catch(e){
          console.log('PAY error', e)
          await sendWA(phone, `Error: ${e.message}`)
        }
        return
      }

      if(upper==='RATE' || upper==='HI' || upper==='HELLO'){
        await sendWA(phone, `Remii alive. Send: 100 0771234567\nRate R${SELL_RATE}`)
      }

    }catch(e){console.log('main handler',e)}
  })
}
startBot()
