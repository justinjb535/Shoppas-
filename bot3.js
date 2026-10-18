import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import QRCode from 'qrcode'

const app = express()
app.use(express.json())

// --- DB ---
let stocks = []
let shops = {} // phone -> {name, open, close, ownerNumber}
let users = {}

try { stocks = JSON.parse(fs.readFileSync('./stocks.json')) } catch { stocks = [] }
try { shops = JSON.parse(fs.readFileSync('./shops.json')) } catch { shops = {} }
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads')

function saveStocks() { fs.writeFileSync('./stocks.json', JSON.stringify(stocks, null, 2)) }
function saveShops() { fs.writeFileSync('./shops.json', JSON.stringify(shops, null, 2)) }

function isShopOpen(open, close) {
    try {
        const now = new Date()
        const current = now.getHours() * 60 + now.getMinutes()
        const [oh, om] = open.split(':').map(Number)
        const [ch, cm] = close.split(':').map(Number)
        const o = oh*60 + (om||0)
        const c = ch*60 + (cm||0)
        if (o < c) return current >= o && current < c
        else return current >= o || current < c // overnight
    } catch { return true }
}

// --- WEB ---
let lastQR = null
app.get('/', (req,res)=>res.send('Shop Bot ALIVE'))
app.get('/qr', async (req,res)=>{
    if(!lastQR) return res.send('No QR, bot already connected or wait')
    const img = await QRCode.toDataURL(lastQR)
    res.send(`<h2>Scan: WhatsApp > Linked Devices</h2><img src="${img}" width="320"/>`)
})
app.listen(process.env.PORT || 10000)

// --- BOT ---
async function startBot(){
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    const sock = makeWASocket({ auth: state, printQRInTerminal:false })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async (u)=>{
        const {connection, lastDisconnect, qr}=u
        if(qr){ lastQR=qr; console.log('New QR at /qr') }
        if(connection==='close'){
            const should = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(should) startBot()
        } else if(connection==='open'){ console.log('BOT CONNECTED'); lastQR=null }
    })

    sock.ev.on('messages.upsert', async ({messages})=>{
        const m = messages[0]
        if(!m.message || m.key.fromMe) return
        const from = m.key.remoteJid
        const phone = from.split('@')[0]
        let text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || ''
        const loc = m.message.locationMessage
        if(loc){
            users[phone]={...(users[phone]||{}), lat: loc.degreesLatitude, lng: loc.degreesLongitude}
            await sock.sendMessage(from,{text:'📍 Location saved!'})
            return
        }
        if(!text) return
        const lower = text.trim().toLowerCase()

        // GREETINGS
        const greetings=['hi','hii','heyy','hey','hello','hesi','morning','good morning','sawubona','mhoro']
        if(greetings.includes(lower) || lower==='help' || lower==='menu' || greetings.some(g=>lower.startsWith(g+' '))){
            return sock.sendMessage(from,{text:`👋 Welcome! to shoppas

*BUY:* Type item name (sugar)

*SELL:*
1. Set shop first: 
SHOP Cement Depot 08:00 17:00

2. Then ADD:
ADD cement 10 bags $15 Harare
(Or send photo with same caption)

*Other:*
MY SHOP - view shop
MY STOCK
DEL cement
Send LOCATION 📍`})
        }

        // SHOP COMMAND - NEW
        if(lower.startsWith('shop ')){
            // SHOP Cement Depot 08:00 17:00
            const parts = text.slice(5).trim().split(' ')
            const close = parts.pop() // last is close time
            const open = parts.pop() // second last is open time
            const name = parts.join(' ')
            if(!name || !open || !close) return sock.sendMessage(from,{text:'Format: SHOP ShopName 08:00 17:00\nEx: SHOP Cement Depot 08:00 17:00'})
            shops[phone]={name, open, close, phone, ownerNumber: phone, updated: Date.now()}
            saveShops()
            return sock.sendMessage(from,{text:`✅ Shop saved:\n ${name}\n  ${open} - ${close}\nNow ADD your stock!`})
        }

        if(lower==='my shop'){
            const s = shops[phone]
            if(!s) return sock.sendMessage(from,{text:'No shop set. Use: SHOP Cement Depot 08:00 17:00'})
            const openNow = isShopOpen(s.open, s.close)
            return sock.sendMessage(from,{text:`*${s.name}*\n  ${s.open} - ${s.close}\nStatus: ${openNow?'OPEN ✅':'CLOSED ❌'}`})
        }

        if(lower==='my stock' || lower==='mystock'){
            const mine = stocks.filter(s=>s.phone===phone)
            if(!mine.length) return sock.sendMessage(from,{text:'No stock'})
            let msg=`Your Stock:\n`
            mine.forEach((s,i)=>msg+=`${i+1}. ${s.item} ${s.qty} ${s.price}\n`)
            return sock.sendMessage(from,{text:msg})
        }

        if(lower.startsWith('del ')){
            const item=lower.replace('del ','')
            const before=stocks.length
            stocks=stocks.filter(s=>!(s.phone===phone && s.item.includes(item)))
            saveStocks()
            return sock.sendMessage(from,{text: before===stocks.length ? 'Not found' : `Deleted ${item}`})
        }

        if(lower.startsWith('add ')){
            const parts=text.slice(4).trim().split(' ')
            if(parts.length<3) return sock.sendMessage(from,{text:'ADD item qty $price area'})
            const item=parts[0].toLowerCase()
            const qty=parts[1]+' '+(parts[2]||'')
            const price=parts.find(p=>p.includes('$'))||parts[3]||''
            const area=parts.slice(3).join(' ')||'Harare'
            let imagePath=null
            if(m.message.imageMessage){
                try{
                    const buf=await sock.downloadMediaMessage(m,'buffer',{}, {logger:undefined})
                    imagePath=`uploads/${Date.now()}.jpg`
                    fs.writeFileSync(imagePath, buf)
                }catch{}
            }
            const shop = shops[phone]
            stocks.push({item, display:parts[0], qty, price, area, phone, shopName: shop?.name || area, open: shop?.open, close: shop?.close, image:imagePath, time:Date.now(), sellerLoc: users[phone]||null})
            saveStocks()
            return sock.sendMessage(from,{text:`✅ Added ${item} ${imagePath?'img':''}`})
        }

        // SEARCH WITH SHOP HOURS
        const search=lower
        const found=stocks.filter(s=>s.item.includes(search)||search.includes(s.item)).slice(-10).reverse()
        if(found.length){
            for(let s of found){
                const isOpen = s.open && s.close ? isShopOpen(s.open, s.close) : true
                const status = s.open ? `${isOpen?'OPEN ✅':'CLOSED ❌'} ${s.open}-${s.close}` : 'Hours not set'
                const waLink=`https://wa.me/${s.phone}?text=Hi%20I%20want%20${s.item}`
              //  let caption=`*${s.shopName}*\n${status}\n\n ${s.display.toUpperCase()} - ${s.qty} - ${s.price}\n📍 ${s.area}\n🔗 ${waLink}`
                let caption=`*${s.shopName || s.area}*\n${status}\n\n ${(s.display || s.item || 'Item').toUpperCase()} - ${s.qty} - ${s.price}\n📍 ${s.area}\n🔗 ${waLink}`
                if(s.image && fs.existsSync(s.image)){
                    await sock.sendMessage(from,{image:fs.readFileSync(s.image), caption})
                } else {
                    await sock.sendMessage(from,{text:caption})
                }
                if(s.sellerLoc) await sock.sendMessage(from,{location:{degreesLatitude:s.sellerLoc.lat, degreesLongitude:s.sellerLoc.lng}})
            }
        } else {
            await sock.sendMessage(from,{text:`No stock for "${text}" yet.`})
        }
    })
}
startBot()
