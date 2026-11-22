// Nditori - WhatsApp Ride Bot - FINAL - Supabase + Bidding + Safety
// Run: npm install && node index.js
import 'dotenv/config';
//import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

// ============ CONFIG ============
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '263779596966';
const PAIRING_NUMBER = process.env.PAIRING_NUMBER || '';
const BOT_NAME = 'Nditore';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Keep Render alive
const app = express();
let latestQR = null;
let connectionStatus = 'starting...';

app.get('/', (req, res) => res.send('Nditore is alive ✅'));

app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Nditore QR</h2>
        <p>Status: ${connectionStatus}</p>
        <p>No QR yet - bot is already paired, or still starting.</p>
        <p>Refresh in 5 seconds...</p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
      </body></html>
    `);
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:20px">
        <h2>Scan this with WhatsApp</h2>
        <p>Status: ${connectionStatus}</p>
        <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px" />
        <p>WhatsApp > Settings > Linked Devices > Link a Device > Scan this</p>
        <p>QR refreshes every 20 seconds</p>
        <script>setTimeout(()=>location.reload(), 20000)</script>
      </body></html>
    `);
  } catch (e) {
    res.send('QR error: ' + e.message);
  }
});

app.get('/status', (req, res) => res.json({ status: connectionStatus, hasQR: !!latestQR }));

app.listen(3000, () => console.log('Web server on 3000'));

// =============================================
async function useSupabaseAuthState() {
  // Load
  const { data } = await supabase.from('whatsapp_auth').select('*');
  let creds = null;
  let keys = {};
  if (data) {
    for (const row of data) {
      if (row.id === 'creds') creds = row.data;
      else keys[row.id] = row.data;
    }
  }
  const state = {
    creds: creds || {},
    keys: {
      get: (type, ids) => {
        const out = {};
        for (const id of ids) if (keys[`${type}-${id}`]) out[id] = keys[`${type}-${id}`];
        return out;
      },
      set: (data) => {
        for (const type in data) for (const id in data[type]) keys[`${type}-${id}`] = data[type][id];
      }
    }
  };
  const saveCreds = async () => {
    const rows = [{ id: 'creds', data: state.creds }];
    for (const id in keys) rows.push({ id, data: keys[id] });
    await supabase.from('whatsapp_auth').upsert(rows);
  };
  return { state, saveCreds };
}

function getRefCode(phone) { return phone.slice(-4); }
function normalize(phone) {
  phone = phone.trim();
  if (phone.startsWith('0')) return '263' + phone.slice(1);
  if (phone.startsWith('+263')) return phone.slice(1);
  return phone;
}

// ---- Supabase Helpers ----
async function getDriver(phone) {
  const { data } = await supabase.from('drivers').select('*').eq('phone', phone).single();
  return data;
}
async function getRider(phone) {
  const { data } = await supabase.from('riders').select('*').eq('phone', phone).single();
  return data;
}
async function getCredits(phone) {
  const d = await getDriver(phone);
  if (d) return d.credits || 0;
  const r = await getRider(phone);
  return r?.credits || 0;
}
async function addCredits(phone, amount) {
  const d = await getDriver(phone);
  if (d) {
    await supabase.from('drivers').update({ credits: (d.credits || 0) + amount }).eq('phone', phone);
  } else {
    const r = await getRider(phone);
    if (r) await supabase.from('riders').update({ credits: (r.credits || 0) + amount }).eq('phone', phone);
    else await supabase.from('riders').insert({ phone, credits: amount });
  }
}
async function setCredits(phone, amount) {
  const d = await getDriver(phone);
  if (d) await supabase.from('drivers').update({ credits: amount }).eq('phone', phone);
  else {
    const r = await getRider(phone);
    if (r) await supabase.from('riders').update({ credits: amount }).eq('phone', phone);
    else await supabase.from('riders').insert({ phone, credits: amount });
  }
}

// Send bids list to rider - sorted cheapest first
async function sendBidsToRider(sock, ride) {
  const { data: allBids } = await supabase.from('bids').select('*').eq('ride_id', ride.id).order('bid_price', { ascending: true });
  if (!allBids || allBids.length === 0) return;
  let out = `${BOT_NAME}: ${allBids.length} driver(s) bid for your ride! 🚕\n${ride.ride_text}\n\n`;
  for (let i = 0; i < allBids.length; i++) {
    const b = allBids[i];
    const driver = await getDriver(b.driver_phone);
    out += `${i + 1}. ${driver?.info || b.driver_phone} - $${b.bid_price.toFixed(2)}\n`;
  }
  out += `\nReply: PICK 1 or PICK 2 or PICK 3\nCheapest is not always best, check car + plate.`;
  await sock.sendMessage(ride.rider + '@s.whatsapp.net', { text: out });
}

// Track timers so we don't send bids twice for same ride
const bidTimers = new Map();
async function start() {
  //const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { state, saveCreds } = await useSupabaseAuthState();
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: (jid) => {
      if (jid.endsWith('@broadcast')) return true;
      if (jid.endsWith('@g.us')) return true;
      if (jid === 'status@broadcast') return true;
      return false;
    },
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered && PAIRING_NUMBER) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        console.log(`PAIRING CODE FOR ${PAIRING_NUMBER}: ${code}`);
      } catch (e) { console.log('Pairing error', e.message); }
    }, 3000);
  }

    sock.ev.on('connection.update', (update) => {
  const { connection, lastDisconnect, qr } = update;
  if (qr) {
    latestQR = qr;
    connectionStatus = 'waiting for scan - QR ready';
    qrcode.generate(qr, { small: true });
    console.log('New QR generated - open /qr to scan it');
  }
  if (connection === 'open') {
    latestQR = null;
    connectionStatus = 'ONLINE ✅';
    console.log('Nditore is ONLINE ✅');
  }
  if (connection === 'close') {
    connectionStatus = 'disconnected - reconnecting...';
    const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
    console.log('Disconnected. Reconnect?', shouldReconnect);
    if (shouldReconnect) start();
  }
});

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    if (msg.key.remoteJid.endsWith('@g.us') || msg.key.remoteJid === 'status@broadcast') return;

    const from = msg.key.remoteJid;
    const phone = from.split('@')[0];
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '').trim();

    if (msg.message.contactMessage) {
      await sock.sendMessage(from, { text: `Thanks for sharing ${BOT_NAME}! 🙏 Your referral code is ${getRefCode(phone)}. Tell your friend to type REF ${getRefCode(phone)} when they text me, and you both get 5% OFF.` });
      return;
    }
    if (!text) return;
    const upper = text.toUpperCase();
    console.log(`From ${phone}: ${text}`);
    const send = async (txt) => await sock.sendMessage(from, { text: txt });

    // ============ ADMIN ============
    if (upper.startsWith('GIVE ')) {
      if (phone !== ADMIN_NUMBER) { await send(`Ha 😂 nice try. Only boss can give credits.`); return; }
      const parts = text.split(' ');
      let target = normalize(parts[1] || '');
      let amount = parseInt(parts[2] || '0');
      if (!target || !amount) { await send(`Use like this: GIVE 0712345678 10`); return; }
      await addCredits(target, amount);
      await send(`Done ✅ ${target} now has ${await getCredits(target)} credits.`);
      return;
    }

    if (upper.startsWith('APPROVE ')) {
      if (phone !== ADMIN_NUMBER) { await send(`Only boss can approve.`); return; }
      let target = normalize(text.split(' ')[1] || '');
      if (!target) { await send(`Use: APPROVE 0712345678`); return; }
      const existing = await getDriver(target);
      if (existing) await supabase.from('drivers').update({ approved: true }).eq('phone', target);
      else await supabase.from('drivers').insert({ phone: target, info: 'Unknown - approved by boss', approved: true, available: false, credits: 0 });
      await send(`Done ✅ ${target} is APPROVED.`);
      try { await sock.sendMessage(target + '@s.whatsapp.net', { text: `${BOT_NAME}: You are APPROVED! ✅\nWelcome driver! Type:\nAVAILABLE Epworth\nto start getting rides.` }); } catch (e) {}
      return;
    }

    if (upper.startsWith('REJECT ')) {
      if (phone !== ADMIN_NUMBER) { await send(`Only boss can reject.`); return; }
      let target = normalize(text.split(' ')[1] || '');
      if (!target) { await send(`Use: REJECT 0712345678`); return; }
      await supabase.from('drivers').update({ approved: false, available: false }).eq('phone', target);
      await send(`Done. ${target} REJECTED / BLOCKED.`);
      try { await sock.sendMessage(target + '@s.whatsapp.net', { text: `${BOT_NAME}: Sorry, your application was not approved. Contact boss.` }); } catch (e) {}
      return;
    }

    if (upper === 'LIST') {
      if (phone !== ADMIN_NUMBER) { await send(`Only boss can see list.`); return; }
      const { data: all } = await supabase.from('drivers').select('*');
      if (!all || all.length === 0) { await send(`No drivers yet.`); return; }
      let out = `${BOT_NAME} Drivers:\n\n`;
      for (let d of all) out += `${d.phone} - ${d.info || ''} - Approved: ${d.approved ? 'YES ✅' : 'NO ❌'} - Available: ${d.available ? d.area : 'OFF'} - Credits: ${d.credits || 0}\n\n`;
      out += `APPROVE 071... | REJECT 071... | GIVE 071... 10`;
      await send(out);
      return;
    }

    // ============ USER ============
    if (upper === 'CREDITS' || upper === 'BALANCE') {
      await send(`Mhoro! You have ${await getCredits(phone)} credits.\nYour referral code is: ${getRefCode(phone)}\nShare ${BOT_NAME} to a friend, tell them to type: REF ${getRefCode(phone)} and you both get 5% OFF next ride.`);
      return;
    }

    if (['HI', 'HELLO', 'MHORO', 'START'].includes(upper)) {
      await send(`Mhoro, ndini ${BOT_NAME} 😊\n\nUnoda kuti ndikutore kupi?\n1 = I am a DRIVER\n2 = I need a RIDE\nType 1 or 2`);
      return;
    }

    if (upper === '1') {
      const existing = await getDriver(phone);
      if (!existing) await supabase.from('drivers').insert({ phone, approved: false, available: false, credits: 0 });
      await send(`Okay driver! 🚗\nTo register, send:\nREGISTER Tendai Moyo | Honda Fit Silver | ABC123\nExample: REGISTER Tendai Moyo | Honda Fit Silver | ABC123\n\nThen send your ID + selfie to boss for approval.`);
      return;
    }

    if (upper.startsWith('REGISTER ')) {
      const info = text.slice(9).trim();
      const existing = await getDriver(phone);
      if (existing) await supabase.from('drivers').update({ info }).eq('phone', phone);
      else await supabase.from('drivers').insert({ phone, info, approved: false, available: false, credits: 0 });
      await send(`Thanks! I saved: ${info}\nNow send your ID + selfie + license to boss for approval. Once approved, type: AVAILABLE Epworth`);
      return;
    }

    if (upper.startsWith('AVAILABLE ')) {
      const area = text.slice(10).trim();
      const driver = await getDriver(phone);
      if (!driver) { await send(`You are not registered. Type 1 first.`); return; }
      if (!driver.approved) { await send(`Sorry, not APPROVED yet ❌\nBoss is still checking your ID. Wait for "You are APPROVED".`); return; }
      await supabase.from('drivers').update({ available: true, area, last_seen: Date.now() }).eq('phone', phone);
      await send(`Sharp! You are AVAILABLE in ${area}. Credits: ${await getCredits(phone)}\nWhen a ride comes, reply: BID 123456 $3.50`);
      return;
    }

    if (upper === 'OFFLINE' || upper === 'STOP') {
      await supabase.from('drivers').update({ available: false }).eq('phone', phone);
      await send(`Okay, you are OFFLINE. Type AVAILABLE Epworth when back.`);
      return;
    }

    if (upper === '2') {
      await send(`Okay, ${BOT_NAME} will take you! 🚕\nType your ride like this:\nRIDE Epworth to Braeside KFC $4\n\nNo location pin needed, just type where from and where to.`);
      return;
    }

    if (upper.startsWith('REF ')) {
      const refCode = text.split(' ')[1];
      const { data: allDrivers } = await supabase.from('drivers').select('phone');
      const { data: allRiders } = await supabase.from('riders').select('phone');
      let referrer = null;
      [...(allDrivers || []), ...(allRiders || [])].forEach(p => { if (getRefCode(p.phone) === refCode) referrer = p.phone; });
      if (referrer && referrer !== phone) {
        const rider = await getRider(phone);
        if (rider) await supabase.from('riders').update({ discount: 5, referred_by: referrer }).eq('phone', phone);
        else await supabase.from('riders').insert({ phone, discount: 5, referred_by: referrer, credits: 0 });
        const refRider = await getRider(referrer);
        if (refRider) await supabase.from('riders').update({ discount: 5 }).eq('phone', referrer);
        else await supabase.from('riders').insert({ phone: referrer, discount: 5, credits: 0 });
        await send(`Nice! You used REF ${refCode}. You get 5% OFF next ride. Your friend also gets 5% OFF. Now type: RIDE Epworth to Braeside KFC $4`);
        try { await sock.sendMessage(referrer + '@s.whatsapp.net', { text: `${BOT_NAME}: Someone used your code! You now have 5% OFF your next ride. Thanks for sharing 🙏` }); } catch (e) {}
      } else {
        await send(`That code is not valid. Just type: RIDE Epworth to Braeside KFC $4`);
      }
      return;
    }

    // ============ RIDE + BIDDING ============
    if (upper.startsWith('RIDE ')) {
      const rideText = text.slice(5);
      const priceMatch = rideText.match(/\$(\d+(\.\d+)?)/);
      let price = priceMatch ? parseFloat(priceMatch[1]) : 0;
      const rider = await getRider(phone);
      let hasDiscount = rider?.discount === 5;
      let finalPrice = price;
      if (hasDiscount && price > 0) {
        finalPrice = price * 0.95;
        await supabase.from('riders').update({ discount: 0 }).eq('phone', phone);
      }
      const fromArea = rideText.split(' ')[0];
      const { data: allDrivers } = await supabase.from('drivers').select('*').eq('available', true).eq('approved', true);
      const availableDrivers = (allDrivers || []).filter(d => d.area && d.area.toLowerCase().includes(fromArea.toLowerCase()));
      if (availableDrivers.length === 0) {
        await send(`Sorry, no driver in ${fromArea} right now. Try again in 10 mins.`);
        return;
      }
      const rideId = Date.now().toString().slice(-6);
      await supabase.from('rides').insert({ id: rideId, rider: phone, ride_text: rideText, price, final_price: finalPrice, has_discount: hasDiscount, status: 'waiting' });
      await send(`Sharp! Looking for driver in ${fromArea}... Ride ID: ${rideId}\n${rideText}\n${hasDiscount ? `You used 5% discount! Max price: $${finalPrice.toFixed(2)}` : `Your max price: $${price}`}\nDrivers are bidding now. Wait 2 mins, I'll send you their bids.`);
      for (let driver of availableDrivers) {
        try {
          await sock.sendMessage(driver.phone + '@s.whatsapp.net', {
            text: `${BOT_NAME}: New ride! 🚕\nRide ID: ${rideId}\n${rideText}\n${hasDiscount ? `Rider has 5% discount. Max price $${finalPrice.toFixed(2)}.` : `Rider max price: $${price}`}\n${hasDiscount ? `If you WIN this, you get 3 FREE credits! 🎁\n` : ``}Reply to bid:\nBID ${rideId} $3.50\nBid lower to win!`
          });
        } catch (e) {}
      }
      // Auto-send bids after 2 mins if not already sent by 3 bids
      bidTimers.set(rideId, setTimeout(async () => {
        const { data: r } = await supabase.from('rides').select('*').eq('id', rideId).single();
        if (r && r.status === 'waiting') {
          const { data: bids } = await supabase.from('bids').select('*').eq('ride_id', rideId);
          if (bids && bids.length > 0) await sendBidsToRider(sock, r);
          else await sock.sendMessage(r.rider + '@s.whatsapp.net', { text: `${BOT_NAME}: No driver bid for ride ${rideId} yet. Try again or increase your price.` });
        }
      }, 120000));
      return;
    }

    // Driver bids: BID 123456 $3.50
    if (upper.startsWith('BID ')) {
      const parts = text.split(' ');
      const rideId = parts[1];
      const bidPrice = parseFloat(parts[2]?.replace('$', '') || '0');
      if (!rideId || !bidPrice) { await send(`Use: BID 123456 $3.50`); return; }
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).eq('status', 'waiting').single();
      if (!ride) { await send(`That ride is gone or already picked.`); return; }
      if ((await getCredits(phone)) < 1 && !ride.has_discount) {
        await send(`You have 0 credits. Send $5 EcoCash to boss to get 10 rides. Text CREDITS to check.`); return;
      }
      await supabase.from('bids').upsert({ ride_id: rideId, driver_phone: phone, bid_price: bidPrice, created_at: Date.now() });
      await send(`Your bid $${bidPrice.toFixed(2)} for ride ${rideId} is in ✅ Waiting for rider to pick. Bid lower if you want to win!`);
      // If 3+ bids, send immediately, don't wait 2 mins
      const { data: allBids } = await supabase.from('bids').select('*').eq('ride_id', rideId);
      if (allBids.length >= 3) {
        if (bidTimers.has(rideId)) { clearTimeout(bidTimers.get(rideId)); bidTimers.delete(rideId); }
        await sendBidsToRider(sock, ride);
      }
      return;
    }

    // Rider picks: PICK 1, PICK 2, PICK 3
    if (upper.startsWith('PICK ')) {
      const pickNum = parseInt(text.split(' ')[1]);
      if (!pickNum) { await send(`Use: PICK 1 or PICK 2`); return; }
      const { data: rides } = await supabase.from('rides').select('*').eq('rider', phone).eq('status', 'waiting').order('id', { ascending: false }).limit(1);
      const ride = rides?.[0];
      if (!ride) { await send(`No active ride found. Type: RIDE Epworth to Braeside KFC $4`); return; }
      const { data: allBids } = await supabase.from('bids').select('*').eq('ride_id', ride.id).order('bid_price', { ascending: true });
      if (!allBids || !allBids[pickNum - 1]) { await send(`Invalid choice. Type PICK 1, PICK 2 or PICK 3`); return; }
      const chosenBid = allBids[pickNum - 1];
      const driverPhone = chosenBid.driver_phone;
      const driver = await getDriver(driverPhone);
      if (bidTimers.has(ride.id)) { clearTimeout(bidTimers.get(ride.id)); bidTimers.delete(ride.id); }
      await supabase.from('rides').update({ status: 'matched', driver: driverPhone }).eq('id', ride.id);
      if (ride.has_discount) await addCredits(driverPhone, 3);
      else await setCredits(driverPhone, (await getCredits(driverPhone)) - 1);

      // SAFETY CARD to rider
      await send(`Done! You picked driver #${pickNum} ✅\n\n🚗 DRIVER INFO - CHECK BEFORE YOU GET IN:\nName / Car / Plate: ${driver?.info || driverPhone}\nPhone: ${driverPhone}\nPrice you agreed: $${chosenBid.bid_price.toFixed(2)}\nTrip: ${ride.ride_text}\n\n⚠️ SAFETY: Check plate matches before you get in. Share this with a friend. Don't get in if plate is different.\n\nDriver will ask you where you are. Reply to me and I'll forward it.\nTo ask driver something, type: ASK ${ride.id} Your question`);
      // Notify winning driver
      try {
        await sock.sendMessage(driverPhone + '@s.whatsapp.net', { text: `${BOT_NAME}: You WON ride ${ride.id}! 🎉\nRider: ${ride.rider}\nTrip: ${ride.ride_text}\nYour winning bid: $${chosenBid.bid_price.toFixed(2)}\nCall rider now: ${ride.rider}\n\nTo ask rider something, type: ASK ${ride.id} What are you wearing?` });
      } catch (e) {}
      // Notify losing drivers
      for (let b of allBids) {
        if (b.driver_phone !== driverPhone) {
          try { await sock.sendMessage(b.driver_phone + '@s.whatsapp.net', { text: `${BOT_NAME}: Sorry, rider picked another driver for ride ${ride.id}. Don't worry, next ride is coming.` }); } catch (e) {}
        }
      }
      return;
    }

    // Driver asks rider: ASK 123456 What are you wearing? Which side are you on?
    if (upper.startsWith('ASK ')) {
      const parts = text.split(' ');
      const rideId = parts[1];
      const question = text.slice(4 + rideId.length + 1).trim();
      if (!rideId || !question) { await send(`Use: ASK 123456 What are you wearing?`); return; }
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();
      if (!ride) { await send(`Ride not found.`); return; }
      try {
        await sock.sendMessage(ride.rider + '@s.whatsapp.net', { text: `${BOT_NAME}: Driver asks:\n"${question}"\n\nReply: ANSWER ${rideId} Your answer here` });
        await send(`Sent to rider ✅ Waiting for answer...`);
      } catch (e) {}
      return;
    }

    // Rider answers: ANSWER 123456 I'm in red jacket, near KFC side
    if (upper.startsWith('ANSWER ')) {
      const parts = text.split(' ');
      const rideId = parts[1];
      const answer = text.slice(7 + rideId.length + 1).trim();
      if (!rideId || !answer) { await send(`Use: ANSWER 123456 I'm in red jacket`); return; }
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();
      if (!ride || !ride.driver) { await send(`Ride not found or driver not picked yet.`); return; }
     try {
        await sock.sendMessage(ride.driver + '@s.whatsapp.net', { text: `${BOT_NAME}: Rider answers:\n"${answer}"\n\nTrip: ${ride.ride_text}` });
        await send(`Sent to driver ✅`);
      } catch (e) {}
      return;
    }

    // Rider can rate after ride: RATE 123456 5
    if (upper.startsWith('RATE ')) {
      const parts = text.split(' ');
      const rideId = parts[1];
      const rating = parseInt(parts[2] || '5');
      await send(`Thanks for rating ride ${rideId} ${rating}/5 ⭐ You helped other riders stay safe.`);
      return;
    }

    // Fallback - if nothing matched
    await send(`Sorry, I didn't understand. Type HI to start again.`);
  });
}

start();
