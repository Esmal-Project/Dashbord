'use strict';

/**
 * BourseMag — TSETMC proxy with resilient fallbacks
 *
 * Reality: TSETMC blocks most non-Iranian IPs. So this server:
 *   1. Tries live TSETMC (correct cdn.tsetmc.com endpoints + full browser headers).
 *   2. On failure, serves the last known good payload from disk cache (24h).
 *   3. On first-ever failure, serves a bundled seed snapshot so the UI is never empty.
 * Every response reports its freshness: { meta: { source: 'live' | 'cache' | 'seed', ts } }.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const TSETMC_BASE = process.env.TSETMC_RELAY || 'https://cdn.tsetmc.com';
// If TSETMC_RELAY is set (e.g. 'http://5.xxx.xxx.xxx:8787' — host only, no path),
// all upstream calls go through that relay, which forwards them to cdn.tsetmc.com.
// See relay/relay.js — a tiny zero-dependency script to run on any Iranian server.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
};

const CACHE_DIR = path.join(__dirname, '.cache');
const SEED_DIR = path.join(__dirname, 'data', 'seed');
const LIVE_DIR = path.join(__dirname, 'data', 'live');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // serve last-known data up to 24h old
const OUT_TTL_MS = 20 * 1000; // don't hit upstream more often than this per key
const LIVE_STALE_MS = 2 * 60 * 60 * 1000; // trust GitHub-Actions snapshots up to 2h old

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

const memCache = new Map(); // key -> { data, ts, source }

// Circuit breaker: skip upstream attempts for a while after repeated failures
let upstreamFails = 0;
let upstreamOpenUntil = 0;
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60 * 1000;

// ─────────────────────────────────────────────────────────────
// TSETMC upstream fetch (gzip-aware, timeout-bounded)
// ─────────────────────────────────────────────────────────────

function tsetmcFetch(apiPath, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const mod = TSETMC_BASE.startsWith('http://') ? require('http') : https;
    let reqPath = apiPath;
    if (process.env.RELAY_SECRET && TSETMC_BASE !== 'https://cdn.tsetmc.com') {
      reqPath += (reqPath.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(process.env.RELAY_SECRET);
    }
    const req = mod.request(TSETMC_BASE + reqPath, {
      headers: BROWSER_HEADERS,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('TSETMC ' + res.statusCode));
        return;
      }
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const gz = zlib.createGunzip();
        res.pipe(gz);
        stream = gz;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        size += c.length;
        if (size > 30 * 1024 * 1024) {
          req.destroy();
          reject(new Error('payload too large'));
        } else {
          chunks.push(c);
        }
      });
      stream.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_) {
          reject(new Error('bad json from TSETMC'));
        }
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// Cache + seed layer
// ─────────────────────────────────────────────────────────────

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function cacheFile(key) {
  return path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
}

function readCache(key) {
  if (memCache.has(key)) {
    const m = memCache.get(key);
    if (Date.now() - m.ts < CACHE_TTL_MS) return m;
  }
  const disk = readJsonSafe(cacheFile(key));
  if (disk && disk.ts && Date.now() - disk.ts < CACHE_TTL_MS) {
    memCache.set(key, disk);
    return disk;
  }
  return null;
}

function writeCache(key, data) {
  const entry = { data, ts: Date.now(), source: 'cache' };
  memCache.set(key, entry);
  try { fs.writeFileSync(cacheFile(key), JSON.stringify(entry)); } catch (_) {}
}

function readSeed(key) {
  return readJsonSafe(path.join(SEED_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'));
}

// GitHub-Actions snapshot files (data/live/*.json) — real TSETMC data,
// refreshed every 15 min by the workflow.
function readLiveSnapshot(key) {
  const f = readJsonSafe(path.join(LIVE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'));
  if (!f || typeof f.ts !== 'number') return null;
  return f;
}

// Try upstream; fall back to cache, then seed.
async function fetchWithFallback(key, apiPath, ttlMs = OUT_TTL_MS) {
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && now - mem.ts < ttlMs) {
    return { payload: mem.data, source: mem.source, ts: mem.ts };
  }
  if (now < upstreamOpenUntil) {
    // breaker open: go straight to fallbacks
    const live = readLiveSnapshot(key);
    if (live && now - live.ts < LIVE_STALE_MS) return { payload: live.data, source: 'live-snapshot', ts: live.ts };
    const cached0 = readCache(key);
    if (cached0) return { payload: cached0.data, source: 'cache', ts: cached0.ts };
    const seed0 = readSeed(key);
    if (seed0) return { payload: seed0.data !== undefined ? seed0.data : seed0, source: 'seed', ts: seed0.ts || 0 };
    throw new Error('upstream unavailable (circuit open)');
  }
  try {
    const data = await tsetmcFetch(apiPath);
    upstreamFails = 0;
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
    const unwrapped = keys.length === 1 ? data[keys[0]] : data;
    writeCache(key, unwrapped);
    return { payload: unwrapped, source: 'live', ts: now };
  } catch (upstreamErr) {
    upstreamFails++;
    if (upstreamFails >= BREAKER_THRESHOLD) {
      upstreamOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      upstreamFails = 0;
    }
    // 1) GitHub-Actions live snapshot (real data, refreshed every 15 min)
    const live = readLiveSnapshot(key);
    if (live && Date.now() - live.ts < LIVE_STALE_MS) {
      return { payload: live.data, source: 'live-snapshot', ts: live.ts };
    }
    // 2) Runtime disk cache (last successful upstream call)
    const cached = readCache(key);
    if (cached) {
      return { payload: cached.data, source: 'cache', ts: cached.ts };
    }
    // 3) Demo seed data (synthetic)
    const seed = readSeed(key);
    if (seed) {
      return { payload: seed.data !== undefined ? seed.data : seed, source: 'seed', ts: seed.ts || 0 };
    }
    throw upstreamErr;
  }
}

// ─────────────────────────────────────────────────────────────
// Demo detail generator (only used when neither live, cache, nor
// per-key seed exists). Data is synthetic but consistent with the
// seeded market watch rows, and always labeled source:'seed'.
// ─────────────────────────────────────────────────────────────

function seedMarketRows() {
  const raw = readSeed('marketwatch');
  const arr = raw && raw.data ? raw.data : [];
  return Array.isArray(arr) ? arr : [];
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashInsCode(insCode) {
  let h = 0;
  const s = String(insCode);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function demoDetail(insCode) {
  const row = seedMarketRows().find(r => String(r.insCode) === String(insCode));
  if (!row) return null;
  const rnd = mulberry32(hashInsCode(insCode));
  const p = row.pClosing || 1000;
  const y = row.priceYesterday || Math.round(p * 0.98);

  const quote = {
    insCode: row.insCode, lVal18AFC: row.lVal18AFC, lVal30: row.lVal30,
    cValMne: row.lVal18AFC, flow: row.flow || 1,
    pClosing: p, pDrCotVal: p, priceYesterday: y,
    priceFirst: row.priceFirst || p, priceMin: row.priceMin || p, priceMax: row.priceMax || p,
    qTotTran5J: row.qTotTran5J || 0, qTotCap: row.qTotCap || 0, zTotTran: row.zTotTran || 0,
    baseVol: row.baseVol || 1,
    eps: { estimatedEPS: Math.round(p / (8 + rnd() * 14)) },
    pe: { sectorPE: Number((5 + rnd() * 15).toFixed(1)) },
  };

  const step = Math.max(1, Math.round(p * 0.002));
  const bestLimits = [];
  for (let i = 1; i <= 5; i++) {
    bestLimits.push({ number: i, pMeDem: p - step * i, qTitMeDem: Math.round((100 + rnd() * 900) * 1000), zOrdMeDem: 1 + Math.floor(rnd() * 40) });
    bestLimits.push({ number: i, pMeOf: p + step * i, qTitMeOf: Math.round((100 + rnd() * 900) * 1000), zOrdMeOf: 1 + Math.floor(rnd() * 40) });
  }

  const vol = row.qTotTran5J || 1000000;
  const clientType = {
    buy_I_Volume: Math.round(vol * (0.55 + rnd() * 0.3)),
    buy_N_Volume: 0, sell_I_Volume: 0, sell_N_Volume: 0,
    buy_CountI: Math.round((row.zTotTran || 100) * 0.8), buy_CountN: 0,
  };
  clientType.buy_N_Volume = Math.max(0, vol - clientType.buy_I_Volume);
  clientType.sell_I_Volume = Math.round(vol * (0.45 + rnd() * 0.35));
  clientType.sell_N_Volume = Math.max(0, vol - clientType.sell_I_Volume);

  const daily = [];
  let walk = Math.round(p * 0.9);
  const today = new Date();
  for (let i = 29; i >= 1; i--) {
    walk = Math.max(1, walk * (0.985 + rnd() * 0.03));
    const d = new Date(today.getTime() - i * 86400000);
    daily.push({ dEven: Number(d.toISOString().slice(0, 10).replace(/-/g, '')), pClosing: Math.round(walk), pDrCotVal: Math.round(walk) });
  }
  daily.push({ dEven: Number(today.toISOString().slice(0, 10).replace(/-/g, '')), pClosing: p, pDrCotVal: p });

  return { quote, bestLimits, clientType, daily };
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ── Market watch (all symbols) ──
app.get('/api/market-watch', async (req, res) => {
  try {
    const r = await fetchWithFallback('marketwatch',
      '/api/ClosingPrice/GetMarketWatch?market=0&withBestLimits=false&hEven=0&RefID=0');
    const rows = Array.isArray(r.payload) ? r.payload : (r.payload && r.payload.marketwatch) || [];
    res.json({ marketwatch: rows, meta: { source: r.source, ts: r.ts } });
  } catch (e) {
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Market overview (index values + market state) ──
app.get('/api/overview', async (req, res) => {
  try {
    const r = await fetchWithFallback('overview', '/api/MarketData/GetMarketOverview/1');
    res.json({ overview: r.payload, meta: { source: r.source, ts: r.ts } });
  } catch (e) {
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Selected indices (7 TSE + 6 Farabourse) ──
app.get('/api/indices', async (req, res) => {
  try {
    const [tse, fbe] = await Promise.all([
      fetchWithFallback('indices_tse', '/api/Index/GetIndexB1LastAll/SelectedIndexes/1').catch(() => null),
      fetchWithFallback('indices_fbe', '/api/Index/GetIndexB1LastAll/SelectedIndexes/2').catch(() => null),
    ]);
    const tseRows = tse && Array.isArray(tse.payload) ? tse.payload : [];
    const fbeRows = fbe && Array.isArray(fbe.payload) ? fbe.payload : [];
    const meta = tse || fbe || { source: 'seed', ts: 0 };
    res.json({
      indices: [...tseRows, ...fbeRows].map((x) => ({
        insCode: x.insCode,
        name: x.lVal30,
        value: x.xDrNivJIdx004,
        changeAbs: x.indexChange,
        changePct: x.xVarIdxJRfV,
        time: x.hEven,
      })),
      meta: { source: meta.source, ts: meta.ts },
    });
  } catch (e) {
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Single quote ──
app.get('/api/quote/:insCode', async (req, res) => {
  try {
    const r = await fetchWithFallback('quote_' + req.params.insCode,
      '/api/ClosingPrice/GetClosingPriceInfo/' + encodeURIComponent(req.params.insCode));
    if (r.source !== 'seed') {
      return res.json({ closingPriceInfo: r.payload, meta: { source: r.source, ts: r.ts } });
    }
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ closingPriceInfo: d.quote, meta: { source: 'seed', ts: Date.now() } });
    return res.status(502).json({ error: 'upstream unavailable', detail: 'quote not found' });
  } catch (e) {
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ closingPriceInfo: d.quote, meta: { source: 'seed', ts: Date.now() } });
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Order book ──
app.get('/api/orderbook/:insCode', async (req, res) => {
  try {
    const r = await fetchWithFallback('ob_' + req.params.insCode,
      '/api/BestLimits/' + encodeURIComponent(req.params.insCode));
    if (r.source !== 'seed') {
      return res.json({ bestLimits: r.payload, meta: { source: r.source, ts: r.ts } });
    }
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ bestLimits: d.bestLimits, meta: { source: 'seed', ts: Date.now() } });
    return res.status(502).json({ error: 'upstream unavailable', detail: 'order book not found' });
  } catch (e) {
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ bestLimits: d.bestLimits, meta: { source: 'seed', ts: Date.now() } });
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Client type (money flow) ──
app.get('/api/client-type/:insCode', async (req, res) => {
  try {
    const r = await fetchWithFallback('ct_' + req.params.insCode,
      '/api/ClientType/GetClientType/' + encodeURIComponent(req.params.insCode) + '/1/0');
    if (r.source !== 'seed') {
      return res.json({ clientType: r.payload, meta: { source: r.source, ts: r.ts } });
    }
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ clientType: d.clientType, meta: { source: 'seed', ts: Date.now() } });
    return res.status(502).json({ error: 'upstream unavailable', detail: 'client type not found' });
  } catch (e) {
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ clientType: d.clientType, meta: { source: 'seed', ts: Date.now() } });
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Daily history ──
app.get('/api/daily/:insCode/:top', async (req, res) => {
  try {
    const top = Math.min(parseInt(req.params.top, 10) || 30, 500);
    const r = await fetchWithFallback('daily_' + req.params.insCode + '_' + top,
      '/api/ClosingPrice/GetClosingPriceDailyList/' + encodeURIComponent(req.params.insCode) + '/' + top);
    if (r.source !== 'seed') {
      return res.json({ closingPriceDaily: r.payload, meta: { source: r.source, ts: r.ts } });
    }
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ closingPriceDaily: d.daily, meta: { source: 'seed', ts: Date.now() } });
    return res.status(502).json({ error: 'upstream unavailable', detail: 'history not found' });
  } catch (e) {
    const d = demoDetail(req.params.insCode);
    if (d) return res.json({ closingPriceDaily: d.daily, meta: { source: 'seed', ts: Date.now() } });
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Search ──
app.get('/api/search/:query', async (req, res) => {
  try {
    const r = await fetchWithFallback('search',
      '/api/Instrument/GetInstrumentSearch/' + encodeURIComponent(req.params.query), 5 * 60 * 1000);
    res.json({ instrumentSearch: r.payload, meta: { source: r.source, ts: r.ts } });
  } catch (e) {
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Codal news/announcements ──
app.get('/api/news', async (req, res) => {
  try {
    const r = await fetchWithFallback('codal', '/api/Codal/GetPreparedData/15');
    res.json({ preparedData: r.payload, meta: { source: r.source, ts: r.ts } });
  } catch (e) {
    res.status(502).json({ error: 'upstream unavailable', detail: e.message });
  }
});

// ── Config (frontend live-relay detection) ──
// On static hosting the build writes api/config.json; here we expose the same
// shape from env so preview + deploy behave identically.
app.get('/api/config', (req, res) => {
  const cfg = relayConfig();
  res.json(cfg);
});

// env wins; otherwise fall back to the committed relay-config.json
function relayConfig() {
  let file = { relay: '', relayKey: '' };
  try {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay-config.json'), 'utf8'));
    file = { relay: f.relay || '', relayKey: f.relayKey || '' };
  } catch (_) { /* optional file */ }
  const relay = (process.env.TSETMC_RELAY || file.relay || '').trim().replace(/\/$/, '');
  const relayKey = (process.env.PUBLIC_RELAY_KEY || file.relayKey || '').trim();
  if (!relay || relay.startsWith('https://cdn.tsetmc.com')) return { relay: '', relayKey: '' };
  return { relay, relayKey };
}

// ── Health ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.listen(PORT, HOST, () => {
  console.log('BourseMag server listening on http://' + HOST + ':' + PORT);
});
