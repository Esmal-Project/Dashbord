const https = require('https');

const UPSTREAM = 'https://cdn.tsetmc.com';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
};

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }

  // Support /api/tsetmc-proxy/... or similar based on route
  // The path being requested to TSETMC should be passed via a query parameter or path.
  // For simplicity, let's assume the frontend will send the target API path via a query parameter `path`
  // e.g. /api/tsetmc-proxy?path=/api/ClosingPrice/GetMarketWatch...

  const targetPath = req.query.path;

  if (!targetPath) {
    res.status(400).json({ error: 'Missing path query parameter' });
    return;
  }

  // Reconstruct full url, stripping any potential leading slash from query if not careful, though tsetmc paths start with /api/...
  const target = UPSTREAM + (targetPath.startsWith('/') ? targetPath : '/' + targetPath);

  const upReq = https.request(target, {
    method: 'GET',
    headers: BROWSER_HEADERS,
    timeout: 8000,
  }, (upRes) => {
    res.setHeader('Content-Type', upRes.headers['content-type'] || 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(upRes.statusCode);
    upRes.pipe(res);
  });

  upReq.on('timeout', () => upReq.destroy(new Error('timeout')));

  upReq.on('error', (e) => {
    console.error('Proxy Error:', e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'relay error', detail: e.message });
    }
  });

  upReq.end();
}
