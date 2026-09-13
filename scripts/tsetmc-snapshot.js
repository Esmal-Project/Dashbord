'use strict';

/**
 * TSETMC snapshot fetcher — runs in GitHub Actions (their IPs can reach TSETMC).
 * Zero dependencies. Writes { data, ts } JSON files into data/live/.
 *
 * Usage: node scripts/tsetmc-snapshot.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const BASE = 'https://cdn.tsetmc.com';
const OUT = path.join(__dirname, '..', 'data', 'live');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
};

function fetchJson(apiPath, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.request(BASE + apiPath, { headers: HEADERS, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' ' + apiPath)); return; }
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') { const gz = zlib.createGunzip(); res.pipe(gz); stream = gz; }
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function unwrap(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (keys.length === 1) return data[keys[0]];
  }
  return data;
}

async function snapshot(key, apiPath) {
  try {
    const data = unwrap(await fetchJson(apiPath));
    const file = path.join(OUT, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    fs.writeFileSync(file, JSON.stringify({ data, ts: Date.now() }));
    console.log('OK  ', key, JSON.stringify(data).length, 'bytes');
    return true;
  } catch (e) {
    console.error('FAIL', key, e.message);
    return false;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];

  // 1) Market watch — the big one
  results.push(await snapshot('marketwatch',
    '/api/ClosingPrice/GetMarketWatch?market=0&withBestLimits=false&hEven=0&RefID=0'));

  // 2) Selected indices (TSE + Farabourse)
  results.push(await snapshot('indices_tse', '/api/Index/GetIndexB1LastAll/SelectedIndexes/1'));
  results.push(await snapshot('indices_fbe', '/api/Index/GetIndexB1LastAll/SelectedIndexes/2'));

  // 3) Codal announcements
  results.push(await snapshot('codal', '/api/Codal/GetPreparedData/15'));

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} snapshots succeeded`);
  process.exit(ok > 0 ? 0 : 1);
})();
