/**
 * Cloudflare Worker for TSETMC Proxy
 * Deploy this script on Cloudflare Workers and set your TSETMC_RELAY in your project
 * to the worker's URL (e.g. https://your-worker.your-subdomain.workers.dev).
 */

const UPSTREAM = 'https://cdn.tsetmc.com';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  'Referer': 'https://www.tsetmc.com/',
  'Origin': 'https://www.tsetmc.com',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Proxy the request to TSETMC
    // The request url pathname is used directly. E.g., /api/ClosingPrice/GetMarketWatch
    const targetUrl = UPSTREAM + url.pathname + url.search;

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: BROWSER_HEADERS,
      });

      // Clone the response so we can modify headers
      const newResponse = new Response(response.body, response);
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      return newResponse;

    } catch (e) {
      return new Response(JSON.stringify({ error: 'relay error', detail: e.message }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
