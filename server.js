// ═══════════════════════════════════════════════════════
//  Growth Hunter Bot v3 — Yahoo Finance tabanlı
//  $1-$20 arası büyüme hisseleri
//  Teknik: yahoo-finance2 (swing bot ile aynı)
//  Fundamental: FMP sadece ücretsiz çalışan kısımlar
// ═══════════════════════════════════════════════════════

const express      = require('express');
const cors         = require('cors');
const cron         = require('node-cron');
const YahooFinance = require('yahoo-finance2').default;

const app = express();
const yf  = new YahooFinance({ suppressNotices: ['ripHistorical'] });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────
const FMP_KEY = process.env.FMP_KEY || 'ebaBgsqqSdv4kSfV92YzyiS6DyRhniQY';

// ─── STATE ───────────────────────────────────────────
let signals    = [];
let isScanning = false;
let lastScan   = null;
let scanLog    = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  scanLog.push(line);
  if (scanLog.length > 500) scanLog.shift();
}

// ─── TARAMA LİSTESİ ($1-$20 büyüme hisseleri) ────────
const TICKERS = [
  // Yapay Zeka / Ses / NLP
  'SOUN','BBAI','AAOI','KOPN','NVTS','LPSN','SEER',
  // Uzay / Savunma
  'RKLB','LUNR','ASTS','ACHR','JOBY','BLDE','SPCE',
  // Kuantum Bilişim
  'IONQ','RGTI','QUBT',
  // Temiz Enerji / Güneş
  'ARRY','NOVA','MAXN','CSIQ','FLNC','PLUG','FCEL',
  'BLNK','CHPT','RUN','SEDG','SPWR','JKS',
  // Kripto Madenciliği
  'MARA','RIOT','CLSK','HUT','CIFR','BITF','IREN',
  // Fintech / SaaS
  'SOFI','OPEN','AVPT','BAND','DCBO','SMMT','GSAT',
  // Biyoteknoloji
  'AGEN','FATE','IMVT','APLT','BEAM','EDIT','NTLA',
  // EV / Otonom
  'RIVN','LCID','NKLA','GOEV','WKHS',
  // Robotik / Lidar
  'OUST','MVIS','LAZR','INVZ','AEVA',
  // Diğer
  'BBAI','RKLB','AIOT','PRCT','PAYO','ACMR',
  'MNTS','SMMT','SOLO','STEM',
];

// ─── YAHOO FİNANCE — Günlük veri çek ─────────────────
async function fetchYahoo(symbol) {
  try {
    const to   = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 320);

    const result = await yf.chart(symbol, {
      period1:  from.toISOString().split('T')[0],
      period2:  to.toISOString().split('T')[0],
      interval: '1d',
    });

    const rows = result?.quotes;
    if (!rows || rows.length < 60) return null;

    return rows
      .map(r => ({
        close:  r.adjclose ?? r.close,
        high:   r.high,
        low:    r.low,
        volume: r.volume || 0,
      }))
      .filter(q => q.close && q.close > 0);
  } catch(e) {
    return null;
  }
}

// ─── YARDIMCI ─────────────────────────────────────────
function sma(arr, period) {
  if (arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── TEKNİK ANALİZ ────────────────────────────────────
function analyzeTechnical(quotes) {
  const closes  = quotes.map(q => q.close);
  const volumes = quotes.map(q => q.volume);
  const n       = closes.length;
  const price   = closes[n - 1];

  // Fiyat filtresi: $1-$20
  if (price < 1 || price > 20) return null;

  const s20  = sma(closes, 20);
  const s50  = sma(closes, 50);
  const s200 = sma(closes, Math.min(200, n));

  if (!s20 || !s50 || !s200) return null;

  // 52 hafta
  const year   = closes.slice(Math.max(0, n - 252));
  const high52 = Math.max(...year);
  const low52  = Math.min(...year);
  const fromLow = ((price - low52) / low52) * 100;

  // Hacim trendi
  const vol30 = sma(volumes, 30) || 1;
  const vol5  = sma(volumes.slice(-5), 5) || 0;
  const volTrend = vol5 / vol30;

  // 3 aylık performans
  const price3m = closes[Math.max(0, n - 63)];
  const perf3m  = ((price - price3m) / price3m) * 100;

  // PUANLAMA
  let techScore = 0;
  const techDetails = [];

  if (s20 > s50) {
    techScore += 2;
    techDetails.push('✅ SMA20 > SMA50');
  } else {
    techDetails.push('❌ SMA20 < SMA50');
  }

  if (price > s50) {
    techScore += 1;
    techDetails.push('✅ Fiyat SMA50 üstünde');
  } else {
    techDetails.push('❌ Fiyat SMA50 altında');
  }

  if (fromLow >= 30) {
    techScore += 1;
    techDetails.push(`✅ 52w düşüğünden +%${fromLow.toFixed(0)}`);
  } else {
    techDetails.push(`⚠️ 52w düşüğünden +%${fromLow.toFixed(0)}`);
  }

  if (volTrend >= 1.2) {
    techScore += 1;
    techDetails.push(`✅ Hacim artıyor (${volTrend.toFixed(1)}x)`);
  } else {
    techDetails.push(`⚠️ Hacim normal (${volTrend.toFixed(1)}x)`);
  }

  if (perf3m >= 20) {
    techScore += 1;
    techDetails.push(`✅ 3ay: +%${perf3m.toFixed(1)}`);
  } else if (perf3m < 0) {
    techDetails.push(`❌ 3ay: %${perf3m.toFixed(1)}`);
  } else {
    techDetails.push(`⚠️ 3ay: +%${perf3m.toFixed(1)}`);
  }

  return {
    price, s20: +s20.toFixed(2), s50: +s50.toFixed(2),
    high52: +high52.toFixed(2), low52: +low52.toFixed(2),
    fromLow: +fromLow.toFixed(1), perf3m: +perf3m.toFixed(1),
    volTrend: +volTrend.toFixed(2), techScore, techDetails
  };
}

// ─── FUNDAMENTAL ANALİZ (FMP ücretsiz) ───────────────
async function analyzeFundamental(symbol) {
  let fundScore = 0;
  const fundDetails = [];

  try {
    // income-statement dene
    const url = `https://financialmodelingprep.com/api/v3/income-statement/${symbol}?limit=3&apikey=${FMP_KEY}`;
    const res  = await fetch(url);
    if (res.ok) {
      const inc = await res.json();
      if (Array.isArray(inc) && inc.length >= 2) {
        const rev0 = inc[0]?.revenue;
        const rev1 = inc[1]?.revenue;
        if (rev0 && rev1 && rev1 !== 0) {
          const g = ((rev0 - rev1) / Math.abs(rev1)) * 100;
          if (g >= 30) { fundScore += 3; fundDetails.push(`🚀 Revenue: +%${g.toFixed(0)} YoY`); }
          else if (g >= 15) { fundScore += 2; fundDetails.push(`✅ Revenue: +%${g.toFixed(0)} YoY`); }
          else if (g >= 5)  { fundScore += 1; fundDetails.push(`⚠️ Revenue: +%${g.toFixed(0)} YoY`); }
          else { fundDetails.push(`❌ Revenue: %${g.toFixed(0)} YoY`); }
        }
        const gm = (inc[0]?.grossProfitRatio || 0) * 100;
        const gm1 = (inc[1]?.grossProfitRatio || 0) * 100;
        if (gm >= 40 && gm > gm1) { fundScore += 2; fundDetails.push(`✅ Gross margin: %${gm.toFixed(1)} ↑`); }
        else if (gm >= 30) { fundScore += 1; fundDetails.push(`⚠️ Gross margin: %${gm.toFixed(1)}`); }
        else if (gm > 0)   { fundDetails.push(`❌ Gross margin: %${gm.toFixed(1)}`); }

        const eps0 = inc[0]?.eps || 0;
        const eps1 = inc[1]?.eps || 0;
        if (eps0 > eps1 && eps0 > -0.5) { fundScore += 1; fundDetails.push(`✅ EPS büyüyor: ${eps1.toFixed(2)}→${eps0.toFixed(2)}`); }
        else if (eps0 > 0) { fundDetails.push(`⚠️ EPS pozitif: ${eps0.toFixed(2)}`); }
        else { fundDetails.push(`❌ EPS negatif: ${eps0.toFixed(2)}`); }
      }
    }
  } catch(e) {
    // FMP çalışmıyorsa sessizce geç
  }

  // FMP hiç çalışmadıysa not ekle
  if (fundDetails.length === 0) {
    fundDetails.push('⚠️ Fundamental veri yok (teknik analiz yeterli)');
  }

  return { fundScore, fundDetails };
}

// ─── HİSSE ANALİZ ─────────────────────────────────────
async function analyzeStock(symbol) {
  const quotes = await fetchYahoo(symbol);
  if (!quotes) return null;

  const tech = analyzeTechnical(quotes);
  if (!tech) return null;

  const fund = await analyzeFundamental(symbol);

  const totalScore = tech.techScore + fund.fundScore;

  let decision, badge;
  if (totalScore >= 7)      { decision = 'GÜÇLÜ BÜYÜME'; badge = '🚀'; }
  else if (totalScore >= 5) { decision = 'BÜYÜME ADAYI'; badge = '⭐'; }
  else if (totalScore >= 3) { decision = 'İZLE';         badge = '👀'; }
  else return null;

  return {
    symbol, price: tech.price, decision, badge, totalScore,
    techScore: tech.techScore, fundScore: fund.fundScore,
    sma20: tech.s20, sma50: tech.s50,
    high52w: tech.high52, low52w: tech.low52,
    fromLow: tech.fromLow, perf3m: tech.perf3m, volTrend: tech.volTrend,
    techDetails: tech.techDetails, fundDetails: fund.fundDetails,
    timestamp: new Date().toISOString()
  };
}

// ─── ANA TARAMA ───────────────────────────────────────
async function runScan() {
  if (isScanning) { log('⚠️ Zaten taranıyor'); return; }
  isScanning = true;
  const found = [];

  try {
    log('═══════════════════════════════════════');
    log('🔍 Growth Hunter taraması başladı');
    log(`📊 ${TICKERS.length} hisse taranacak`);

    for (let i = 0; i < TICKERS.length; i++) {
      const sym = TICKERS[i];
      try {
        const r = await analyzeStock(sym);
        if (r) {
          found.push(r);
          log(`${r.badge} [${r.decision}] ${sym} — $${r.price} — Skor: ${r.totalScore}/12`);
        } else {
          log(`  · ${sym} — elendi`);
        }
      } catch(e) {
        log(`  ⚠️ ${sym}: ${e.message}`);
      }
      if (i < TICKERS.length - 1) await new Promise(r => setTimeout(r, 300));
    }

    found.sort((a, b) => b.totalScore - a.totalScore);
    signals  = found;
    lastScan = new Date().toISOString();

    log('');
    log(`✅ Tamamlandı: ${found.length} aday`);
    log(`   🚀 GÜÇLÜ BÜYÜME: ${found.filter(s => s.decision === 'GÜÇLÜ BÜYÜME').length}`);
    log(`   ⭐ BÜYÜME ADAYI: ${found.filter(s => s.decision === 'BÜYÜME ADAYI').length}`);
    log(`   👀 İZLE:         ${found.filter(s => s.decision === 'İZLE').length}`);
    log('═══════════════════════════════════════');
  } catch(e) {
    log(`❌ Hata: ${e.message}`);
  } finally {
    isScanning = false;
  }
}

// ─── ZAMANLAYICI — Her gün 23:30 TR ──────────────────
cron.schedule('30 23 * * 1-5', () => {
  log('⏰ Otomatik tarama başladı');
  runScan().catch(console.error);
}, { timezone: 'Europe/Istanbul' });

// ─── DASHBOARD HTML ───────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Growth Hunter</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;700&display=swap');
:root{--bg:#080c14;--border:#1a2540;--accent:#00d4ff;--green:#00ff9d;--yellow:#ffcc00;--red:#ff4466;--text:#e0e8f0;--muted:#4a6080;--card:#111827;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:.3;pointer-events:none;z-index:0;}
.wrap{max-width:1200px;margin:0 auto;padding:24px;position:relative;z-index:1;}
header{display:flex;align-items:center;justify-content:space-between;padding:24px 0 32px;border-bottom:1px solid var(--border);margin-bottom:32px;}
.logo{display:flex;align-items:center;gap:14px;}
.logo-icon{width:44px;height:44px;background:linear-gradient(135deg,#00d4ff,#00ff9d);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;}
.logo h1{font-family:'Space Mono',monospace;font-size:18px;color:#fff;}
.logo p{font-size:12px;color:var(--muted);}
.hdr{display:flex;align-items:center;gap:12px;}
.pill{display:flex;align-items:center;gap:6px;padding:6px 14px;background:#0d1421;border:1px solid var(--border);border-radius:20px;font-size:12px;font-family:'Space Mono',monospace;color:var(--muted);}
.dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
.btn{padding:8px 20px;background:linear-gradient(135deg,var(--accent),var(--green));color:#000;border:none;border-radius:8px;font-family:'Space Mono',monospace;font-size:12px;font-weight:700;cursor:pointer;}
.btn:disabled{opacity:.4;cursor:not-allowed;}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px;}
.sc{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;position:relative;overflow:hidden;}
.sc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--c,var(--accent));}
.sc.g{--c:var(--green);}.sc.y{--c:var(--yellow);}
.sl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-family:'Space Mono',monospace;}
.sv{font-size:28px;font-weight:700;color:#fff;font-family:'Space Mono',monospace;}
.ss{font-size:11px;color:var(--muted);margin-top:4px;}
.filters{display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;}
.fb{padding:6px 16px;background:#0d1421;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:13px;cursor:pointer;}
.fb.active{background:var(--accent);border-color:var(--accent);color:#000;font-weight:700;}
.grid{display:grid;gap:12px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 24px;cursor:pointer;position:relative;overflow:hidden;}
.card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--ca,var(--muted));}
.card.s{--ca:var(--green);}.card.c{--ca:var(--yellow);}.card.w{--ca:var(--accent);}
.card:hover,.card.open{border-color:var(--ca,var(--muted));}
.ch{display:flex;align-items:center;justify-content:space-between;}
.cl{display:flex;align-items:center;gap:16px;}
.sym{font-family:'Space Mono',monospace;font-weight:700;font-size:18px;color:#fff;}
.badge{padding:4px 10px;border-radius:4px;font-size:11px;font-weight:700;font-family:'Space Mono',monospace;}
.badge.s{background:rgba(0,255,157,.15);color:var(--green);border:1px solid rgba(0,255,157,.3);}
.badge.c{background:rgba(255,204,0,.15);color:var(--yellow);border:1px solid rgba(255,204,0,.3);}
.badge.w{background:rgba(0,212,255,.15);color:var(--accent);border:1px solid rgba(0,212,255,.3);}
.cr{display:flex;align-items:center;gap:20px;}
.price{font-family:'Space Mono',monospace;font-size:20px;font-weight:700;color:#fff;}
.sc2{display:flex;flex-direction:column;align-items:center;}
.sn{font-family:'Space Mono',monospace;font-size:16px;font-weight:700;color:var(--ca,var(--accent));}
.sk{font-size:10px;color:var(--muted);text-transform:uppercase;}
.ms{display:flex;gap:16px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border);flex-wrap:wrap;}
.mi{display:flex;flex-direction:column;gap:2px;}
.ml{font-size:10px;color:var(--muted);text-transform:uppercase;font-family:'Space Mono',monospace;}
.mv{font-size:13px;font-family:'Space Mono',monospace;}
.det{display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border);}
.card.open .det{display:block;}
.dg{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.ds h4{font-size:11px;color:var(--muted);text-transform:uppercase;font-family:'Space Mono',monospace;margin-bottom:10px;}
.di{font-size:12px;color:var(--text);padding:3px 0;line-height:1.6;}
.bar{display:flex;gap:8px;margin-bottom:10px;align-items:center;}
.bl{font-size:11px;color:var(--muted);font-family:'Space Mono',monospace;width:50px;text-align:right;}
.bt{flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;}
.bf{height:100%;border-radius:3px;}
.bf.t{background:var(--accent);}.bf.f{background:var(--green);}
.bn{font-size:11px;color:var(--text);font-family:'Space Mono',monospace;width:30px;}
.empty{text-align:center;padding:80px 20px;color:var(--muted);}
.empty .ic{font-size:48px;margin-bottom:16px;}
.empty h3{font-size:18px;color:var(--text);margin-bottom:8px;}
.sbar{height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);background-size:200%;animation:scan 1.5s linear infinite;border-radius:1px;margin-bottom:24px;display:none;}
.sbar.on{display:block;}
@keyframes scan{0%{background-position:-100% 0;}100%{background-position:200% 0;}}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:11px;color:var(--muted);font-family:'Space Mono',monospace;}
@media(max-width:768px){.stats{grid-template-columns:repeat(2,1fr);}.dg{grid-template-columns:1fr;}header{flex-direction:column;gap:16px;}}
</style></head><body>
<div class="wrap">
  <header>
    <div class="logo">
      <div class="logo-icon">🚀</div>
      <div><h1>GROWTH HUNTER</h1><p>Geleceğin NVIDIA'sını bul — $1-$20 büyüme hisseleri</p></div>
    </div>
    <div class="hdr">
      <div class="pill"><div class="dot"></div><span id="st">Hazır</span></div>
      <button class="btn" id="sb" onclick="startScan()">⚡ Tara</button>
    </div>
  </header>
  <div class="sbar" id="sbar"></div>
  <div class="stats">
    <div class="sc g"><div class="sl">🚀 Güçlü Büyüme</div><div class="sv" id="cS">—</div><div class="ss">Skor ≥ 7/12</div></div>
    <div class="sc y"><div class="sl">⭐ Büyüme Adayı</div><div class="sv" id="cC">—</div><div class="ss">Skor 5-6/12</div></div>
    <div class="sc"><div class="sl">👀 İzle</div><div class="sv" id="cW">—</div><div class="ss">Skor 3-4/12</div></div>
    <div class="sc"><div class="sl">⏱ Son Tarama</div><div class="sv" style="font-size:13px;margin-top:6px" id="lt">—</div><div class="ss">Her gün 23:30 TR</div></div>
  </div>
  <div class="filters">
    <button class="fb active" onclick="setF('all',this)">Tümü</button>
    <button class="fb" onclick="setF('s',this)">🚀 Güçlü Büyüme</button>
    <button class="fb" onclick="setF('c',this)">⭐ Büyüme Adayı</button>
    <button class="fb" onclick="setF('w',this)">👀 İzle</button>
  </div>
  <div class="grid" id="grid">
    <div class="empty"><div class="ic">🔍</div><h3>Henüz tarama yapılmadı</h3><p>⚡ Tara butonuna bas</p></div>
  </div>
  <footer><span>Growth Hunter v3 — Yahoo Finance</span><span>Yatırım tavsiyesi değildir</span></footer>
</div>
<script>
let all=[], flt='all', poll=null;
function setF(f,b){flt=f;document.querySelectorAll('.fb').forEach(x=>x.classList.remove('active'));b.classList.add('active');render();}
async function startScan(){
  document.getElementById('sb').disabled=true;
  document.getElementById('sb').textContent='⏳ Taranıyor...';
  document.getElementById('sbar').classList.add('on');
  document.getElementById('st').textContent='Taranıyor...';
  await fetch('/scan');
  poll=setInterval(load,8000);
}
function reset(){
  document.getElementById('sb').disabled=false;
  document.getElementById('sb').textContent='⚡ Tara';
  document.getElementById('sbar').classList.remove('on');
  document.getElementById('st').textContent='Hazır';
}
async function load(){
  try{
    const d=await(await fetch('/signals')).json();
    all=d.signals||[];
    document.getElementById('cS').textContent=all.filter(s=>s.decision==='GÜÇLÜ BÜYÜME').length;
    document.getElementById('cC').textContent=all.filter(s=>s.decision==='BÜYÜME ADAYI').length;
    document.getElementById('cW').textContent=all.filter(s=>s.decision==='İZLE').length;
    if(d.lastScan){
      document.getElementById('lt').textContent=new Date(d.lastScan).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      reset();if(poll){clearInterval(poll);poll=null;}
    }
    render();
  }catch(e){console.error(e);}
}
function render(){
  const g=document.getElementById('grid');
  let list=all;
  if(flt==='s') list=list.filter(x=>x.decision==='GÜÇLÜ BÜYÜME');
  else if(flt==='c') list=list.filter(x=>x.decision==='BÜYÜME ADAYI');
  else if(flt==='w') list=list.filter(x=>x.decision==='İZLE');
  if(!list.length){
    g.innerHTML='<div class="empty"><div class="ic">🔍</div><h3>'+(all.length?'Bu filtrede sonuç yok':'Henüz tarama yapılmadı')+'</h3><p>'+(all.length?'Farklı filtre dene':'⚡ Tara butonuna bas')+'</p></div>';
    return;
  }
  g.innerHTML=list.map(s=>{
    const c=s.decision==='GÜÇLÜ BÜYÜME'?'s':s.decision==='BÜYÜME ADAYI'?'c':'w';
    return '<div class="card '+c+'" onclick="this.classList.toggle(\'open\')">'+
      '<div class="ch"><div class="cl"><div class="sym">'+s.symbol+'</div><div class="badge '+c+'">'+s.badge+' '+s.decision+'</div></div>'+
      '<div class="cr"><div class="price">$'+s.price?.toFixed(2)+'</div><div class="sc2"><div class="sn">'+s.totalScore+'/12</div><div class="sk">SKOR</div></div></div></div>'+
      '<div class="ms">'+
        '<div class="mi"><div class="ml">SMA20</div><div class="mv">$'+s.sma20+'</div></div>'+
        '<div class="mi"><div class="ml">SMA50</div><div class="mv">$'+s.sma50+'</div></div>'+
        '<div class="mi"><div class="ml">3ay</div><div class="mv" style="color:'+(s.perf3m>=0?'var(--green)':'var(--red)')+'">'+( s.perf3m>=0?'+':'')+s.perf3m+'%</div></div>'+
        '<div class="mi"><div class="ml">Hacim</div><div class="mv" style="color:'+(s.volTrend>=1.2?'var(--green)':'var(--muted)')+'">'+s.volTrend+'x</div></div>'+
        '<div class="mi"><div class="ml">52w düşük</div><div class="mv">+'+s.fromLow+'%</div></div>'+
      '</div>'+
      '<div class="det">'+
        '<div class="bar"><div class="bl">TEKNİK</div><div class="bt"><div class="bf t" style="width:'+((s.techScore/6)*100)+'%"></div></div><div class="bn">'+s.techScore+'/6</div></div>'+
        '<div class="bar"><div class="bl">FUND.</div><div class="bt"><div class="bf f" style="width:'+((s.fundScore/6)*100)+'%"></div></div><div class="bn">'+s.fundScore+'/6</div></div>'+
        '<div class="dg">'+
          '<div class="ds"><h4>📊 Teknik</h4>'+(s.techDetails||[]).map(d=>'<div class="di">'+d+'</div>').join('')+'</div>'+
          '<div class="ds"><h4>📈 Fundamental</h4>'+(s.fundDetails||[]).map(d=>'<div class="di">'+d+'</div>').join('')+'</div>'+
        '</div></div></div>';
  }).join('');
}
load();setInterval(load,120000);
</script></body></html>`);
});

// ─── API ENDPOINTLER ──────────────────────────────────
app.get('/signals', (req, res) => {
  let list = [...signals];
  if (req.query.filter === 'strong')    list = list.filter(s => s.decision === 'GÜÇLÜ BÜYÜME');
  if (req.query.filter === 'candidate') list = list.filter(s => s.decision === 'BÜYÜME ADAYI');
  res.json({ lastScan, count: list.length, signals: list.slice(0, 100) });
});

app.get('/scan', async (req, res) => {
  if (isScanning) return res.json({ message: 'Tarama devam ediyor...' });
  res.json({ message: `Tarama başladı — ${TICKERS.length} hisse` });
  runScan().catch(console.error);
});

app.get('/logs', (req, res) => {
  res.json({ logs: scanLog.slice(-100) });
});

// ─── BAŞLAT ───────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Growth Hunter Bot v3 — Yahoo Finance 🚀    ║
║   Her gün 23:30 TR otomatik tarama           ║
╚══════════════════════════════════════════════╝`);
  setTimeout(() => runScan().catch(console.error), 5000);
});
