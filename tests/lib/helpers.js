// Shared helpers for the end-to-end suites.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { setup, ORIGIN } = require('./harness');

const ROOT = path.join(__dirname, '..');
const PDFS = path.join(ROOT, 'fixtures', 'pdfs');
const TABLES = path.join(ROOT, 'fixtures', 'tables');
const OUT = path.join(ROOT, '.output');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) { failures++; process.exitCode = 1; }
  return cond;
}

// PDF > 3.5 MB (sessionStorage quota) generated on demand instead of being committed
async function bigPdf() {
  const file = path.join(OUT, '02_big.pdf');
  if (fs.existsSync(file)) return file;
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([595.28, 841.89]).drawText(`Big file page ${i}`, { x: 72, y: 760, size: 14, font });
  await doc.attach(crypto.randomBytes(6 * 1024 * 1024), 'noise.bin', { mimeType: 'application/octet-stream' });
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function openFile(page, file, password) {
  await page.setInputFiles('#mainFileInput', file);
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({
      pw: !!document.getElementById('folio-pw-modal'),
      loading: !document.getElementById('loadingOverlay').classList.contains('hidden'),
      toast: document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').textContent : '',
    }));
    if (st.pw) {
      if (password === undefined) return 'PASSWORD-PROMPT';
      await page.fill('#folioPwInput', password);
      await page.click('#folioPwOk');
      password = undefined;
      continue;
    }
    if (!st.loading && st.toast) return st.toast;
  }
  return 'TIMEOUT';
}

async function start(file, opts = {}) {
  const ctx = await setup(opts);
  await ctx.page.goto(ORIGIN + '/web-editor.html' + (opts.query || ''));
  await ctx.page.waitForTimeout(300);
  if (file) ctx.toast = await openFile(ctx.page, path.isAbsolute(file) ? file : path.join(PDFS, file), opts.password);
  return ctx;
}

async function waitIdle(page, ms = 150) {
  await page.waitForFunction(() => document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 60000 });
  await page.waitForTimeout(ms);
}

async function download(page, selector, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(selector)]);
  const p = path.join(OUT, name || dl.suggestedFilename());
  await dl.saveAs(p);
  await waitIdle(page);
  return { p, name: dl.suggestedFilename() };
}

async function exportPdf(page, name, selector = '#btnExport') {
  return (await download(page, selector, name)).p;
}

// Renders a PDF inside the page with PDF.js; returns colours at page-unit points,
// fractions of pixels near a colour in rectangles, and the extracted text.
async function sampleExport(page, file, pageNum, points, pw, regions = []) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async ({ b64, pageNum, points, pw, regions }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({ data: bytes, password: pw, isEvalSupported: false,
      cMapUrl: new URL('lib/pdfjs/cmaps/', location.href).href, cMapPacked: true,
      standardFontDataUrl: new URL('lib/pdfjs/standard_fonts/', location.href).href }).promise;
    const p = await doc.getPage(pageNum);
    const vp = p.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const ctx = c.getContext('2d');
    const text = (await p.getTextContent()).items.map(i => i.str).join(' ');
    const hex = d => '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const colors = points.map(([x, y]) => hex(ctx.getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data));
    const stats = regions.map(([r, h, tol]) => {
      const d = ctx.getImageData(Math.round(r.x * 2), Math.round(r.y * 2), Math.max(1, Math.round(r.w * 2)), Math.max(1, Math.round(r.h * 2))).data;
      const t = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
      let n = 0, m = 0;
      for (let i = 0; i < d.length; i += 4) { n++; if (Math.hypot(d[i] - t[0], d[i + 1] - t[1], d[i + 2] - t[2]) < tol) m++; }
      return m / n;
    });
    return { colors, stats, text, pages: doc.numPages, size: [vp.width / 2, vp.height / 2] };
  }, { b64, pageNum, points, pw, regions });
}

function colorDist(a, b) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const A = p(a), B = p(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

async function pu2client(page, x, y) {
  return page.evaluate(([x, y]) => { const r = pdfCanvas.getBoundingClientRect(); return [r.left + x * viewScale(), r.top + y * viewScale()]; }, [x, y]);
}

async function drag(page, a, b, steps = 8) {
  const A = await pu2client(page, ...a), B = await pu2client(page, ...b);
  await page.mouse.move(...A); await page.mouse.down(); await page.mouse.move(...B, { steps }); await page.mouse.up();
  await page.waitForTimeout(150);
}

function pageErrors(logs) {
  return logs.filter(l => /pageerror|\[error\]/.test(l));
}

module.exports = {
  ORIGIN, PDFS, TABLES, OUT, setup, start, openFile, waitIdle, download, exportPdf, sampleExport,
  colorDist, check, bigPdf, pu2client, drag, pageErrors, failures: () => failures,
};
