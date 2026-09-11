const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds for live data
const CACHE_TTL_LONG = 300_000; // 5 minutes for search/instruments

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Evict old entries periodically
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL_LONG * 2) cache.delete(k);
    }
  }
}

// Proxy fetch helper
function tsetmcFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'cdn.tsetmc.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://cdn.tsetmc.com/',
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch {
            // Check for block page
            if (body.includes('مسدود') || body.includes('دسترسی')) {
              reject(new Error('BLOCKED'));
            } else {
              reject(new Error('PARSE_ERROR'));
            }
          }
        } else if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error('BLOCKED'));
        } else {
          reject(new Error(`HTTP_${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.end();
  });
}

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──

// Market watch — all symbols with prices
app.get('/api/market-watch', async (req, res) => {
  try {
    const cacheKey = 'market-watch';
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(
      '/api/ClosingPrice/GetMarketWatch?market=0&paperTypes[0]=1&paperTypes[1]=2&paperTypes[2]=3&paperTypes[3]=4&paperTypes[4]=5&paperTypes[5]=6&paperTypes[6]=7&paperTypes[7]=8&paperTypes[8]=9&withBestLimits=false&hEven=0&RefID=0'
    );
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Single quote by instrument code
app.get('/api/quote/:insCode', async (req, res) => {
  try {
    const { insCode } = req.params;
    const cacheKey = `quote-${insCode}`;
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/ClosingPrice/GetClosingPriceInfo/${insCode}`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Best limits / order book
app.get('/api/orderbook/:insCode', async (req, res) => {
  try {
    const { insCode } = req.params;
    const cacheKey = `orderbook-${insCode}`;
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/BestLimits/${insCode}`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Client type (real vs legal money flow)
app.get('/api/client-type/:insCode', async (req, res) => {
  try {
    const { insCode } = req.params;
    const cacheKey = `clienttype-${insCode}`;
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/ClientType/GetClientType/${insCode}/1/0`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Search symbols
app.get('/api/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const cacheKey = `search-${query}`;
    const cached = getCached(cacheKey, CACHE_TTL_LONG);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/Instrument/GetInstrumentSearch/${encodeURIComponent(query)}`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Market overview (indices)
app.get('/api/market-overview/:flow?', async (req, res) => {
  try {
    const flow = req.params.flow || '1';
    const cacheKey = `overview-${flow}`;
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/MarketData/GetMarketOverview/${flow}`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Daily history for charts
app.get('/api/daily/:insCode/:top?', async (req, res) => {
  try {
    const { insCode, top } = req.params;
    const cacheKey = `daily-${insCode}-${top || '30'}`;
    const cached = getCached(cacheKey, CACHE_TTL_LONG);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch(`/api/ClosingPrice/GetClosingPriceDailyList/${insCode}/${top || '30'}`);
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Client type all
app.get('/api/client-type-all', async (req, res) => {
  try {
    const cacheKey = 'client-type-all';
    const cached = getCached(cacheKey, CACHE_TTL);
    if (cached) return res.json(cached);

    const data = await tsetmcFetch('/api/ClientType/GetClientTypeAll');
    setCache(cacheKey, data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fallback — serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BourseMag server running on port ${PORT}`);
});
