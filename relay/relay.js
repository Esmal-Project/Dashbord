'use strict';

/**
 * TSETMC Relay — run this on ANY server with an Iranian IP
 * (or any IP that TSETMC allows). Zero dependencies.
 *
 *   node relay.js                  # listens on 0.0.0.0:8787
 *   PORT=9000 node relay.js        # custom port
 *   RELAY_SECRET=mytoken node relay.js   # require ?key=mytoken on every call
 *
 * Then set this env var on the Freebuff deployment:
 *   TSETMC_RELAY=http://<relay-ip>:8787
 * and every TSETMC call goes through the relay automatically.
 *
 * Local test endpoint: /relay-health (does NOT hit TSETMC).
 */

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8787;
const UPSTREAM = 'https://cdn.tsetmc.com';
const SECRET = process.env.RELAY_SECRET || '';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
};

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  if (req.url === '/relay-health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, secret: SECRET ? 'on' : 'off' }));
    return;
  }

  if (SECRET) {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('key') !== SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  const target = UPSTREAM + req.url;
  const upReq = https.request(target, {
    method: 'GET',
    headers: BROWSER_HEADERS,
    timeout: 8000,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, {
      'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    upRes.pipe(res);
    console.log(new Date().toISOString(), req.url, '->', upRes.statusCode);
  });
  upReq.on('timeout', () => upReq.destroy(new Error('timeout')));
  upReq.on('error', (e) => {
    console.error(new Date().toISOString(), req.url, 'ERR', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'relay error', detail: e.message }));
  });
  upReq.end();
}).listen(PORT, '0.0.0.0', () => {
  console.log('TSETMC relay listening on 0.0.0.0:' + PORT + ' -> ' + UPSTREAM);
});
