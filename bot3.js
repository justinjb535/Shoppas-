import dotenv from 'dotenv'
dotenv.config()
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import QRCode from 'qrcode'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(express.json())
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const SEVEN_DAYS = 7*24*60*60*1000
const NINETY_DAYS = 90*24*60*60*1000

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

async function uploadImage(buffer, phone){
  const fileName = `${phone}_${Date.now()}.jpg`
  const {error} = await supabase.storage.from('product-images').upload(fileName, buffer, {contentType:'image/jpeg', upsert:true})
  if(error) throw error
  const {data: pub} = supabase.storage.from('product-images').getPublicUrl(fileName)
  return pub.publicUrl
}

let lastQR=null
app.get('/',(_,res)=>res.send('Shoppas Bot ALIVE'))
app.get('/qr', async (_,res)=>{ if(!lastQR) return res.send('✅ Connected'); const img=await QRCode.toDataURL(lastQR); res.send(`<img src="${img}" width="300"/>`) })
app.listen(process.env.PORT||10000, ()=>console.log('Web running'))

async function cleanOld(){
  try{
    const cutoff = Date.now() - NINETY_DAYS
    const {data} = await supabase.from('stocks').select('id,created_at').limit(1000)
    const old = (data||[]).filter(r=>{
      const c = typeof r.created_at==='number' ? r.created_at : new Date(r.created_at).getTime()
      return c < cutoff
    })
    if(old.length){
      await supabase.from('stocks').delete().in('id', old.map(o=>o.id))
      console.log(`Deleted ${old.length} expired >90d stocks`)
    }
  }catch(e){console.log('clean err',e.message)}
}
setInterval(cleanOld, 24*60*60*1000)

async function startBot(){
  await loadAuth()
  const {state, saveCreds} = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({ auth: state, browser:['Shoppas','Chrome','1.0'], markOnlineOnConnect:false })
  sock.ev.on('creds.update', async ()=>{ await saveCreds(); await saveAuth() })
  sock.ev.on('connection.update', u=>{
    if(u.qr){ lastQR=u.qr }
    if(u.connection==='close' && u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut) startBot()
    if(u.connection==='open'){ console.log('BOT CONNECTED'); lastQR=null; cleanOld() }
  })

  let userFlow={}, searchCount={}

  sock.ev.on('messages.upsert', async ({messages})=>{
    try{
      const m=messages[0]
      if(!m?.message || m.key.fromMe) return
      const from=m.key.remoteJid
      let phone = from.split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
      try{ 
        const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(from)
        if(mapped) phone = mapped.split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
      }catch{}
      if(m.key.participant){
        try{ 
          const mp = await sock.signalRepository?.lidMapping?.getPNForLID(m.key.participant)
          phone = (mp||m.key.participant).split('@')[0].split(':')[0].replace(/[^0-9]/g,'')
        }catch{ phone = m.key.participant.split('@')[0].split(':')[0].replace(/[^0-9]/g,'') }
      }

      let text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || ''
      text=text.trim()
      const hasImage=!!m.message.imageMessage
      const loc=m.message.locationMessage
      const lower=text.toLowerCase()

      if(loc){
        userFlow[phone]={...(userFlow[phone]||{}), lat: loc.degreesLatitude, lng: loc.degreesLongitude}
        const {data: shop} = await supabase.from('shops').select('*').eq('phone', phone).maybeSingle()
        if(shop) await supabase.from('shops').update({lat: loc.degreesLatitude, lng: loc.degreesLongitude}).eq('phone', phone)
        await sock.sendMessage(from,{text:`📍 Pinned! ${shop?shop.shop_name+' live':'Now .Auth my store'}`})
        return
      }
      if(!text) return

      if(userFlow[phone]?.step){
        const step=userFlow[phone].step
        if(step==='shop_name'){ userFlow[phone].tempAuth.shop_name=text; userFlow[phone].step='owner'; return sock.sendMessage(from,{text:`✅ Shop: ${text}\n\n2. Owner full name?`}) }
        if(step==='owner'){ userFlow[phone].tempAuth.owner=text; userFlow[phone].step='who_adds'; return sock.sendMessage(from,{text:`✅ Owner: ${text}\n\n3. Who adds stock? (You / Cashier)`}) }
        if(step==='who_adds'){
          const key=genKey(userFlow[phone].tempAuth.shop_name)
          const newShop={ phone, shop_name:userFlow[phone].tempAuth.shop_name, owner:userFlow[phone].tempAuth.owner, who_adds:text, wa_link:`https://wa.me/${phone}`, auth_key:key, lat:userFlow[phone]?.lat||null, lng:userFlow[phone]?.lng||null, open_time:'08:00', close_time:'17:00', created_at: Date.now() }
          await supabase.from('shops').upsert(newShop, {onConflict:'phone'})
          userFlow[phone]={...userFlow[phone], step:null, tempAuth:null}
          return sock.sendMessage(from,{text:`🎉 *AUTHENTICATED*\n*${newShop.shop_name}*\nKey: \`${key}\`\n\nNow pin location + ADD with photo\n\nType .manual for rules`})
        }
      }

      if(lower==='.auth my store' || lower==='auth my store'){ userFlow[phone]={step:'shop_name', tempAuth:{}, lat:userFlow[phone]?.lat}; return sock.sendMessage(from,{text:`🔐 Shoppas Auth\n1/3 Shop name?`}) }

      if(lower==='.manual' || lower==='manual'){
        const {data: shop}=await supabase.from('shops').select('*').eq('phone', phone).maybeSingle()
        const {data: stocks}=await supabase.from('stocks').select('*').eq('phone', phone).order('created_at',{ascending:false}).limit(20)
        let stockMsg='No stock yet'
        if(stocks?.length){
          stockMsg=stocks.map((s,i)=>{
            const c = typeof s.created_at==='number' ? s.created_at : new Date(s.created_at).getTime()
            const left=SEVEN_DAYS-(Date.now()-c)
            const daysLeft=Math.floor(left/(24*60*60*1000))
            let status= daysLeft>=0? `✅ Active ${daysLeft}d left` : `❌ EXPIRED ${Math.abs(daysLeft)}d ago`
            return `${i+1}. ${s.display} | ${s.price} | ${status}`
          }).join('\n')
        }
        return sock.sendMessage(from,{text:`📖 *SHOppAS MANUAL - How We Work*\n\n*FOR SHOP OWNERS:*\n1. Stock lives 7 DAYS only. After 7 days, it is HIDDEN from buyers (not deleted) to keep searches accurate.\n2. You MUST RENEW before buyers see it again.\n   • RENEW -> renews ALL your expired stock\n   • RENEW handbag -> renews that product only\n3. After 90 DAYS without renewal, we DELETE it permanently.\n4. To DELETE: DELETE handbag or DELETE 1\n\n*WHY?*\nWe force daily accuracy. No selling what you sold last week.\n\n*YOUR SHOP:*\n${shop? `${shop.shop_name}\nOwner: ${shop.owner}\nKey: ${shop.auth_key}` : 'Not authenticated yet'}\n\n*YOUR STOCK:*\n${stockMsg}\n\nCommands: my shop | my stock | RENEW | DELETE | ADD\n`})
      }

      if(lower==='my shop'){ const {data:s}=await supabase.from('shops').select('*').eq('phone', phone).maybeSingle(); if(!s) return sock.sendMessage(from,{text:'No shop. .Auth my store'}); return sock.sendMessage(from,{text:`*${s.shop_name}*\nKey: ${s.auth_key}\n${s.lat?'📍 pinned':'📍 send location'}`}) }

      if(lower==='my stock'){
        const {data:list}=await supabase.from('stocks').select('*').eq('phone', phone).order('created_at',{ascending:false}).limit(30)
        if(!list?.length) return sock.sendMessage(from,{text:'No stock'})
        let msg=`Your Stock (${list.length}):\n`; list.forEach((s,i)=>{
          const c = typeof s.created_at==='number' ? s.created_at : new Date(s.created_at).getTime()
          const left=Math.floor((SEVEN_DAYS-(Date.now()-c))/(24*60*60*1000))
          msg+=`${i+1}. ${s.display} | ${s.price} | ${left>=0? left+'d left':'EXPIRED'}\n`
        }); msg+=`\nRENEW or DELETE handbag`; return sock.sendMessage(from,{text:msg})
      }

      if(lower.startsWith('delete')){
        const query=text.slice(6).trim()
        if(!query) return sock.sendMessage(from,{text:'Use: DELETE handbag or DELETE 1'})
        let toDel=[]
        if(!isNaN(query)){
          const idx=parseInt(query)-1
          const {data:list}=await supabase.from('stocks').select('*').eq('phone', phone).order('created_at',{ascending:false}).limit(30)
          if(list && list[idx]) toDel=[list[idx]]
        }else{
          const {data:list}=await supabase.from('stocks').select('*').eq('phone', phone).ilike('item', `%${query}%`)
          toDel=list||[]
        }
        if(!toDel.length) return sock.sendMessage(from,{text:`❌ Nothing found for "${query}"`})
        for(let s of toDel) await supabase.from('stocks').delete().eq('id', s.id)
        return sock.sendMessage(from,{text:`🗑️ Deleted ${toDel.length} item(s): ${toDel.map(s=>s.display).join(', ')}`})
      }

      if(lower.startsWith('renew')){
        const query=text.slice(5).trim()
        const now=Date.now()
        if(!query){
          const {data:list}=await supabase.from('stocks').select('*').eq('phone', phone)
          if(!list?.length) return sock.sendMessage(from,{text:'No stock to renew'})
          await supabase.from('stocks').update({created_at: now}).eq('phone', phone)
          return sock.sendMessage(from,{text:`♻️ Renewed ALL (${list.length}) stocks for 7 more days!`})
        }else{
          const {data:list}=await supabase.from('stocks').select('*').eq('phone', phone).ilike('item', `%${query}%`)
          if(!list?.length) return sock.sendMessage(from,{text:`❌ No stock matching "${query}"`})
          await supabase.from('stocks').update({created_at: now}).ilike('item', `%${query}%`).eq('phone', phone)
          return sock.sendMessage(from,{text:`♻️ Renewed ${list.length} item(s): ${list.map(s=>s.display).join(', ')} for 7 days`})
        }
      }

      if(lower.startsWith('add')){
        const lines=text.split('\n').map(l=>l.trim()).filter(l=>l)
        if(lines.length<4) return sock.sendMessage(from,{text:`❌ Format:\nADD\nProduct Name\n$Price\nqty number\n+ PHOTO`})
        const {data: shop}=await supabase.from('shops').select('*').eq('phone', phone).maybeSingle()
        if(!shop) return sock.sendMessage(from,{text:`❌ Not auth. .Auth my store`})
        const productName=lines[1]; const priceRaw=lines[2]; const qtyRaw=lines[3]
        if(!priceRaw.includes('$')||!qtyRaw.toLowerCase().includes('qty')) return sock.sendMessage(from,{text:`❌ Line3 $ and Line4 qty required`})
        if(!hasImage) return sock.sendMessage(from,{text:`❌ Photo required`})
        try{
          const buf=await downloadMediaMessage(m,'buffer',{}, { logger:undefined, reuploadRequest: sock.updateMediaMessage })
          const imageUrl=await uploadImage(buf, phone)
          // CLEAN price - only $number
          const cleanPrice = '$' + (priceRaw.match(/\d+/)?.[0] || '0')
          const cleanQty = qtyRaw.replace(/qty/i,'').trim().match(/\d+/)?.[0] || '1'
          await supabase.from('stocks').insert({ item: productName.toLowerCase(), display: productName, price: cleanPrice, qty: cleanQty, phone: shop.phone, shop_name: shop.shop_name, wa_link: shop.wa_link, image_url: imageUrl, lat: shop.lat, lng: shop.lng, created_at: Date.now() })
          return sock.sendMessage(from,{text:`✅ Added *${productName}* | ${cleanPrice}\nExpires in 7 days. Use RENEW to extend.\nType .manual for info`})
        }catch(e){ return sock.sendMessage(from,{text:`❌ Upload failed: ${e.message}`}) }
      }

      if(text.length>=2){
        if(['hi','hello','hey','hii','heyy'].includes(lower)){
          return sock.sendMessage(from,{text:`👋 Welcome to Shoppas!\n\nSearch like:\n• playstation 5\n• playstation 5 under $450\n• handbag near me\n• iphone under $500 near me\n\nSELL: .Auth my store`})
        }

        let raw = lower
        let maxPrice = null
        let wantNear = raw.includes('near me') || raw.includes('nearby')

        const pricePattern = /(?:under|below|less than|<|budget)\s*\$?\s*(\d+)|\$\s*(\d+)/i
        const priceMatch = raw.match(pricePattern)
        if(priceMatch){
          maxPrice = parseInt(priceMatch[1] || priceMatch[2])
        }

        raw = raw.replace(/(?:under|below|less than|<|budget)\s*\$?\s*\d+\s*(?:dollars|usd|max)?|\$\s*\d+\s*(?:max|dollars|usd)?/gi,'').trim()
        raw = raw.replace(/near me|nearby/gi,'').trim()
        const search = raw.replace(/\s+/g,' ').trim()

        console.log(`PARSED: "${lower}" -> product="${search}" max=$${maxPrice} near=${wantNear}`)

        if(search.length<2) return

        searchCount[phone]=(searchCount[phone]||0)+1

        // FIXED: No gte in supabase, filter in JS to support both bigint and timestamp
        const {data: like}=await supabase.from('stocks').select('*').ilike('item', `%${search}%`).limit(40)
        let found=(like||[]).filter(s=>{
          const c = typeof s.created_at==='number' ? s.created_at : new Date(s.created_at).getTime()
          const age = Date.now() - c
          if(age > SEVEN_DAYS) return false
          const numSearch=search.match(/\d+/)?.[0]; const numItem=s.item.match(/\d+/)?.[0]
          if(numSearch && numItem && numSearch!==numItem) return false
          return true
        })

        // If no like, try exact
        if(found.length===0){
          const {data: exact}=await supabase.from('stocks').select('*').eq('item', search).limit(20)
          found=(exact||[]).filter(s=>{
            const c = typeof s.created_at==='number' ? s.created_at : new Date(s.created_at).getTime()
            return (Date.now()-c) <= SEVEN_DAYS
          })
        }

        // FIXED PRICE FILTER: take first number only, not all digits
        if(maxPrice && found.length){
          found = found.filter(s=>{
            const m = String(s.price||'').match(/(\d+)/)
            const p = m ? parseInt(m[1]) : 999999
            return p <= maxPrice
          })
        }

        if(wantNear && found.length && userFlow[phone]?.lat){
          const {lat:ulat, lng:ulng} = userFlow[phone]
          const dist = (la1,lo1,la2,lo2)=>{
            const R=6371; const dLat=(la2-la1)*Math.PI/180; const dLon=(lo2-lo1)*Math.PI/180;
            const a=Math.sin(dLat/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLon/2)**2
            return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
          }
          found = found.sort((a,b)=>{
            if(!a.lat||!b.lat) return 0
            return dist(ulat,ulng,a.lat,a.lng) - dist(ulat,ulng,b.lat,b.lng)
          })
        }

        if(found.length){
          const toShow = wantNear ? found.slice(0,10) : found.slice(0,15)
          for(let s of toShow){
            const caption=`*${s.shop_name}*\n📦 ${s.display.toUpperCase()}\n💰 ${s.price} ${maxPrice?`(≤$${maxPrice})`:''} | Qty: ${s.qty}\n📞 ${s.wa_link}\n${wantNear && s.lat? '📍 CLOSEST FIRST':''}`
            if(s.image_url) await sock.sendMessage(from,{image:{url:s.image_url}, caption})
            else await sock.sendMessage(from,{text:caption})
            if(s.lat) await sock.sendMessage(from,{location:{degreesLatitude:s.lat, degreesLongitude:s.lng}})
          }
          if(wantNear && !userFlow[phone]?.lat){
            await sock.sendMessage(from,{text:`📍 Send your location to sort by nearest! Tap 📎 > Location`})
          }
        }else{
          let reply=`❌ *${text}* not available${maxPrice?` under $${maxPrice}`:''}\n\nWe hide expired (>7d) stock.\nTry: "${search}"`
          if(searchCount[phone]%5===0) reply+=`\n\n🔥 Share: wa.me/263775735964`
          await sock.sendMessage(from,{text:reply})
        }
      }
    }catch(e){ console.log('HANDLER ERROR:', e.message, e.stack) }
  })
}
startBot()
