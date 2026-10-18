import dotenv from 'dotenv'
dotenv.config()
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import QRCode from 'qrcode'
import { createClient } from '@supabase/supabase-js'

console.log('SUPABASE_URL?', !!process.env.SUPABASE_URL)
const app = express()
app.use(express.json())
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

// Helpers
async function loadAuth(){
  try{
    const {data} = await supabase.from('baileys_auth').select('data').eq('id',1).single()
    if(data?.data){
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
      if(f.endsWith('.json')) try{obj[f.replace('.json','')]=JSON.parse(fs.readFileSync(`auth_info/${f}`))}catch{}
    })
    await supabase.from('baileys_auth').upsert({id:1, data: obj})
  }catch{}
}
function genKey(name){ return `alveolCloudKey${Math.random().toString(36).slice(2,9)}${Date.now().toString(36)}.${name.replace(/\s+/g,'_')}_Store` }
function isOpen(o,c){ try{ const n=new Date(); const cur=n.getHours()*60+n.getMinutes(); const [oh,om]=o.split(':').map(Number); const [ch,cm]=c.split(':').map(Number); const O=oh*60+(om||0), C=ch*60+(cm||0); return O<C? cur>=O&&cur<C : cur>=O||cur<C }catch{ return true } }

async function uploadImage(buffer, phone){
  const fileName = `${phone}_${Date.now()}.jpg`
  const {error} = await supabase.storage.from('product-images').upload(fileName, buffer, {contentType:'image/jpeg', upsert:true})
  if(error) throw error
  const {data: pub} = supabase.storage.from('product-images').getPublicUrl(fileName)
  return pub.publicUrl
}

let lastQR=null
app.get('/',(_,res)=>res.send('Shoppas Bot ALIVE'))
app.get('/qr', async (_,res)=>{ if(!lastQR) return res.send('✅ Connected'); const img=await QRCode.toDataURL(lastQR); res.send(`<img src="${img}" width="300"/><h3>Scan Linked Devices</h3>`) })
app.listen(process.env.PORT||10000, ()=>console.log('Web running'))

async function startBot(){
  await loadAuth()
  const {state, saveCreds} = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({ auth: state, printQRInTerminal:false, browser:['Shoppas','Chrome','1.0'], markOnlineOnConnect:false })
  
  sock.ev.on('creds.update', async ()=>{ await saveCreds(); await saveAuth() })
  sock.ev.on('connection.update', u=>{
    if(u.qr){ lastQR=u.qr; console.log('QR at /qr') }
    if(u.connection==='close'){
      const code = u.lastDisconnect?.error?.output?.statusCode
      console.log('Closed:',code)
      if(code!==DisconnectReason.loggedOut) startBot()
    }
    if(u.connection==='open'){ console.log('BOT CONNECTED'); lastQR=null }
  })

  let userFlow={}

  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]
      if(!m?.message || m.key.fromMe) return
      const from=m.key.remoteJid

      // --- REAL PHONE FIX ---
      let phone = from.split('@')[0]
      try{
        const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(from)
        if(mapped) phone = mapped.split('@')[0]
      }catch{}
      if(m.key.participant){
        try{
          const mp = await sock.signalRepository?.lidMapping?.getPNForLID(m.key.participant)
          phone = (mp||m.key.participant).split('@')[0]
        }catch{ phone = m.key.participant.split('@')[0] }
      }
      const waLink = `https://wa.me/${phone}`
      console.log('MSG LID:',from,'=> REAL:',phone)

      let text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || ''
      text=text.trim()
      const hasImage=!!m.message.imageMessage
      const loc=m.message.locationMessage

      if(loc){
        userFlow[phone]={...(userFlow[phone]||{}), lat: loc.degreesLatitude, lng: loc.degreesLongitude}
        const {data: shop} = await supabase.from('shops').select('*').eq('phone', phone).maybeSingle()
        if(shop) await supabase.from('shops').update({lat: loc.degreesLatitude, lng: loc.degreesLongitude}).eq('phone', phone)
        await sock.sendMessage(from,{text:`📍 Location pinned!\n${shop?`Store ${shop.shop_name} now live`:'Location saved, now .Auth my store'}`})
        return
      }
      if(!text) return
      const lower=text.toLowerCase()

      if(userFlow[phone]?.step){
        const step=userFlow[phone].step
        if(step==='shop_name'){ userFlow[phone].tempAuth.shop_name=text; userFlow[phone].step='owner'; return sock.sendMessage(from,{text:`✅ Shop: ${text}\n\n2. Owner full name?`}) }
        if(step==='owner'){ userFlow[phone].tempAuth.owner=text; userFlow[phone].step='who_adds'; return sock.sendMessage(from,{text:`✅ Owner: ${text}\n\n3. Who adds stock? (You / Cashier)`}) }
        if(step==='who_adds'){
          const shop_name=userFlow[phone].tempAuth.shop_name
          const key=genKey(shop_name)
          const newShop={ phone, shop_name, owner: userFlow[phone].tempAuth.owner, who_adds: text, wa_link: waLink, auth_key: key, lat: userFlow[phone].lat||null, lng: userFlow[phone].lng||null, open_time:'08:00', close_time:'17:00', created_at: Date.now() }
          await supabase.from('shops').upsert(newShop, {onConflict:'phone'})
          userFlow[phone]={...userFlow[phone], step:null, tempAuth:null}
          return sock.sendMessage(from,{text:`🎉 *STORE AUTHENTICATED*\n\n*${shop_name}*\nOwner: ${newShop.owner}\n🔗 ${waLink}\n\n🔑 KEY:\n\`${key}\`\n\nNow send PIN + ADD product with PHOTO`})
        }
      }

      if(lower==='.auth my store' || lower==='auth my store'){ userFlow[phone]={step:'shop_name', tempAuth:{}, lat: userFlow[phone]?.lat}; return sock.sendMessage(from,{text:`🔐 Shoppas Auth\n\n1/3: Shop name?\nEx: Tinashe's Store`}) }
      if(lower==='my shop'){ const {data: s}=await supabase.from('shops').select('*').eq('phone', phone).maybeSingle(); if(!s) return sock.sendMessage(from,{text:'No shop. Do .Auth my store'}); return sock.sendMessage(from,{text:`*${s.shop_name}*\nOwner: ${s.owner}\n${s.wa_link}\nKey: ${s.auth_key}\n${s.lat?'📍 pinned':'📍 send location'}\nStatus: ${isOpen(s.open_time,s.close_time)?'OPEN ✅':'CLOSED ❌'}`}) }
      if(lower==='my stock'){ const {data: list}=await supabase.from('stocks').select('*').eq('phone', phone).limit(20); if(!list?.length) return sock.sendMessage(from,{text:'No stock yet'}); let msg='Your Stock:\n'; list.forEach((s,i)=>msg+=`${i+1}. ${s.display} | ${s.price} | qty ${s.qty}\n`); return sock.sendMessage(from,{text:msg}) }

      if(lower.startsWith('add')){
        const lines=text.split('\n').map(l=>l.trim()).filter(l=>l)
        if(lines.length<4) return sock.sendMessage(from,{text:`❌ Format:\nADD\nProduct Name\n$Price\nqty number\n+ PHOTO required`})
        let keyProvided=null, ownerPhone=phone
        if(lines[0].toLowerCase()!=='add'){ keyProvided=lines[0].slice(3).trim(); const {data: shopByKey}=await supabase.from('shops').select('*').eq('auth_key', keyProvided).maybeSingle(); if(!shopByKey) return sock.sendMessage(from,{text:`❌ Invalid key.`}); ownerPhone=shopByKey.phone }
        const {data: shop}=await supabase.from('shops').select('*').eq('phone', ownerPhone).maybeSingle()
        if(!shop) return sock.sendMessage(from,{text:`❌ Not auth. Do .Auth my store`})
        const productName=lines[1]; const priceRaw=lines[2]; const qtyRaw=lines[3]
        if(!priceRaw.includes('$')||!qtyRaw.toLowerCase().includes('qty')) return sock.sendMessage(from,{text:`❌ Line3 must have $ and Line4 qty`})
        if(!hasImage) return sock.sendMessage(from,{text:`❌ Picture required. Send photo with caption ADD...`})
        try{
          const buf=await sock.downloadMediaMessage(m,'buffer',{}, {logger:undefined})
          const imageUrl=await uploadImage(buf, phone)
          await supabase.from('stocks').insert({ item: productName.toLowerCase(), display: productName, price: priceRaw, qty: qtyRaw.replace(/qty/i,'').trim(), phone: shop.phone, shop_name: shop.shop_name, wa_link: shop.wa_link, image_url: imageUrl, lat: shop.lat, lng: shop.lng, created_at: Date.now() })
          return sock.sendMessage(from,{text:`✅ Added to *${shop.shop_name}*\n${productName} | ${priceRaw} | ${qtyRaw}`})
        }catch(e){ return sock.sendMessage(from,{text:`❌ Upload failed: ${e.message}`}) }
      }

      if(text.length>=2){
        if(['hi','hello','hey','hii','heyy'].includes(lower)){ return sock.sendMessage(from,{text:`👋 Welcome to Shoppas!\n\n*BUY:* Type product name (exact)\n*SELL:* .Auth my store to create shop, then ADD with photo`}) }
        const search=lower
        const {data: exact}=await supabase.from('stocks').select('*').eq('item', search).limit(10)
        let found=exact||[]
        if(found.length===0){
          const {data: like}=await supabase.from('stocks').select('*').ilike('item', `%${search}%`).limit(10)
          found=(like||[]).filter(s=>{
            const numSearch=search.match(/\d+/)?.[0]; const numItem=s.item.match(/\d+/)?.[0]
            if(numSearch && numItem && numSearch!==numItem) return false
            return true
          })
        }
        if(found.length){
          for(let s of found){
            const caption=`*${s.shop_name}*\n\n📦 ${s.display.toUpperCase()}\n💰 ${s.price} | Qty: ${s.qty}\n📞 ${s.wa_link}`
            if(s.image_url) await sock.sendMessage(from,{image:{url: s.image_url}, caption})
            else await sock.sendMessage(from,{text:caption})
            if(s.lat) await sock.sendMessage(from,{location:{degreesLatitude:s.lat, degreesLongitude:s.lng}})
          }
        }
      }
    }catch(e){ console.log('HANDLER ERROR:', e.message, e.stack) }
  })
}
startBot()
