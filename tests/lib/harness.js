// Playwright harness: serves ../public through request interception and mocks
// the /api endpoints (credits, consume with signed sessions, checkout).
// No network access is needed: everything the editor loads is local.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'public');
const ORIGIN = 'http://folio.test';
const FREE = 2;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp',
};

async function setup(opts = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const state = {
    credits: opts.credits ?? 0, free_used: opts.free_used ?? 0, lifetime: !!opts.lifetime,
    consumeCalls: 0, checkoutCalls: 0, charges: 0, rateLimit: false,
  };

  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      const send = (obj, status = 200) => route.fulfill({
        status, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj),
      });
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      }
      if (url.pathname === '/api/status') {
        return send({ uid: url.searchParams.get('uid'), credits: state.credits, free_used: state.free_used,
          freeRemaining: Math.max(0, FREE - state.free_used), lifetime_free: state.lifetime });
      }
      if (url.pathname === '/api/consume') {
        state.consumeCalls++;
        if (state.rateLimit) return send({ ok: false, reason: 'rate_limited' }, 429);
        const body = JSON.parse(route.request().postData() || '{}');
        const expected = `tok.${body.uid}.${body.docKey}`;
        if (body.docKey && body.session === expected) return send({ ok: true, sessionValid: true });
        const tok = body.docKey ? { session: expected, sessionExpires: Date.now() + 12 * 3600e3 } : {};
        if (state.lifetime) return send({ ok: true, creditsLeft: state.credits, usedLifetimeFree: true, ...tok });
        if (state.free_used < FREE) {
          state.free_used++; state.charges++;
          return send({ ok: true, creditsLeft: state.credits, usedFree: true, freeRemaining: FREE - state.free_used, ...tok });
        }
        if (state.credits > 0) {
          state.credits--; state.charges++;
          return send({ ok: true, creditsLeft: state.credits, usedFree: false, ...tok });
        }
        return send({ ok: false, reason: 'no_credits', creditsLeft: 0 });
      }
      if (url.pathname === '/api/checkout') {
        state.checkoutCalls++;
        if (state.lifetime) return send({ error: 'already_lifetime' }, 409);
        return send({ url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
      }
      return send({ error: 'not found' }, 404);
    }
    if (url.hostname === 'folio.test') {
      const rel = url.pathname.replace(/^\/+/, '') || 'index.html';
      const file = path.join(PUB, rel);
      if (file.startsWith(PUB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      return route.fulfill({ status: 404, body: 'not found ' + rel });
    }
    if (url.hostname.includes('fonts.g')) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.abort();
  });

  const page = await context.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  return { browser, context, page, logs, state };
}

module.exports = { setup, ORIGIN };
