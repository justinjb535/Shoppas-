import express from 'express';
import dotenv from 'dotenv';
import AfricasTalking from 'africastalking';
import { createClient } from '@supabase/supabase-js';
import Imap from 'imap';
import { simpleParser } from 'mailparser';

dotenv.config();
const app = express();
app.use(express.json());

const {
  AT_USERNAME, AT_API_KEY, YOUR_ZIM_SENDER,
  SUPABASE_URL, SUPABASE_KEY,
  WHATSAPP_TOKEN, PHONE_ID, VERIFY_TOKEN, PROCESS_SECRET,
  OWNER_NUMBER, FNB_EMAIL, FNB_PASS,
  FNB_HOST = 'imap.gmail.com'
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const atSMS = AfricasTalking({ apiKey: AT_API_KEY, username: AT_USERNAME }).SMS;

// === RATE ENGINE ===
let MARKET_RATE = 17.50;
const MARKUP = 1.00;
const Skyie_Fee = 0.025;
const ECOCASH_FEE = 0.015;
let SELL_RATE = MARKET_RATE + MARKUP;

async function fetchRate(){
  try{
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if(j.rates?.ZAR){
      MARKET_RATE = Number(j.rates.ZAR);
      SELL_RATE = MARKET_RATE + MARKUP;
      await supabase.from('settings').upsert({ key:'usd_zar_rate', value:MARKET_RATE, sell_rate:SELL_RATE }, {onConflict:'key'});
      console.log(`Rate Market R${MARKET_RATE} Sell R${SELL_RATE}`);
    }
  }catch{ console.log('Rate fail using', MARKET_RATE); }
}
setInterval(fetchRate, 24*60*60*1000);
fetchRate();

/*function calculateCleanSend(usdWanted){
  const totalRand = usdWanted * SELL_RATE;
  const usdToSend = usdWanted / (1 - ECOCASH_FEE - Skyie_Fee);
  const marketCost = usdToSend * MARKET_RATE;
  const profit = totalRand - marketCost;
  return {
    marketRate: MARKET_RATE,
    sellRate: SELL_RATE,
    usdWanted,
    usdToSend: Number(usdToSend.toFixed(2)),
    customerPaysRand: Number(totalRand.toFixed(2)),
    profitRand: Number(profit.toFixed(2)),
    message: `Rate: R${SELL_RATE.toFixed(2)}/$1 (Market R${MARKET_RATE.toFixed(2)}+R${MARKUP})\nYou pay: R${totalRand.toFixed(2)} for $${usdWanted}\nReceiver gets: $${usdWanted} clean (send $${usdToSend.toFixed(2)} cover EcoCash 1.5%)`
  };
}*/

function calculateCleanSend(usdWanted){
  const totalRand = usdWanted * SELL_RATE; // Customer pays in SA
  const usdToSend = usdWanted / (1 - ECOCASH_FEE); // Only cover EcoCash: $100 / 0.985 = $101.52
  const marketCost = usdToSend * MARKET_RATE; // What it costs you in USD market
  const totalProfitRand = totalRand - marketCost; // R1 markup + your 2.5% inside this

  // Breakdown for you:
  const ecoCashLossUsd = usdToSend - usdWanted; // $1.52
  const skyieCutRand = usdWanted * Skyie_Fee * SELL_RATE; // Your 2.5% fee e.g. $100*0.025*R18.5 = R46.25
  return {
    marketRate: MARKET_RATE,
    sellRate: SELL_RATE,
    usdWanted, // receiver gets clean
    usdToSend: Number(usdToSend.toFixed(2)), // YOU send this via AT
    customerPaysRand: Number(totalRand.toFixed(2)),
    profitRand: Number(totalProfitRand.toFixed(2)),
    ecoCashFee: Number(ecoCashLossUsd.toFixed(2)),
    skyieFeeRand: Number(skyieCutRand.toFixed(2)),
    message: `Rate: R${SELL_RATE.toFixed(2)}/$1\nPay: R${totalRand.toFixed(2)} for $${usdWanted}\nSend $${usdToSend.toFixed(2)} (EcoCash fee $${ecoCashLossUsd.toFixed(2)})\nProfit: R${totalProfitRand.toFixed(2)} (incl Skyie R${skyieCutRand.toFixed(2)})`
  };
}

// === HELPERS ===
const IS_OWNER = (p) => p === OWNER_NUMBER;

async function sendWhatsApp(to, text){
  if(!WHATSAPP_TOKEN) return console.log(`[WA] ${to}: ${text}`);
  try{
    await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,{
      method:'POST',
      headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ messaging_product:'whatsapp', to, type:'text', text:{body:text} })
    });
  }catch(e){ console.error('WA fail', e.message); }
}
async function sendAT(to, message){
  try{
    await atSMS.send({ to:[to], message });
    return true;
  }catch(e){ console.error('AT fail', e.message); return false; }
}

// === CREDIT ENGINE ===
async function getAgent(phone){
  const {data} = await supabase.from('agents').select('*').eq('phone', phone).single();
  return data;
}
async function addCredits(phone, amountRand){
  const ag = await getAgent(phone);
  if(!ag) return null;
  const rate = ag.use_my_ecocash ? 15 : 10;
  const creditsToAdd = Math.floor(amountRand / rate);
  const newBal = (ag.credits||0) + creditsToAdd;
  await supabase.from('agents').update({ credits:newBal, paused:false }).eq('phone', phone);
  await sendWhatsApp(phone, `✅ Credited R${amountRand} = ${creditsToAdd} @ R${rate}/tx\nBal: ${newBal}\nBot resumed`);
  return newBal;
}
async function canSend(phone){
  if(IS_OWNER(phone)) return true;
  const ag = await getAgent(phone);
  if(!ag || ag.paused || (ag.credits||0) <=0){
    await supabase.from('agents').update({ paused:true }).eq('phone', phone);
    return false;
  }
  return true;
}
async function deductCredit(phone){
  if(IS_OWNER(phone)) return { ok:true, left:9999 };
  const ag = await getAgent(phone);
  const newBal = (ag.credits||0) -1;
  await supabase.from('agents').update({ credits:newBal }).eq('phone', phone);
  if(newBal <=0){
    await supabase.from('agents').update({ paused:true }).eq('phone', phone);
    await sendWhatsApp(phone, `⚠️ Last credit used! PAUSED. Top up AGENT-${phone.slice(-4)}`);
  }
  return { ok:true, left:newBal };
}

// === AT QUEUE ENGINE - 5 in 10 mins, 1 per 60s per phone ===
const SEND_DELAY_MS = 60*1000;
const MAX_PER_WINDOW = 5;
const WINDOW_MS = 10*60*1000;
const queues = new Map();

function getQueue(phone){
  if(!queues.has(phone)) queues.set(phone, { pending:[], lastSent:0, windowStart:Date.now(), count:0 });
  return queues.get(phone);
}
function queueATSend(senderPhone, atMessage, agentPhone, zpRef, calc){
  const q = getQueue(senderPhone);
  q.pending.push({ atMessage, agentPhone, zpRef, calc, enqueued:Date.now() });
  console.log(`Queued ${zpRef} for ${senderPhone} len ${q.pending.length}`);
}
async function processQueues(){
  for(const [senderPhone, q] of queues.entries()){
    if(q.pending.length===0) continue;
    const now = Date.now();
    if(now - q.windowStart > WINDOW_MS){ q.windowStart = now; q.count = 0; }
    if(q.count >= MAX_PER_WINDOW) continue;
    if(now - q.lastSent < SEND_DELAY_MS) continue;

    const job = q.pending.shift();
    const ok = await sendAT(senderPhone, job.atMessage);
    if(ok){
      q.lastSent = now; q.count++;
      const d = await deductCredit(job.agentPhone);
      await supabase.from('payments').update({ status:'SENT', sent_amount:job.calc.usdToSend, sent_at:new Date().toISOString() }).eq('zp_ref', job.zpRef);
      await sendWhatsApp(job.agentPhone, `${job.calc.message}\n✅ Sent ${job.atMessage}\nLeft: ${d.left}\nQueue: ${q.pending.length} | Ref: ${job.zpRef}`);
      console.log(`Sent ${job.zpRef} to ${senderPhone}`);
    }else{
      q.pending.unshift(job);
    }
  }
}
setInterval(processQueues, 15*1000);

// === WEBHOOKS ===
app.get('/webhook', (req,res)=>{
  if(req.query['hub.verify_token'] === VERIFY_TOKEN) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook', async (req,res)=>{
  try{
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return res.sendStatus(200);
    const from = msg.from; const text = msg.text?.body?.trim()||''; const upper = text.toUpperCase();
    if(upper.startsWith('REGISTER')){
      const parts = text.split(/\s+/); const fnbEmail = (parts[1]||'').toLowerCase();
      const useMine = upper.includes('USEMINE'); const phonePart = parts[2]||'';
      if(!fnbEmail.includes('@')){ await sendWhatsApp(from, 'Format: REGISTER email +26377... OR REGISTER email USEMINE'); return res.sendStatus(200); }
      const senderPhone = useMine ? YOUR_ZIM_SENDER : (phonePart.includes('263')?phonePart:`+${phonePart}`);
      await supabase.from('agents').upsert({ phone:from, fnb_email:fnbEmail, sender_phone:senderPhone, use_my_ecocash:useMine, credits:IS_OWNER(from)?9999:0, paused:false }, {onConflict:'phone'});
      await sendWhatsApp(from, `✅ Registered\nEmail: ${fnbEmail}\nSender: ${senderPhone}\nRate: R${SELL_RATE}/$1\nTop up Ref: AGENT-${from.slice(-4)}`);
      return res.sendStatus(200);
    }
    if(upper==='BALANCE'){
      const ag = await getAgent(from);
      if(!ag){ await sendWhatsApp(from, 'Not registered'); return res.sendStatus(200); }
      const q = getQueue(ag.sender_phone);
      await sendWhatsApp(from, `💰 ${IS_OWNER(from)?'OWNER ∞':(ag.paused?'PAUSED':'ACTIVE')}\nCredits: ${IS_OWNER(from)?'∞':ag.credits}\nRate: R${SELL_RATE}/$1\nQueue for your sender: ${q.pending.length} pending\nSender: ${ag.sender_phone}`);
      return res.sendStatus(200);
    }
    if(upper.startsWith('ADD') && IS_OWNER(from)){
      const parts = text.split(/\s+/); const target=parts[1]; const amt=parseFloat(parts[2])||0;
      const bal = await addCredits(target, amt);
      await sendWhatsApp(from, `Added R${amt} to ${target} -> ${bal}`);
      return res.sendStatus(200);
    }
    if(upper==='RATE'){
      await sendWhatsApp(from, `Sell R${SELL_RATE}/$1 (Market R${MARKET_RATE}+R1)\n$100 = R${(100*SELL_RATE).toFixed(2)} clean`);
      return res.sendStatus(200);
    }
  }catch(e){ console.error(e); }
  res.sendStatus(200);
});

// === FNB SCANNER ===
function scanFNB(){
  return new Promise((resolve)=>{
    const found=[]; if(!FNB_EMAIL) return resolve(found);
    const imap = new Imap({ user:FNB_EMAIL, password:FNB_PASS, host:FNB_HOST, port:993, tls:true, tlsOptions:{rejectUnauthorized:false} });
    imap.once('ready', ()=>{
      imap.openBox('INBOX', false, (err)=>{
        if(err){ imap.end(); return resolve(found); }
        imap.search(['UNSEEN', ['FROM','fnb']], (err, results)=>{
          if(!results?.length){ imap.end(); return resolve(found); }
          const f = imap.fetch(results, { bodies:'' });
          f.on('message', (msg)=>{
            msg.on('body', async (stream)=>{
              try{
                const parsed = await simpleParser(stream);
                const body = `${parsed.subject} ${parsed.text} ${parsed.html||''}`;
                const amtM = body.match(/R\s?([\d,]+\.?\d*)/);
                const refM = body.match(/(ZP-\d+-\d+|AGENT-\w+)/i);
                if(amtM && refM) found.push({ ref:refM[1].toUpperCase(), amt:parseFloat(amtM[1].replace(/,/g,'')) });
              }catch{}
            });
          });
          f.once('end', ()=>{ imap.end(); resolve(found); });
          f.once('error', ()=>{ imap.end(); resolve(found); });
        });
      });
    });
    imap.once('error', ()=> resolve(found));
    try{ imap.connect(); }catch{ resolve(found); }
  });
}

// === PROCESSOR ===
app.get('/process', async (req,res)=>{
  if(req.query.key !== PROCESS_SECRET) return res.status(403).send('bad key');
  const payments = await scanFNB();
  let log = `FNB ${payments.length} | Market R${MARKET_RATE} Sell R${SELL_RATE}\n`;
  for(const p of payments){
    if(p.ref.startsWith('AGENT-')){
      const suffix = p.ref.split('-')[1];
      const {data: agents} = await supabase.from('agents').select('*').ilike('phone', `%${suffix}`);
      const ag = agents?.[0];
      if(ag){ const bal = await addCredits(ag.phone, p.amt); log+=`Topup ${ag.phone} R${p.amt} -> ${bal}\n`; }
      continue;
    }
    if(p.ref.startsWith('ZP-')){
      const {data: pay} = await supabase.from('payments').select('*, agents!inner(*)').eq('zp_ref', p.ref).eq('status','PENDING').maybeSingle();
      if(!pay){ log+=`No pending ${p.ref}\n`; continue; }
      const ag = pay.agents;
      if(!await canSend(ag.phone)){
        await sendWhatsApp(ag.phone, `❌ ${p.ref} R${p.amt} received NO CREDITS. Queue paused. Top up AGENT-${ag.phone.slice(-4)}`);
        log+=`Blocked ${ag.phone}\n`; continue;
      }
      const calc = calculateCleanSend(pay.usd_amount);
      const atMsg = `PAY ${pay.customer_ecocash} ${calc.usdToSend}`;
      queueATSend(ag.sender_phone, atMsg, ag.phone, p.ref, calc);
      await supabase.from('payments').update({ status:'QUEUED', fnb_amount:p.amt, queued_at:new Date().toISOString() }).eq('zp_ref', p.ref);
      log+=`Queued ${atMsg} for ${ag.sender_phone}\n`;
    }
  }
  res.send(log + `\nQueues: ${Array.from(queues.entries()).map(([k,v])=>`${k}:${v.pending.length}`).join(', ')}`);
});

app.get('/credit', async (req,res)=>{
  if(req.query.key !== PROCESS_SECRET) return res.status(403).send('bad');
  const bal = await addCredits(req.query.phone, parseFloat(req.query.amount)||0);
  res.send(`Bal ${req.query.phone}: ${bal}`);
});

app.get('/', (req,res)=> res.send(`v3 Live Market R${MARKET_RATE} Sell R${SELL_RATE} Queue ON`));
app.listen(process.env.PORT||10000, ()=> console.log('v3 ESM Queue Live'));
