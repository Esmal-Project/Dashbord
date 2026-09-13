'use strict';

/**
 * Static-site builder — makes the app deployable to GitHub Pages.
 *
 * GitHub Pages serves files only (no Node), so we:
 *   1. Copy public/ into dist/
 *   2. Generate api/*.json endpoints from data/live/ (real TSETMC snapshots
 *      fetched by the Actions runner) falling back to data/seed/ (demo data).
 *      The frontend can then fetch('./api/market-watch.json') with zero backend.
 *
 * The same structure also works unchanged under the Express server (server.js
 * can serve dist/ as-is), so preview and production stay identical.
 *
 * Usage: node scripts/build-static.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SEED_DIR = path.join(ROOT, 'data', 'seed');
const LIVE_DIR = path.join(ROOT, 'data', 'live');

const NOW = Date.now();

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(rel, obj) {
  const file = path.join(DIST, rel);
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ── Layered data: live snapshot → seed ──────────────────────────

function layer(key) {
  const live = readJsonSafe(path.join(LIVE_DIR, key + '.json'));
  if (live && typeof live.ts === 'number' && NOW - live.ts < 48 * 60 * 60 * 1000) {
    return { data: live.data, ts: live.ts, source: 'live-snapshot' };
  }
  const seed = readJsonSafe(path.join(SEED_DIR, key + '.json'));
  if (seed) {
    return { data: seed.data !== undefined ? seed.data : seed, ts: seed.ts || NOW, source: 'seed' };
  }
  return null;
}

// ── Copy the frontend ───────────────────────────────────────────

function copyPublic() {
  mkdirp(DIST);
  const src = path.join(ROOT, 'public');
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(DIST, name);
    if (fs.statSync(from).isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

// ── Generate static API JSON files ──────────────────────────────

function buildApi() {
  // /api/market-watch
  const mw = layer('marketwatch');
  if (mw) {
    const rows = Array.isArray(mw.data) ? mw.data : (mw.data && mw.data.marketwatch) || [];
    writeJson('api/market-watch.json', { marketwatch: rows, meta: { source: mw.source, ts: mw.ts } });
  }

  // /api/indices — merged TSE + Farabourse, same shape as server.js
  const tse = layer('indices_tse');
  const fbe = layer('indices_fbe');
  const tseRows = tse && Array.isArray(tse.data) ? tse.data : [];
  const fbeRows = fbe && Array.isArray(fbe.data) ? fbe.data : [];
  const meta = (tse || fbe || { source: 'seed', ts: NOW });
  writeJson('api/indices.json', {
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

  // /api/news — Codal announcements
  const codal = layer('codal');
  if (codal) {
    writeJson('api/news.json', { preparedData: codal.data, meta: { source: codal.source, ts: codal.ts } });
  }

  // 404 fallback for every other endpoint (quote/orderbook/client-type/daily/search)
  writeJson('api/_unavailable.json', {
    error: 'static-mode',
    detail: 'Per-symbol endpoints need the Node server or a relay; see README.',
  });
}

// ── 404.html (GitHub Pages serves it for unknown paths) ─────────

function build404() {
  fs.copyFileSync(path.join(DIST, 'index.html'), path.join(DIST, '404.html'));
}

// ── .nojekyll (skip Jekyll so files starting with _ are served) ──

function buildNojekyll() {
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
}

// ── Run ─────────────────────────────────────────────────────────

copyPublic();
buildApi();
build404();
buildNojekyll();

const apiFiles = fs.existsSync(path.join(DIST, 'api'))
  ? fs.readdirSync(path.join(DIST, 'api')) : [];
console.log('dist/ built: index.html + api/' + apiFiles.join(', '));
