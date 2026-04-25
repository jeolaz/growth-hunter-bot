// ═══════════════════════════════════════════════════════
//  Growth Hunter Bot v2 — "Geleceğin NVIDIA'sını Bul"
//  FMP tabanlı, hibrit teknik+fundamental
//  Screener yerine curated liste kullanıyor (ücretsiz plan)
// ═══════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────
const FMP_KEY  = process.env.FMP_KEY || 'ebaBgsqqSdv4kSfV92YzyiS6DyRhniQY';
const FMP_BASE = 'https://financialmodelingprep.com/stable';

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

// ─── FMP YARDIMCI ────────────────────────────────────
async function fmpGet(endpoint, params = {}) {
  const url = new URL(`${FMP_BASE}${endpoint}`);
  url.searchParams.set('apikey', FMP_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data?.['Error Message']) throw new Error(data['Error Message']);
  return data;
}

// ─── TARAMA LİSTESİ ──────────────────────────────────
// $1-20 arası yüksek potansiyelli büyüme hisseleri
// Teknoloji, enerji, biyoteknoloji, yapay zeka odaklı
const TICKERS = [
  // Yapay Zeka / Teknoloji
  'SOUN','BBAI','AAOI','KOPN','INPX','NVTS','AIOT','MOBX',
  'RVNC','PRCT','ITRN','CLPS','FEAM','PAYO','ACMR',
  // Uzay / Savunma
  'RKLB','LUNR','ASTS','SPCE','ASTR','MNTS','BWAQ',
  // Temiz Enerji / EV
  'PLUG','FCEL','BLNK','CHPT','NKLA','GOEV','WKHS','SOLO',
  'ARRY','NOVA','MAXN','CSIQ','FLNC','STEM',
  // Kripto / Blockchain
  'MARA','RIOT','CLSK','HUT','BTBT','CIFR','BITF','IREN',
  // Biyoteknoloji
  'SEER','AGEN','XNCR','FATE','IMVT','PRAX','APLT','ITOS',
  'KALA','BEAM','EDIT','NTLA','VERV','CRSP',
  // Fintech / SaaS
  'SOFI','OPEN','LPSN','AVPT','BAND','MAPS','DCBO',
  // Robotik / Otomasyon
  'OUST','AEVA','MVIS','LIDR','LAZR','INVZ',
  // Diğer büyüme
  'IONQ','RGTI','QUBT','SMMT','GSAT','JOBY','ACHR','BLDE',
  'RIVN','LCID','NKLA','SPWR','RUN','SEDG','JKS'
];

// ─── TEKNİK ANALİZ ───────────────────────────────────
async function getTechnical(symbol) {
  try {
    const data = await fmpGet(`/historical-price-eod/full/${symbol}`, { limit: 120 });

    const hist = data?.historical;
    if (!hist || hist.length < 60) return null;

    const prices = hist.slice().reverse(); // eskiden yeniye
    const closes  = prices.map(d => d.close);
    const volumes = prices.map(d => d.volume);
    const n = closes.length;
    const last = n - 1;

    if (last < 49) return null;

    // Güncel fiyat $1-$20 arasında mı?
    const price = closes[last];
    if (price < 1 || price > 20) return null;

    // SMA hesapla
    const sma = (arr, period) => {
      const slice = arr.slice(last - period + 1, last + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);

    // 52 hafta
    const year   = closes.slice(Math.max(0, n - 252));
    const high52w = Math.max(...year);
    const low52w  = Math.min(...year);

    // Hacim trendi (son 5 gün / son 30 gün ortalaması)
    const vol30avg = volumes.slice(-30).reduce((a, b) => a + b, 0) / 30;
    const vol5avg  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volTrend = vol30avg > 0 ? vol5avg / vol30avg : 1;

    // 3 aylık performans
    const price3m  = closes[Math.max(0, n - 63)];
    const perf3m   = ((price - price3m) / price3m) * 100;

    // Dipten uzaklık
    const fromLow  = ((price - low52w) / low52w) * 100;

    // TEKNİK PUANLAMA
    let techScore = 0;
    const techDetails = [];

    if (sma20 > sma50) {
      techScore += 2;
      techDetails.push('✅ SMA20 > SMA50 (kısa vade güçlü)');
    } else {
      techDetails.push('❌ SMA20 < SMA50 (trend zayıf)');
    }

    if (price > sma50) {
      techScore += 1;
      techDetails.push('✅ Fiyat SMA50 üstünde');
    } else {
      techDetails.push('❌ Fiyat SMA50 altında');
    }

    if (fromLow >= 30) {
      techScore += 1;
      techDetails.push(`✅ 52w düşüğünden +%${fromLow.toFixed(0)} (güçlü dönüş)`);
    } else {
      techDetails.push(`⚠️ 52w düşüğünden +%${fromLow.toFixed(0)} (düşük)`);
    }

    if (volTrend >= 1.2) {
      techScore += 1;
      techDetails.push(`✅ Hacim artıyor (${volTrend.toFixed(1)}x 30g ortalama)`);
    } else {
      techDetails.push(`⚠️ Hacim normal (${volTrend.toFixed(1)}x)`);
    }

    if (perf3m >= 20) {
      techScore += 1;
      techDetails.push(`✅ 3 aylık performans: +%${perf3m.toFixed(1)}`);
    } else if (perf3m >= 0) {
      techDetails.push(`⚠️ 3 aylık performans: +%${perf3m.toFixed(1)}`);
    } else {
      techDetails.push(`❌ 3 aylık performans: %${perf3m.toFixed(1)}`);
    }

    return { price, sma20: +sma20.toFixed(2), sma50: +sma50.toFixed(2),
             high52w: +high52w.toFixed(2), low52w: +low52w.toFixed(2),
             fromLow: +fromLow.toFixed(1), perf3m: +perf3m.toFixed(1),
             volTrend: +volTrend.toFixed(2), techScore, techDetails };
  } catch(e) {
    return null;
  }
}

// ─── FUNDAMENTAL ANALİZ ──────────────────────────────
async function getFundamentals(symbol) {
  let fundScore = 0;
  const fundDetails = [];

  try {
    const [incomeRes, ratioRes, instRes] = await Promise.allSettled([
      fmpGet(`/income-statement/${symbol}`, { period: 'annual', limit: 3 }),
      fmpGet(`/ratios-ttm/${symbol}`),
      fmpGet(`/institutional-ownership/symbol/${symbol}`, { limit: 2 })
    ]);

    // Revenue büyümesi + Gross Margin + EPS
    if (incomeRes.status === 'fulfilled') {
      const inc = incomeRes.value;
      if (Array.isArray(inc) && inc.length >= 2) {
        const rev0 = inc[0]?.revenue;
        const rev1 = inc[1]?.revenue;
        if (rev0 && rev1 && rev1 !== 0) {
          const revGrowth = ((rev0 - rev1) / Math.abs(rev1)) * 100;
          if (revGrowth >= 30) {
            fundScore += 3;
            fundDetails.push(`🚀 Revenue büyümesi: +%${revGrowth.toFixed(0)} YoY (çok güçlü!)`);
          } else if (revGrowth >= 15) {
            fundScore += 2;
            fundDetails.push(`✅ Revenue büyümesi: +%${revGrowth.toFixed(0)} YoY`);
          } else if (revGrowth >= 5) {
            fundScore += 1;
            fundDetails.push(`⚠️ Revenue büyümesi: +%${revGrowth.toFixed(0)} YoY (yavaş)`);
          } else {
            fundDetails.push(`❌ Revenue büyümesi: %${revGrowth.toFixed(0)} YoY`);
          }
        }

        const gm0 = (inc[0]?.grossProfitRatio || 0) * 100;
        const gm1 = (inc[1]?.grossProfitRatio || 0) * 100;
        if (gm0 > 0) {
          if (gm0 >= 40 && gm0 > gm1) {
            fundScore += 2;
            fundDetails.push(`✅ Gross margin: %${gm0.toFixed(1)} ve artıyor`);
          } else if (gm0 >= 30) {
            fundScore += 1;
            fundDetails.push(`⚠️ Gross margin: %${gm0.toFixed(1)}`);
          } else {
            fundDetails.push(`❌ Gross margin düşük: %${gm0.toFixed(1)}`);
          }
        }

        const eps0 = inc[0]?.eps;
        const eps1 = inc[1]?.eps;
        if (eps0 !== undefined && eps1 !== undefined && eps0 > eps1) {
          fundScore += 1;
          fundDetails.push(`✅ EPS büyüyor: ${(+eps1).toFixed(2)} → ${(+eps0).toFixed(2)}`);
        } else if (eps0 > 0) {
          fundDetails.push(`⚠️ EPS pozitif: ${(+eps0).toFixed(2)}`);
        } else {
          fundDetails.push(`❌ EPS negatif (şirket zarar ediyor)`);
        }
      }
    }

    // Kurumsal sahiplik
    if (instRes.status === 'fulfilled') {
      const inst = instRes.value;
      if (Array.isArray(inst) && inst.length >= 2) {
        const n0 = inst[0]?.investors || 0;
        const n1 = inst[1]?.investors || 0;
        if (n0 > n1) {
          fundScore += 1;
          fundDetails.push(`✅ Kurumsal yatırımcı artıyor: ${n1} → ${n0}`);
        } else {
          fundDetails.push(`⚠️ Kurumsal sahiplik durağan`);
        }
      }
    }

    // P/S oranı
    if (ratioRes.status === 'fulfilled') {
      const r = Array.isArray(ratioRes.value) ? ratioRes.value[0] : ratioRes.value;
      const ps = r?.priceToSalesRatioTTM;
      if (ps && ps > 0 && ps < 5) {
        fundScore += 1;
        fundDetails.push(`✅ P/S oranı: ${(+ps).toFixed(1)}x (ucuz büyüme)`);
      } else if (ps) {
        fundDetails.push(`⚠️ P/S oranı: ${(+ps).toFixed(1)}x`);
      }
    }

    if (fundDetails.length === 0) {
      fundDetails.push('⚠️ Fundamental veri bulunamadı');
    }

  } catch(e) {
    fundDetails.push(`⚠️ Fundamental veri hatası: ${e.message}`);
  }

  return { fundScore, fundDetails };
}

// ─── HİSSE DEĞERLENDİR ───────────────────────────────
async function analyzeStock(symbol) {
  const [tech, fund] = await Promise.all([
    getTechnical(symbol),
    getFundamentals(symbol)
  ]);

  if (!tech) return null;

  const totalScore = tech.techScore + fund.fundScore;

  let decision, badge;
  if (totalScore >= 7) { decision = 'GÜÇLÜ BÜYÜME'; badge = '🚀'; }
  else if (totalScore >= 5) { decision = 'BÜYÜME ADAYI'; badge = '⭐'; }
  else if (totalScore >= 3) { decision = 'İZLE'; badge = '👀'; }
  else return null;

  return {
    symbol, price: tech.price, decision, badge, totalScore,
    techScore: tech.techScore, fundScore: fund.fundScore,
    sma20: tech.sma20, sma50: tech.sma50,
    high52w: tech.high52w, low52w: tech.low52w,
    fromLow: tech.fromLow, perf3m: tech.perf3m, volTrend: tech.volTrend,
    techDetails: tech.techDetails, fundDetails: fund.fundDetails,
    timestamp: new Date().toISOString()
  };
}

// ─── ANA TARAMA ──────────────────────────────────────
async function runScan() {
  if (isScanning) { log('⚠️ Zaten taranıyor'); return; }
  isScanning = true;
  const newSignals = [];

  try {
    log('═══════════════════════════════════════');
    log('🔍 Growth Hunter taraması başladı');
    log(`📊 ${TICKERS.length} hisse taranacak`);

    for (let i = 0; i < TICKERS.length; i++) {
      const sym = TICKERS[i];
      try {
        const result = await analyzeStock(sym);
        if (result) {
          newSignals.push(result);
          log(`${result.badge} [${result.decision}] ${sym} — $${result.price} — Skor: ${result.totalScore}/12`);
        } else {
          log(`  · ${sym} — elendi`);
        }
      } catch(e) {
        log(`  ⚠️ ${sym}: ${e.message}`);
      }
      if (i < TICKERS.length - 1) await new Promise(r => setTimeout(r, 400));
    }

    newSignals.sort((a, b) => b.totalScore - a.totalScore);
    signals = newSignals;
    lastScan = new Date().toISOString();

    log('');
    log(`✅ Tamamlandı: ${newSignals.length} aday`);
    log(`   🚀 GÜÇLÜ BÜYÜME: ${newSignals.filter(s => s.decision === 'GÜÇLÜ BÜYÜME').length}`);
    log(`   ⭐ BÜYÜME ADAYI: ${newSignals.filter(s => s.decision === 'BÜYÜME ADAYI').length}`);
    log(`   👀 İZLE:         ${newSignals.filter(s => s.decision === 'İZLE').length}`);
    log('═══════════════════════════════════════');
  } catch(e) {
    log(`❌ Tarama hatası: ${e.message}`);
  } finally {
    isScanning = false;
  }
}

// ─── ZAMANLAYICI — her gün 23:30 TR ──────────────────
cron.schedule('30 23 * * 1-5', () => {
  log('⏰ Otomatik tarama (ABD kapanış sonrası)');
  runScan().catch(console.error);
}, { timezone: 'Europe/Istanbul' });

// ─── ENDPOINTLER ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Growth Hunter Bot çalışıyor 🚀',
    lastScan, isScanning,
    totalSignals: signals.length,
    breakdown: {
      strongGrowth:    signals.filter(s => s.decision === 'GÜÇLÜ BÜYÜME').length,
      growthCandidate: signals.filter(s => s.decision === 'BÜYÜME ADAYI').length,
      watch:           signals.filter(s => s.decision === 'İZLE').length
    }
  });
});

app.get('/signals', (req, res) => {
  let list = [...signals];
  if (req.query.filter === 'strong')    list = list.filter(s => s.decision === 'GÜÇLÜ BÜYÜME');
  if (req.query.filter === 'candidate') list = list.filter(s => s.decision === 'BÜYÜME ADAYI');
  res.json({ lastScan, count: list.length, signals: list.slice(0, 100) });
});

app.get('/scan', async (req, res) => {
  if (isScanning) return res.json({ message: 'Tarama devam ediyor...' });
  res.json({ message: `Tarama başladı — ${TICKERS.length} hisse taranıyor. ~5 dakika sürer.` });
  runScan().catch(console.error);
});

app.get('/logs', (req, res) => {
  res.json({ logs: scanLog.slice(-100) });
});

// ─── BAŞLAT ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Growth Hunter Bot v2                       ║
║   Geleceğin NVIDIA'sını Bul 🚀               ║
║   Her gün 23:30 TR otomatik tarama           ║
╚══════════════════════════════════════════════╝`);
  setTimeout(() => runScan().catch(console.error), 5000);
});
