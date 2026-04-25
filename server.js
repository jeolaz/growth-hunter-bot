// ═══════════════════════════════════════════════════════
//  Growth Hunter Bot — "Geleceğin NVIDIA'sını Bul"
//  FMP (Financial Modeling Prep) tabanlı
//  Teknik + Fundamental hibrit tarama
// ═══════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────
const FMP_KEY  = process.env.FMP_KEY || 'ebaBgsqqSdv4kSfV92YzyiS6DyRhniQY';
const FMP_BASE = 'https://financialmodelingprep.com/stable';

// ─── STATE ───────────────────────────────────────────
let signals   = [];
let isScanning = false;
let lastScan  = null;
let scanLog   = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  scanLog.push(line);
  if (scanLog.length > 200) scanLog.shift();
}

// ─── FMP YARDIMCI ────────────────────────────────────
async function fmpGet(endpoint, params = {}) {
  const url = new URL(`${FMP_BASE}${endpoint}`);
  url.searchParams.set('apikey', FMP_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FMP ${endpoint} → HTTP ${res.status}`);
  return res.json();
}

// ─── ADIM 1: TARAMA LİSTESİ ──────────────────────────
// FMP screener ile $1-$20, market cap >$100M, US borsaları
async function getScreenedTickers() {
  log('📋 Hisse listesi çekiliyor (FMP screener)...');
  const data = await fmpGet('/stock-screener', {
    marketCapMoreThan: 100000000,   // min $100M market cap
    marketCapLowerThan: 10000000000, // max $10B (küçük/orta cap)
    priceMoreThan: 1,
    priceLowerThan: 20,
    country: 'US',
    isActivelyTrading: true,
    limit: 300
  });

  if (!Array.isArray(data)) {
    log('⚠️ Screener veri dönmedi, fallback listeye geçiliyor');
    return FALLBACK_TICKERS;
  }

  // Çöp borsaları filtrele (sadece NYSE, NASDAQ, AMEX)
  const filtered = data.filter(s =>
    ['NYSE', 'NASDAQ', 'AMEX'].includes(s.exchangeShortName) &&
    s.price > 1 && s.price < 20
  );

  log(`✅ ${filtered.length} hisse bulundu screener'dan`);
  return filtered.map(s => s.symbol);
}

// Screener çalışmazsa fallback liste
const FALLBACK_TICKERS = [
  'SOFI','PLUG','OPEN','RIVN','LCID','MARA','RIOT','CLSK',
  'IONQ','RGTI','QUBT','ARRY','FLNC','NOVA','STEM','SPWR',
  'JOBY','ACHR','LILM','BLDE','EVTL','WKHS','NKLA','GOEV',
  'SOUN','LPSN','BBAI','RKLB','LUNR','ASTS','SMMT','GSAT',
  'MAXN','CSIQ','JKS','FSLR','ENPH','SEDG','RUN','NOVA',
  'BAND','AVPT','DCBO','GBOX','MTTR','MAPS','OUST','AEVA',
  'INVZ','MVIS','LIDR','LAZR','VLDR','AEYE','CEPTON'
];

// ─── ADIM 2: TEKNİK ANALİZ ───────────────────────────
async function getTechnical(symbol) {
  try {
    // Günlük fiyat verisi — son 120 gün
    const prices = await fmpGet(`/historical-price-eod/full/${symbol}`, {
      limit: 120
    });

    if (!prices?.historical || prices.historical.length < 60) return null;

    const hist = prices.historical.slice().reverse(); // eskiden yeniye
    const closes = hist.map(d => d.close);
    const volumes = hist.map(d => d.volume);
    const n = closes.length;

    // SMA hesapla
    const sma = (arr, period, idx) => {
      const slice = arr.slice(idx - period + 1, idx + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };

    const last = n - 1;
    if (last < 49) return null;

    const sma20 = sma(closes, 20, last);
    const sma50 = sma(closes, 50, last);
    const price = closes[last];

    // 52 hafta yüksek/düşük
    const year = closes.slice(-252);
    const high52w = Math.max(...year);
    const low52w  = Math.min(...year);

    // Hacim analizi
    const avgVol30 = volumes.slice(-30).reduce((a, b) => a + b, 0) / 30;
    const avgVol5  = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const volTrend = avgVol5 / avgVol30; // >1 ise hacim artıyor

    // Momentum: son 3 ay performance
    const price3mAgo = closes[Math.max(0, n - 63)];
    const perf3m = ((price - price3mAgo) / price3mAgo) * 100;

    // Teknik puanlama
    let techScore = 0;
    const techDetails = [];

    if (sma20 > sma50) {
      techScore += 2;
      techDetails.push('✅ SMA20 > SMA50 (kısa vade güçlü)');
    } else {
      techDetails.push('❌ SMA20 < SMA50');
    }

    if (price > sma50) {
      techScore += 1;
      techDetails.push('✅ Fiyat SMA50 üstünde');
    }

    const fromLow = ((price - low52w) / low52w) * 100;
    if (fromLow >= 30) {
      techScore += 1;
      techDetails.push(`✅ 52w düşüğünden +%${fromLow.toFixed(0)} (dipten dönmüş)`);
    } else {
      techDetails.push(`⚠️ 52w düşüğünden sadece +%${fromLow.toFixed(0)}`);
    }

    if (volTrend >= 1.2) {
      techScore += 1;
      techDetails.push(`✅ Hacim artıyor (${volTrend.toFixed(1)}x ortalama)`);
    }

    if (perf3m >= 20) {
      techScore += 1;
      techDetails.push(`✅ 3 aylık performans: +%${perf3m.toFixed(1)}`);
    } else if (perf3m < 0) {
      techDetails.push(`❌ 3 aylık performans: %${perf3m.toFixed(1)}`);
    }

    return {
      price,
      sma20: +sma20.toFixed(2),
      sma50: +sma50.toFixed(2),
      high52w: +high52w.toFixed(2),
      low52w:  +low52w.toFixed(2),
      fromLow: +fromLow.toFixed(1),
      perf3m:  +perf3m.toFixed(1),
      volTrend: +volTrend.toFixed(2),
      techScore,
      techDetails
    };
  } catch (e) {
    return null;
  }
}

// ─── ADIM 3: FUNDAMENTAL ANALİZ ──────────────────────
async function getFundamentals(symbol) {
  try {
    // Gelir tablosu (son 4 çeyrek)
    const [incomeData, ratiosData, institutionalData] = await Promise.allSettled([
      fmpGet(`/income-statement/${symbol}`, { period: 'annual', limit: 3 }),
      fmpGet(`/ratios-ttm/${symbol}`),
      fmpGet(`/institutional-ownership/symbol/${symbol}`, { limit: 2 })
    ]);

    let fundScore = 0;
    const fundDetails = [];

    // ── Revenue büyümesi ──
    if (incomeData.status === 'fulfilled' && Array.isArray(incomeData.value) && incomeData.value.length >= 2) {
      const income = incomeData.value;
      const revLatest = income[0]?.revenue;
      const revPrev   = income[1]?.revenue;
      const revGrowth = revLatest && revPrev ? ((revLatest - revPrev) / Math.abs(revPrev)) * 100 : null;

      if (revGrowth !== null) {
        if (revGrowth >= 30) {
          fundScore += 3;
          fundDetails.push(`🚀 Revenue büyümesi: +%${revGrowth.toFixed(0)} YoY (çok güçlü)`);
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

      // Gross margin
      const gm0 = income[0]?.grossProfitRatio * 100;
      const gm1 = income[1]?.grossProfitRatio * 100;
      if (gm0 && gm1) {
        if (gm0 >= 40 && gm0 > gm1) {
          fundScore += 2;
          fundDetails.push(`✅ Gross margin: %${gm0.toFixed(1)} ve artıyor (+${(gm0 - gm1).toFixed(1)} puan)`);
        } else if (gm0 >= 30) {
          fundScore += 1;
          fundDetails.push(`⚠️ Gross margin: %${gm0.toFixed(1)}`);
        } else {
          fundDetails.push(`❌ Gross margin düşük: %${gm0?.toFixed(1)}`);
        }
      }

      // EPS büyümesi
      const eps0 = income[0]?.eps;
      const eps1 = income[1]?.eps;
      if (eps0 !== null && eps1 !== null && eps0 > eps1) {
        fundScore += 1;
        fundDetails.push(`✅ EPS büyüyor: ${eps1?.toFixed(2)} → ${eps0?.toFixed(2)}`);
      } else if (eps0 > 0) {
        fundDetails.push(`⚠️ EPS pozitif ama büyümüyor: ${eps0?.toFixed(2)}`);
      } else {
        fundDetails.push(`❌ EPS negatif (şirket zarar ediyor)`);
      }
    }

    // ── Kurumsal sahiplik artışı ──
    if (institutionalData.status === 'fulfilled' && Array.isArray(institutionalData.value) && institutionalData.value.length >= 2) {
      const inst = institutionalData.value;
      const holdersNow  = inst[0]?.investors || 0;
      const holdersPrev = inst[1]?.investors || 0;
      if (holdersNow > holdersPrev) {
        fundScore += 1;
        fundDetails.push(`✅ Kurumsal yatırımcı artıyor: ${holdersPrev} → ${holdersNow}`);
      } else {
        fundDetails.push(`⚠️ Kurumsal sahiplik durağan/azalıyor`);
      }
    }

    // ── P/S oranı (ucuzluk) ──
    if (ratiosData.status === 'fulfilled' && ratiosData.value?.[0]) {
      const ps = ratiosData.value[0]?.priceToSalesRatioTTM;
      if (ps && ps < 5) {
        fundScore += 1;
        fundDetails.push(`✅ P/S oranı düşük: ${ps.toFixed(1)}x (ucuz büyüme hikayesi)`);
      } else if (ps) {
        fundDetails.push(`⚠️ P/S oranı: ${ps.toFixed(1)}x`);
      }
    }

    return { fundScore, fundDetails };
  } catch (e) {
    return { fundScore: 0, fundDetails: [`⚠️ Fundamental veri alınamadı: ${e.message}`] };
  }
}

// ─── ADIM 4: HİSSEYİ TOPLU DEĞERLENDİR ──────────────
async function analyzeStock(symbol) {
  const [tech, fund] = await Promise.all([
    getTechnical(symbol),
    getFundamentals(symbol)
  ]);

  if (!tech) return null;

  const totalScore = tech.techScore + fund.fundScore;

  // Karar
  let decision, badge;
  if (totalScore >= 7) {
    decision = 'GÜÇLÜ BÜYÜME';
    badge = '🚀';
  } else if (totalScore >= 5) {
    decision = 'BÜYÜME ADAYI';
    badge = '⭐';
  } else if (totalScore >= 3) {
    decision = 'İZLE';
    badge = '👀';
  } else {
    return null; // zayıf, gösterme
  }

  return {
    symbol,
    price: tech.price,
    decision,
    badge,
    totalScore,
    techScore: tech.techScore,
    fundScore: fund.fundScore,
    sma20: tech.sma20,
    sma50: tech.sma50,
    high52w: tech.high52w,
    low52w: tech.low52w,
    fromLow: tech.fromLow,
    perf3m: tech.perf3m,
    volTrend: tech.volTrend,
    techDetails: tech.techDetails,
    fundDetails: fund.fundDetails,
    timestamp: new Date().toISOString()
  };
}

// ─── ANA TARAMA ──────────────────────────────────────
async function runScan() {
  if (isScanning) { log('⚠️ Zaten taranıyor, atlandı'); return; }
  isScanning = true;
  const newSignals = [];

  try {
    log('═══════════════════════════════════════');
    log('🔍 Growth Hunter taraması başladı');

    const tickers = await getScreenedTickers();
    log(`📊 ${tickers.length} hisse taranacak`);

    // Rate limit — FMP ücretsiz plan için 300ms bekleme
    for (let i = 0; i < tickers.length; i++) {
      const sym = tickers[i];
      try {
        const result = await analyzeStock(sym);
        if (result) {
          newSignals.push(result);
          log(`${result.badge} [${result.decision}] ${sym} — $${result.price} — Skor: ${result.totalScore}/12`);
        } else {
          log(`  · ${sym} — kriter sağlanmadı`);
        }
      } catch (e) {
        log(`  ⚠️ ${sym} hata: ${e.message}`);
      }

      if (i < tickers.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Skora göre sırala
    newSignals.sort((a, b) => b.totalScore - a.totalScore);
    signals = newSignals;
    lastScan = new Date().toISOString();

    log('');
    log(`✅ Tarama tamamlandı: ${newSignals.length} aday bulundu`);
    log(`   🚀 GÜÇLÜ BÜYÜME: ${newSignals.filter(s => s.decision === 'GÜÇLÜ BÜYÜME').length}`);
    log(`   ⭐ BÜYÜME ADAYI:  ${newSignals.filter(s => s.decision === 'BÜYÜME ADAYI').length}`);
    log(`   👀 İZLE:          ${newSignals.filter(s => s.decision === 'İZLE').length}`);
    log('═══════════════════════════════════════');

  } catch (e) {
    log(`❌ Tarama hatası: ${e.message}`);
  } finally {
    isScanning = false;
  }
}

// ─── ZAMANLAYICI ─────────────────────────────────────
// Her gün ABD kapanışından sonra 23:30 TR saati
cron.schedule('30 23 * * 1-5', () => {
  log('⏰ Otomatik tarama başlatıldı (ABD kapanış sonrası)');
  runScan().catch(console.error);
}, { timezone: 'Europe/Istanbul' });

// ─── API ENDPOINTLER ─────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'Growth Hunter Bot çalışıyor 🚀',
    lastScan,
    isScanning,
    totalSignals: signals.length,
    breakdown: {
      strongGrowth: signals.filter(s => s.decision === 'GÜÇLÜ BÜYÜME').length,
      growthCandidate: signals.filter(s => s.decision === 'BÜYÜME ADAYI').length,
      watch: signals.filter(s => s.decision === 'İZLE').length
    }
  });
});

app.get('/signals', (req, res) => {
  let list = [...signals];

  if (req.query.filter === 'strong') {
    list = list.filter(s => s.decision === 'GÜÇLÜ BÜYÜME');
  } else if (req.query.filter === 'candidate') {
    list = list.filter(s => s.decision === 'BÜYÜME ADAYI');
  }

  res.json({
    lastScan,
    count: list.length,
    signals: list.slice(0, 100)
  });
});

app.get('/scan', async (req, res) => {
  if (isScanning) {
    return res.json({ message: 'Tarama devam ediyor, bekleyin...' });
  }
  res.json({ message: 'Growth Hunter taraması başlatıldı! Sonuçlar 5-10 dakikada gelir.' });
  runScan().catch(console.error);
});

app.get('/logs', (req, res) => {
  res.json({ logs: scanLog.slice(-50) });
});

// ─── BAŞLAT ──────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Growth Hunter Bot — Geleceğin NVIDIA'sı   ║
║   FMP tabanlı, hibrit teknik+fundamental     ║
║   Her gün 23:30 TR otomatik tarama          ║
╚══════════════════════════════════════════════╝
  `);
  // İlk açılışta 10 saniye sonra tara
  setTimeout(() => runScan().catch(console.error), 10000);
});
