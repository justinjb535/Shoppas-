import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import express from 'express'
import fs from 'fs'
import QRCode from 'qrcode'
const app = express()
app.use(express.json())

// --- SIMPLE DB ---
let stocks = []
let users = {} // phone -> {name, location}
try { stocks = JSON.parse(fs.readFileSync('./stocks.json')) } catch { stocks = [] }

function save() { fs.writeFileSync('./stocks.json', JSON.stringify(stocks, null, 2)) }

// --- WEB SERVER FOR RENDER + CRON ---
let lastQR = null
app.get('/', (req, res) => res.send('General Shop Bot ALIVE - ping for cron OK'))
app.get('/qr', async (req, res) => {
  if (!lastQR) return res.send('No QR yet, check logs or wait for restart')
  const qrImg = await QRCode.toDataURL(lastQR)
  res.send(`<h2>Scan this with WhatsApp > Linked Devices</h2><img src="${qrImg}" width="300"/><p>Refresh if expired</p>`)
})
app.listen(process.env.PORT || 10000, () => console.log('Server for Render running'))

// --- WHATSAPP BOT ---
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({ auth: state, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      lastQR = qr
      console.log('NEW QR - open /qr link to scan')
      try { console.log(await QRCode.toString(qr, {type:'terminal', small:true})) } catch {}
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('BOT CONNECTED on your personal number!')
      lastQR = null
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0]
    if (!m.message || m.key.fromMe) return
    const from = m.key.remoteJid
    const phone = from.split('@')[0]
    const text = m.message.conversation || m.message.extendedTextMessage?.text || ''
    const loc = m.message.locationMessage

    // Save location pin
    if (loc) {
      users[phone] = { ...(users[phone]||{}), lat: loc.degreesLatitude, lng: loc.degreesLongitude }
      await sock.sendMessage(from, { text: `📍 Location saved! Now when you ADD stock, buyers will get your pin.\n\nNow add: ADD item qty price area\nExample: ADD cement 10 bags $15 Harare` })
      return
    }

    if (!text) return
    const lower = text.trim().toLowerCase()

    // HELP
    if (lower === 'hi' || lower === 'menu' || lower === 'help') {
      return sock.sendMessage(from, { text: `🛒 *GENERAL SHOP BOT*\nEverything Sellable\n\n*TO SELL:*\nADD item qty price location\nEx: ADD cement 10 bags $15 Harare\n\nThen SEND your location pin 📍\n\n*TO BUY:*\nJust type what you want\nEx: cement, tiles, bike\n\n*Commands:*\nMY STOCK - see your items\nDEL cement - delete item\nHELP - this menu` })
    }

    // MY STOCK
    if (lower === 'my stock' || lower === 'mystock') {
      const mine = stocks.filter(s => s.phone === phone)
      if (!mine.length) return sock.sendMessage(from, { text: 'You have no stock. Use: ADD cement 10 $15' })
      let msg = `📦 Your Stock:\n\n`
      mine.forEach((s,i) => msg += `${i+1}. ${s.item} - ${s.qty} - ${s.price} - ${s.area}\n`)
      return sock.sendMessage(from, { text: msg })
    }

    // DELETE
    if (lower.startsWith('del ')) {
      const item = lower.replace('del ', '')
      const before = stocks.length
      stocks = stocks.filter(s => !(s.phone === phone && s.item.includes(item)))
      save()
      return sock.sendMessage(from, { text: before === stocks.length ? 'Not found' : `Deleted ${item}` })
    }

    // ADD STOCK: ADD cement 10 bags $15 Harare
    if (lower.startsWith('add ')) {
      const parts = text.slice(4).trim().split(' ')
      if (parts.length < 3) return sock.sendMessage(from, { text: 'Format: ADD item qty price location\nEx: ADD cement 10 bags $15 Harare' })
      const item = parts[0].toLowerCase()
      const qty = parts[1] + ' ' + (parts[2] || '')
      const price = parts.find(p => p.includes('$')) || parts[3] || ''
      const area = parts.slice(3).join(' ') || 'Harare'
      
      stocks.push({ item, qty, price, area, phone, time: Date.now(), sellerLoc: users[phone] || null })
      save()
      return sock.sendMessage(from, { text: `✅ Added: ${item} - ${qty} - ${price} in ${area}\n\nSend your LOCATION PIN 📍 so buyers can find you. Buyers will get your pin when they search "${item}"` })
    }

    // SEARCH
    const search = lower
    const found = stocks.filter(s => s.item.includes(search) || search.includes(s.item)).slice(-10).reverse()
    if (found.length) {
      let msg = `🔍 Found ${found.length} for "${search}":\n\n`
      for (let i=0; i<found.length; i++) {
        const s = found[i]
        msg += `${i+1}. *${s.item.toUpperCase()}* - ${s.qty} - ${s.price}\n📍 ${s.area} - 0${s.phone.slice(-9)}\n\n`
      }
      await sock.sendMessage(from, { text: msg })
      // Send location pin of first seller if available
      const withLoc = found.find(f => f.sellerLoc)
      if (withLoc?.sellerLoc) {
        await sock.sendMessage(from, { location: { degreesLatitude: withLoc.sellerLoc.lat, degreesLongitude: withLoc.sellerLoc.lng } })
        await sock.sendMessage(from, { text: `📍 Location of seller for ${withLoc.item} - contact: 0${withLoc.phone.slice(-9)}` })
      }
    } else {
      await sock.sendMessage(from, { text: `No stock for "${search}" yet.\n\nIf you have it, ADD it:\nADD ${search} 10 $15 Harare` })
    }
  })
}
startBot()
