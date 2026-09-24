// ── Folio PDF Studio — web-editor.js ─────────────────────────────────────────
// Web version of editor.js — no chrome.* APIs.
// Features: text edit (cover adapted to the page background), form fill
// (AcroForm text / checkbox / radio / list + free text anywhere), signature
// (draw/text/image), annotations (highlight, box, pen, text, cover, erase),
// extract, merge, convert.
// Must be loaded AFTER web-payment.js.
//
// Coordinate model
//   Every object (edited text, field, signature, annotation) is stored in
//   "page units" (pu): the page as displayed at scale 1 (PDF points, origin
//   top-left, y down, page rotation applied). Screen px = pu × zoom × 1.5.
//   → zooming never moves anything, and export converts pu to the PDF user
//   space with the page's own viewport (rotation, CropBox offsets handled).
//
// Opening robustness
//   ArrayBuffer loading (no size limit), password prompt, decryption of
//   protected PDFs, repair of damaged/truncated files, and a raster export
//   fallback when a PDF can be displayed but not rewritten.

'use strict';

// ── Récupération sécurisée de canEdit ────────────────────────────────────────
// web-payment.js (chargé avant) stocke la vraie fonction sous une clé Symbol.
const _canEdit = (() => {
  const key = WebPayment._editKey;
  const fn  = window[key];
  delete window[key];
  return fn || (async () => false);
})();
// ─────────────────────────────────────────────────────────────────────────────

// ── Libraries / constants ────────────────────────────────────────────────────
const LIB_BASE   = new URL('lib/', location.href).href;
const BASE_SCALE = 1.5;          // 1 pu = 1.5 CSS px at 100 % zoom
const LINE_HEIGHT = 1.2;
const BASELINE_RATIO = 0.93;     // first baseline offset inside a 1.2 line box
const FIELD_PAD  = 2;            // pu

pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_BASE + 'pdf.worker.min.js';

const PDFJS_OPTS = {
  cMapUrl: LIB_BASE + 'pdfjs/cmaps/',            // CJK / non-embedded CMaps
  cMapPacked: true,
  standardFontDataUrl: LIB_BASE + 'pdfjs/standard_fonts/',
  isEvalSupported: false,                        // CVE-2024-4367 (malicious fonts)
  fontExtraProperties: true,                     // isSerifFont / isMonospace for font matching
  stopAtErrors: false,
};

const PDFLIB_LOAD_OPTS = { ignoreEncryption: true, throwOnInvalidObject: false, capNumbers: true, updateMetadata: false };

const MODES = ['edit', 'form', 'sign', 'merge', 'extract', 'annotate', 'convert'];

// ── State ─────────────────────────────────────────────────────────────────────
let pdfDoc         = null;   // PDF.js document (on workBytes)
let workBytes      = null;   // bytes used for display + export (decrypted / repaired if needed)
let originalBytes  = null;   // bytes as opened by the user
let pdfLibDoc      = null;   // pdf-lib doc (null → raster export)
let exportMode     = 'native';
let currentPage    = 1;
let totalPages     = 0;
let zoom           = 1.0;
let currentMode    = 'edit';
let fileName       = 'document.pdf';
let loadSeq        = 0;
let dirtySinceExport = false;

const pageCache    = new Map(); // page → { blocks, fields, blocksPromise, fieldsPromise }
let textEdits      = new Map(); // blockKey → edit
let signatures     = [];        // { id, page, x, y, w, h, dataURL }
let annotations    = [];        // { id, page, type, ... }
let selectedBlockKey = null;
let draftEdit      = null;
let activeFieldKey = null;
let activeSigId    = null;
let formClickActive = false;
let annotTool      = 'highlight';
let idSeq          = 0;

let mergeFiles     = [];
let selExtract     = new Set();
let convertFmt     = 'jpg';
let sigMode        = 'draw';
let sigImgData     = null;
let sigCanvas, sigCtx, sigIsDrawing = false, sigHasInk = false;

// Rendering
let baseCanvas = document.createElement('canvas');  // pristine render of the current page
let basePr     = 1;                                  // canvas px per CSS px
let renderTask = null;
let renderSeq  = 0;

const $ = id => document.getElementById(id);
const viewScale = () => zoom * BASE_SCALE;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nextId = prefix => `${prefix}-${Date.now().toString(36)}-${(++idSeq).toString(36)}`;

// ── Toast / Loading ───────────────────────────────────────────────────────────
function webEditorToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), type === 'error' ? 5000 : 3200);
}
window.webEditorToast = webEditorToast; // alias for web-payment.js

function showLoading(msg = 'Loading…') {
  $('loadingText').textContent = msg;
  $('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════════════════
// COLORS
// ═══════════════════════════════════════════════════════════════════════════
function parseHex(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function toHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function rgbLib(hex) {
  const c = parseHex(hex);
  return PDFLib.rgb(c.r / 255, c.g / 255, c.b / 255);
}
function rgbaCss(hex, alpha) {
  const c = parseHex(hex);
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}
function luminance(hex) {
  const c = parseHex(hex);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function contrastColor(bg) { return luminance(bg) < 0.4 ? '#ffffff' : '#000000'; }
function ensureContrast(color, bg, min = 3) {
  return contrastRatio(color, bg) >= min ? color : contrastColor(bg);
}

// Samples the pristine render of the current page.
// Returns { bg, fg, bgLum } — bg = dominant color around/inside the rect,
// fg = dominant "ink" color inside the rect (text color).
function sampleRegion(rect, ring = 3) {
  const fallback = { bg: '#ffffff', fg: '#000000', bgLum: 1 };
  if (!baseCanvas.width || !rect) return fallback;
  const k  = basePr * viewScale();
  const x0 = clamp(Math.floor((rect.x - ring) * k), 0, baseCanvas.width - 1);
  const y0 = clamp(Math.floor((rect.y - ring) * k), 0, baseCanvas.height - 1);
  const x1 = clamp(Math.ceil((rect.x + rect.w + ring) * k), x0 + 1, baseCanvas.width);
  const y1 = clamp(Math.ceil((rect.y + rect.h + ring) * k), y0 + 1, baseCanvas.height);
  const w = x1 - x0, h = y1 - y0;
  let data;
  try { data = baseCanvas.getContext('2d').getImageData(x0, y0, w, h).data; }
  catch { return fallback; }

  const ix0 = (rect.x * k) - x0, iy0 = (rect.y * k) - y0;
  const ix1 = ix0 + rect.w * k, iy1 = iy0 + rect.h * k;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const hist = new Map();
  const inner = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const inside = x >= ix0 && x < ix1 && y >= iy0 && y < iy1;
      const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
      let e = hist.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; hist.set(key, e); }
      const wgt = inside ? 1 : 2;       // the ring is more likely to be background
      e.n += wgt; e.r += r * wgt; e.g += g * wgt; e.b += b * wgt;
      if (inside) inner.push(r, g, b);
    }
  }
  let best = null;
  for (const e of hist.values()) if (!best || e.n > best.n) best = e;
  if (!best) return fallback;
  const bgRgb = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
  const bg = toHex(bgRgb);

  // Ink: inner pixels far from the background, keep the farthest half
  let maxD = 0;
  const dists = [];
  for (let i = 0; i < inner.length; i += 3) {
    const d = Math.hypot(inner[i] - bgRgb.r, inner[i + 1] - bgRgb.g, inner[i + 2] - bgRgb.b);
    dists.push(d);
    if (d > maxD) maxD = d;
  }
  let fg = contrastColor(bg);
  if (maxD > 60) {
    const ink = new Map();
    for (let j = 0; j < dists.length; j++) {
      if (dists[j] < maxD * 0.6) continue;
      const r = inner[j * 3], g = inner[j * 3 + 1], b = inner[j * 3 + 2];
      const key = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
      let e = ink.get(key);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; ink.set(key, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
    let bi = null;
    for (const e of ink.values()) if (!bi || e.n > bi.n) bi = e;
    if (bi) fg = toHex({ r: bi.r / bi.n, g: bi.g / bi.n, b: bi.b / bi.n });
  }
  return { bg, fg, bgLum: luminance(bg) };
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE LOADING
// ═══════════════════════════════════════════════════════════════════════════
function hasPdfHeader(bytes) {
  const n = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true;
  }
  return false;
}

function looksLikePdfFile(file) {
  return /\.pdf$/i.test(file?.name || '') || /pdf/i.test(file?.type || '');
}

async function loadFile(file) {
  if (!file) return;
  if (pdfDoc && dirtySinceExport && !confirm('Open another PDF? Unsaved changes on the current document will be lost.')) return;
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch (e) { webEditorToast('❌ Could not read the file: ' + e.message, 'error'); return; }
  if (!bytes.length) { webEditorToast('❌ This file is empty', 'error'); return; }
  if (!hasPdfHeader(bytes) && !looksLikePdfFile(file)) {
    webEditorToast('❌ This file is not a PDF', 'error');
    return;
  }
  await openPdfBytes(bytes, file.name || 'document.pdf', { persist: true });
}

async function loadPDFFromURL(url) {
  let parsed;
  try { parsed = new URL(url, location.href); } catch { webEditorToast('❌ Invalid URL', 'error'); return; }
  if (!/^https?:$/.test(parsed.protocol)) { webEditorToast('❌ Only http(s) links are supported', 'error'); return; }
  showLoading('Fetching PDF…');
  try {
    let resp;
    try { resp = await fetch(parsed.href, { credentials: 'omit' }); }
    catch { throw new Error('the website does not allow direct download (CORS). Download the file and open it instead.'); }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (!hasPdfHeader(bytes)) throw new Error('the link does not point to a PDF file');
    let name = decodeURIComponent(parsed.pathname.split('/').pop() || '') || 'document.pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    await openPdfBytes(bytes, name, { persist: true });
  } catch (e) {
    hideLoading();
    webEditorToast('❌ Could not load PDF: ' + e.message, 'error');
  }
}

// ── Password prompt ───────────────────────────────────────────────────────────
function askPassword(name, incorrect) {
  return new Promise(resolve => {
    document.getElementById('folio-pw-modal')?.remove();
    const ov = document.createElement('div');
    ov.id = 'folio-pw-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font-family:"DM Sans",system-ui,sans-serif;';
    const card = document.createElement('form');
    card.style.cssText = 'background:#13131a;border:1px solid rgba(232,255,71,0.25);border-radius:16px;padding:28px;width:min(380px,calc(100% - 32px));color:#f0f0f0;';
    const h = document.createElement('div');
    h.style.cssText = 'font-family:Syne,sans-serif;font-weight:800;font-size:18px;margin-bottom:8px;';
    h.textContent = '🔒 Password required';
    const p = document.createElement('div');
    p.style.cssText = 'color:#a0a0b0;font-size:13px;line-height:1.5;margin-bottom:14px;word-break:break-word;';
    p.textContent = (incorrect ? 'Incorrect password. ' : '') + `"${name}" is protected. Enter its password to open it.`;
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'folioPwInput';
    input.autocomplete = 'off';
    input.style.cssText = 'width:100%;background:#1f1f26;border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;color:#f0f0f0;font-size:14px;outline:none;margin-bottom:14px;';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:#1f1f26;border:1px solid rgba(255,255,255,0.12);color:#f0f0f0;border-radius:8px;padding:9px 16px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.id = 'folioPwOk';
    ok.textContent = 'Open';
    ok.style.cssText = 'background:#e8ff47;border:none;color:#0c0c0f;border-radius:8px;padding:9px 18px;font-weight:700;cursor:pointer;font-family:Syne,sans-serif;';
    row.append(cancel, ok);
    card.append(h, p, input, row);
    ov.appendChild(card);
    document.body.appendChild(ov);
    hideLoading();
    setTimeout(() => input.focus(), 30);
    const done = v => { ov.remove(); resolve(v); };
    card.addEventListener('submit', e => { e.preventDefault(); done(input.value); });
    cancel.addEventListener('click', () => done(null));
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
  });
}

class PasswordCancelled extends Error {
  constructor() { super('A password is required to open this PDF'); this.name = 'PasswordCancelled'; }
}

async function openWithPdfJs(bytes, name, password = null) {
  let used = password;
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password: password ?? undefined });
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(name, reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null) { cancel(new PasswordCancelled()); task.destroy(); return; }
    used = pw;
    showLoading('Opening PDF…');
    update(pw);
  };
  const doc = await Promise.race([task.promise, cancelled]);
  return { doc, password: used };
}

// ── pdf-lib helpers (repair / decrypt) ───────────────────────────────────────
async function tryPdfLib(bytes) {
  try {
    const doc = await PDFLib.PDFDocument.load(bytes, PDFLIB_LOAD_OPTS);
    const n = doc.getPageCount();
    if (!(n > 0)) throw new Error('no pages');
    return { doc, pages: n };
  } catch (e) {
    return { doc: null, error: e };
  }
}

function trimToLastEndobj(bytes) {
  // Truncated downloads: keep every complete object, pdf-lib rebuilds the rest.
  const tail = 'endobj';
  for (let i = bytes.length - tail.length; i > 0; i--) {
    if (bytes[i] === 0x65 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x64 &&
        bytes[i + 3] === 0x6f && bytes[i + 4] === 0x62 && bytes[i + 5] === 0x6a) {
      const out = new Uint8Array(i + tail.length + 1);
      out.set(bytes.subarray(0, i + tail.length));
      out[out.length - 1] = 0x0a;
      return out;
    }
  }
  return bytes;
}

async function repairWithPdfLib(bytes) {
  for (const variant of [bytes, trimToLastEndobj(bytes)]) {
    const res = await tryPdfLib(variant);
    if (!res.doc || res.doc.isEncrypted) continue;
    try { return await safeSave(res.doc); } catch (e) { console.warn('[Folio] repair save failed:', e); }
  }
  return null;
}

let decryptLibPromise = null;
function loadDecryptLib() {
  if (window.PDFLibDecrypt) return Promise.resolve(window.PDFLibDecrypt);
  if (!decryptLibPromise) {
    decryptLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_BASE + 'pdf-lib-decrypt.min.js';
      s.onload = () => window.PDFLibDecrypt ? resolve(window.PDFLibDecrypt) : reject(new Error('decrypt lib missing'));
      s.onerror = () => { decryptLibPromise = null; reject(new Error('decrypt lib failed to load')); };
      document.head.appendChild(s);
    });
  }
  return decryptLibPromise;
}

async function decryptBytes(bytes, password) {
  const L = await loadDecryptLib();
  const tries = [...new Set([password, ''].filter(p => typeof p === 'string'))];
  for (const pw of tries) {
    try {
      const d = await L.PDFDocument.load(bytes, { password: pw, updateMetadata: false });
      return await d.save();
    } catch (e) {
      console.warn('[Folio] decrypt attempt failed:', e.message);
    }
  }
  return null;
}

// ── Patch pdf-lib to tolerate corrupt page trees ─────────────────────────────
// Some PDFs have broken indirect object references for /Pages or its kids.
// 1. PDFCatalog.Pages — rebuild the page tree from the PDFPageLeaf objects found
//    in the context instead of crashing.
// 2. PDFPageTree.traverse — skip kid refs that can't be resolved.
// When 1. fires, safeSave() strips AcroForm/Annots (broken widget refs).
(function patchPdfLibPageTree() {
  if (!window.PDFLib || !PDFLib.PDFCatalog || !PDFLib.PDFPageTree) return;

  const _origPages = PDFLib.PDFCatalog.prototype.Pages;
  PDFLib.PDFCatalog.prototype.Pages = function() {
    try {
      const pages = _origPages.call(this);
      if (pages) return pages;
      throw new Error('Missing /Pages');
    } catch (e) {
      if (this._folioRebuiltTree) return this._folioRebuiltTree;
      console.warn('[Folio] PDFCatalog.Pages corrupt — rebuilding page tree:', e.message);
      const newTree    = PDFLib.PDFPageTree.withContext(this.context);
      const newTreeRef = this.context.register(newTree);
      let count = 0;
      for (const [ref, obj] of this.context.indirectObjects) {
        if (obj instanceof PDFLib.PDFPageLeaf) {
          obj.setParent(newTreeRef);
          newTree.pushLeafNode(ref);
          count++;
        }
      }
      this.set(PDFLib.PDFName.of('Pages'), newTreeRef);
      console.warn('[Folio] Rebuilt page tree with', count, 'page(s)');
      this._folioPageTreeRebuilt = true;
      this._folioRebuiltTree = newTree;
      return newTree;
    }
  };

  PDFLib.PDFPageTree.prototype.traverse = function(visitor) {
    const Kids = this.Kids();
    for (let idx = 0, len = Kids.size(); idx < len; idx++) {
      const kidRef = Kids.get(idx);
      let kid;
      try { kid = this.context.lookup(kidRef); } catch(e) {
        console.warn('[Folio] traverse: skipping unresolvable kid ref', kidRef && kidRef.toString ? kidRef.toString() : kidRef);
        continue;
      }
      if (kid == null) continue;
      if (kid instanceof PDFLib.PDFPageTree) kid.traverse(visitor);
      visitor(kid, kidRef);
    }
  };
})();

async function safeSave(doc) {
  if (doc.catalog._folioPageTreeRebuilt) {
    console.warn('[Folio] Corrupt page tree — stripping AcroForm and Annots for a clean export');
    try { doc.catalog.delete(PDFLib.PDFName.of('AcroForm')); } catch(e) {}
    try { for (const page of doc.getPages()) { try { page.node.delete(PDFLib.PDFName.of('Annots')); } catch(e) {} } } catch(e) {}
  }
  try {
    return await doc.save();
  } catch (e1) {
    // Typical: form fields without /DA → appearance generation fails
    console.warn('[Folio] save failed, retrying without field appearances:', e1.message);
    try {
      return await doc.save({ updateFieldAppearances: false });
    } catch (e2) {
      console.warn('[Folio] save failed again, retrying without object streams:', e2.message);
      return await doc.save({ updateFieldAppearances: false, useObjectStreams: false });
    }
  }
}

function friendlyOpenError(e) {
  if (!e) return 'unknown error';
  if (e.name === 'PasswordCancelled') return e.message;
  if (e.name === 'InvalidPDFException') return 'the file is damaged and could not be repaired';
  if (e.name === 'MissingPDFException') return 'the file is empty or missing';
  return e.message || String(e);
}

async function sha256Hex(bytes) {
  try {
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle indisponible (http non local) : FNV-1a sur un échantillon
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(bytes.length / 65536));
    for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; }
    return 'f' + h.toString(16) + '-' + bytes.length.toString(16);
  }
}

// ── Main open pipeline ────────────────────────────────────────────────────────
async function openPdfBytes(bytesIn, name = 'document.pdf', { persist = true } = {}) {
  const seq = ++loadSeq;
  showLoading('Reading PDF…');
  const notes = [];
  let jsDoc = null;
  try {
    let bytes = bytesIn;
    let password = null;

    // 1. PDF.js — display engine (asks for the password if needed)
    try {
      ({ doc: jsDoc, password } = await openWithPdfJs(bytes, name));
    } catch (e) {
      if (e.name === 'PasswordCancelled') throw e;
      console.warn('[Folio] PDF.js could not open the file, trying to repair:', e);
      showLoading('Repairing damaged PDF…');
      const repaired = await repairWithPdfLib(bytes);
      if (!repaired) throw e;
      bytes = repaired;
      notes.push('repaired');
      ({ doc: jsDoc } = await openWithPdfJs(bytes, name));
    }
    if (seq !== loadSeq) { jsDoc.destroy(); return; }

    // 2. pdf-lib — export engine
    showLoading('Preparing editor…');
    let lib = await tryPdfLib(bytes);

    const adopt = async (candidate, note) => {
      const res = await tryPdfLib(candidate);
      if (!res.doc || res.doc.isEncrypted) return false;
      let j2;
      try { ({ doc: j2 } = await openWithPdfJs(candidate, name)); } catch { return false; }
      if (j2.numPages !== jsDoc.numPages) { j2.destroy(); return false; }
      jsDoc.destroy();
      jsDoc = j2; bytes = candidate; lib = res;
      notes.push(note);
      return true;
    };

    if (lib.doc?.isEncrypted) {
      showLoading('Decrypting protected PDF…');
      const dec = await decryptBytes(bytes, password).catch(e => { console.warn(e); return null; });
      if (dec) await adopt(dec, 'decrypted');
    } else if (!lib.doc) {
      showLoading('Repairing PDF structure…');
      const repaired = await repairWithPdfLib(bytes);
      if (repaired) await adopt(repaired, 'repaired');
    }
    if (seq !== loadSeq) { jsDoc.destroy(); return; }

    const nativeOk = !!lib.doc && !lib.doc.isEncrypted && lib.pages === jsDoc.numPages;

    // 3. Commit
    if (pdfDoc && pdfDoc !== jsDoc) { try { pdfDoc.destroy(); } catch {} }
    pdfDoc        = jsDoc;
    workBytes     = bytes;
    originalBytes = bytesIn;
    pdfLibDoc     = nativeOk ? lib.doc : null;
    exportMode    = nativeOk ? 'native' : 'raster';
    totalPages    = pdfDoc.numPages;
    fileName      = name;
    resetDocumentState();

    const docKey = await sha256Hex(bytesIn);
    WebPayment.setDocument(docKey);
    if (WebPayment.lastStatus()) updateCreditsPill(WebPayment.lastStatus());
    if (persist) persistDocument(bytesIn, name);

    $('totalPagesSpan').textContent = totalPages;
    $('emptyState').classList.add('hidden');
    $('pdfPageWrap').classList.remove('hidden');
    $('pageNav').style.display  = '';
    $('zoomCtrl').style.display = '';
    $('btnExport').disabled     = false;

    await fitZoomIfNeeded();
    await renderPage(1);
    if (['extract', 'merge'].includes(currentMode)) await buildThumbnails();
    if (currentMode === 'merge') syncMergeCurrentFile(name);

    hideLoading();
    let msg = `✓ "${name}" — ${totalPages} page(s)`;
    if (notes.includes('repaired'))  msg += ' · damaged file repaired';
    if (notes.includes('decrypted')) msg += ' · protection removed for editing';
    if (!nativeOk) msg += ' · export will rebuild pages as images';
    webEditorToast(msg, 'success');
  } catch (e) {
    if (seq === loadSeq) hideLoading();
    if (jsDoc && jsDoc !== pdfDoc) { try { jsDoc.destroy(); } catch {} }
    webEditorToast('❌ Error loading PDF: ' + friendlyOpenError(e), 'error');
    console.error('[Folio] loadPDF error:', e);
  }
}

function resetDocumentState() {
  pageCache.clear();
  textEdits.clear();
  signatures = [];
  annotations = [];
  selectedBlockKey = null;
  draftEdit = null;
  activeFieldKey = null;
  activeSigId = null;
  mergeFiles = [];
  selExtract.clear();
  currentPage = 1;
  dirtySinceExport = false;
  $('propPanel').style.display = 'none';
  $('formPropPanel').style.display = 'none';
  $('thumbGrid').innerHTML = '';
  updateModBadge();
  updateFormBadge();
  updateAnnotBadge();
}

async function fitZoomIfNeeded() {
  try {
    const page = await pdfDoc.getPage(1);
    const vp1  = page.getViewport({ scale: 1 });
    const avail = $('canvasArea').clientWidth - 48;
    if (avail > 200 && vp1.width * BASE_SCALE * zoom > avail) {
      zoom = clamp(Math.floor((avail / (vp1.width * BASE_SCALE)) * 20) / 20, 0.3, 3);
      $('zoomVal').textContent = Math.round(zoom * 100) + '%';
    }
  } catch { /* ignore */ }
}

// ── Persistence (restore after reload / Stripe redirect) ─────────────────────
// Small files: sessionStorage (as before). Large files: IndexedDB (sessionStorage
// quota was exceeded above ~3.5 MB and the editor stayed stuck on "Reading PDF…").
const IDB_TTL = 6 * 60 * 60 * 1000;

function tabId() {
  try {
    let id = sessionStorage.getItem('folioTabId');
    if (!id) { id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem('folioTabId', id); }
    return id;
  } catch { return null; }
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('no indexedDB'));
    const req = indexedDB.open('folio-editor', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('docs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const req = fn(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function persistDocument(bytes, name) {
  const id = tabId();
  try {
    sessionStorage.removeItem('folioPDFData');
    sessionStorage.setItem('folioPDFName', name);
  } catch { /* ignore */ }
  if (bytes.length < 2_500_000) {
    try {
      sessionStorage.setItem('folioPDFData', 'data:application/pdf;base64,' + uint8ToBase64(bytes));
      sessionStorage.removeItem('folioPDFStore');
      if (id) idbDo('readwrite', s => s.delete(id)).catch(() => {});
      return;
    } catch { /* quota → IndexedDB */ }
  }
  if (!id) return;
  try {
    await idbDo('readwrite', s => s.put({ bytes, name, ts: Date.now() }, id));
    sessionStorage.setItem('folioPDFStore', 'idb');
  } catch (e) {
    console.warn('[Folio] Could not persist the document (it will not survive a reload):', e);
  }
}

async function restoreDocument() {
  // Clean up expired IndexedDB entries
  idbDo('readwrite', s => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      if (!c.value || Date.now() - (c.value.ts || 0) > IDB_TTL) c.delete();
      c.continue();
    };
    return req;
  }).catch(() => {});

  let name = 'document.pdf';
  try {
    name = sessionStorage.getItem('folioPDFName') || name;
    const stored = sessionStorage.getItem('folioPDFData');
    if (stored) {
      const b64 = stored.includes(',') ? stored.split(',')[1] : stored;
      return { bytes: base64ToBytes(b64), name };
    }
    if (sessionStorage.getItem('folioPDFStore') === 'idb') {
      const rec = await idbDo('readonly', s => s.get(tabId()));
      if (rec?.bytes && Date.now() - (rec.ts || 0) < IDB_TTL) {
        return { bytes: rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes), name: rec.name || name };
      }
    }
  } catch (e) {
    console.warn('[Folio] restore failed:', e);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════
function pixelRatioFor(w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const MAX_PIXELS = 16_000_000, MAX_DIM = 16_000;   // Safari/iOS canvas limits
  return Math.max(0.1, Math.min(dpr, Math.sqrt(MAX_PIXELS / (w * h)), MAX_DIM / w, MAX_DIM / h));
}

function getPageInfo(num) {
  let info = pageCache.get(num);
  if (!info) { info = { blocks: null, fields: null }; pageCache.set(num, info); }
  return info;
}

async function renderPage(num) {
  if (!pdfDoc) return;
  num = clamp(num, 1, totalPages);
  const seq = ++renderSeq;
  if (renderTask) { try { renderTask.cancel(); } catch {} renderTask = null; }
  commitPendingInputs();
  const slow = setTimeout(() => { if (seq === renderSeq) showLoading(`Rendering page ${num}…`); }, 300);
  try {
    const page = await pdfDoc.getPage(num);
    if (seq !== renderSeq) return;
    const vp  = page.getViewport({ scale: viewScale() });
    const pr  = pixelRatioFor(vp.width, vp.height);
    const tmp = document.createElement('canvas');
    tmp.width  = Math.max(1, Math.floor(vp.width * pr));
    tmp.height = Math.max(1, Math.floor(vp.height * pr));
    const task = page.render({
      canvasContext: tmp.getContext('2d', { willReadFrequently: true }),
      viewport: vp,
      transform: pr !== 1 ? [pr, 0, 0, pr, 0, 0] : null,
    });
    renderTask = task;
    await task.promise;
    if (renderTask === task) renderTask = null;
    if (seq !== renderSeq) return;

    if (num !== currentPage) { selectedBlockKey = null; draftEdit = null; activeFieldKey = null; activeSigId = null; }
    baseCanvas  = tmp;
    basePr      = pr;
    currentPage = num;
    $('pageNum').textContent = num;

    const canvas = $('pdfCanvas');
    canvas.width  = tmp.width;
    canvas.height = tmp.height;
    canvas.style.width  = vp.width  + 'px';
    canvas.style.height = vp.height + 'px';
    const wrap = $('pdfPageWrap');
    wrap.style.width  = vp.width  + 'px';
    wrap.style.height = vp.height + 'px';

    composite();
    await buildOverlays(seq);
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return;
    console.error('[Folio] render error:', e);
    webEditorToast(`❌ Could not render page ${num}: ${e.message}`, 'error');
  } finally {
    clearTimeout(slow);
    if (seq === renderSeq) hideLoading();
  }
}

// Visible canvas = pristine render + text edits + annotations (all in pu)
function composite() {
  const canvas = $('pdfCanvas');
  if (!baseCanvas.width || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(baseCanvas, 0, 0);
  const k = basePr * viewScale();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const [key, e] of textEdits) {
    if (e.page !== currentPage) continue;
    if (draftEdit && draftEdit.key === key) continue;
    drawTextEditCanvas(ctx, e);
  }
  if (draftEdit && draftEdit.page === currentPage) drawTextEditCanvas(ctx, draftEdit);
  for (const a of annotations) if (a.page === currentPage) drawAnnotationCanvas(ctx, a);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

async function buildOverlays(seq = renderSeq) {
  const wrap = $('pdfPageWrap');
  wrap.querySelectorAll('.text-overlay, .form-field-overlay, .sig-overlay').forEach(el => el.remove());
  setupAnnotationCanvas();

  signatures.filter(s => s.page === currentPage).forEach(createSigOverlay);

  const info = getPageInfo(currentPage);
  if (currentMode === 'form' || info.fields) {
    const fields = await getPageFields(currentPage);
    if (seq !== renderSeq) return;
    fields.forEach(createFieldOverlay);
  }
  if (currentMode === 'form') { buildFormFieldList(); updateFormStatus(); }
  if (currentMode === 'edit') {
    await buildEditOverlays(seq);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT BLOCKS (edit mode)
// ═══════════════════════════════════════════════════════════════════════════
const STD_FONTS = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique']);

function pdfFontInfo(page, id) {
  try {
    if (page.commonObjs.has(id)) {
      const f = page.commonObjs.get(id);
      return {
        name: String(f?.name || '').replace(/^[A-Z]{6}\+/, ''),
        bold: !!(f?.bold || f?.black), italic: !!f?.italic,
        serif: !!f?.isSerifFont, mono: !!f?.isMonospace,
      };
    }
  } catch { /* not resolved yet */ }
  return null;
}

function resolveStdFont(info, family) {
  const n = (info?.name || '').toLowerCase();
  const bold   = !!info?.bold || /bold|black|heavy|semibold|demi/.test(n);
  const italic = !!info?.italic || /italic|oblique/.test(n);
  const mono   = !!info?.mono || /courier|mono|consol|menlo/.test(n) || family === 'monospace';
  const serif  = !mono && (!!info?.serif || (/times|serif|georgia|garamond|cambria|minion|palatino|antiqua|baskerville|book/.test(n) && !/sans/.test(n)) || family === 'serif');
  if (mono)  return bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier';
  if (serif) return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  return bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica';
}

// Corners of a text-frame rectangle (padded) in page units
function framePoly(frame, pad = 0) {
  const c = Math.cos(frame.angle), sn = Math.sin(frame.angle);
  const toXY = (u, v) => ({ x: u * c - v * sn, y: u * sn + v * c });
  const u0 = frame.u - pad, u1 = frame.u + frame.w + pad, v0 = frame.v - pad, v1 = frame.v + frame.h + pad;
  return [toXY(u0, v0), toXY(u1, v0), toXY(u1, v1), toXY(u0, v1)];
}

async function getTextBlocks(num) {
  const info = getPageInfo(num);
  if (info.blocks) return info.blocks;
  const page    = await pdfDoc.getPage(num);
  const content = await page.getTextContent();
  const vp1     = page.getViewport({ scale: 1 });
  const styles  = content.styles || {};

  // Every item is placed in its own text frame: u along the baseline, v across it
  // (for horizontal text u = x, v = y). Grouping happens per orientation, so
  // rotated pages / vertical labels get proper multi-word blocks too.
  const items = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
    if (!(fh > 0.5) || !isFinite(tx[4]) || !isFinite(tx[5])) continue;
    const st = styles[it.fontName] || {};
    let asc = Number(st.ascent), desc = Number(st.descent);
    if (!(asc > 0.4 && asc < 1.4)) asc = 0.88;
    asc = Math.max(asc, 0.8);          // cap-height-only metrics (Helvetica: 0.718) leave ascenders uncovered
    if (!(desc < 0 && desc > -0.6)) desc = -0.22;
    let angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) < 0.035) angle = 0;
    const bucket = st.vertical ? 'v' + items.length : String(Math.round(angle / 0.02));
    const c = Math.cos(angle), sn = Math.sin(angle);
    items.push({
      str: it.str, fh, angle, bucket, w: Math.abs(it.width || 0), asc, desc,
      u: tx[4] * c + tx[5] * sn, v: -tx[4] * sn + tx[5] * c,
      fontId: it.fontName, family: st.fontFamily || '',
    });
  }

  const blocks = [];
  const makeBlock = (group, angle) => {
    const c = Math.cos(angle), sn = Math.sin(angle);
    const toXY = (u, v) => ({ x: u * c - v * sn, y: u * sn + v * c });
    const first = group[0];
    let u0 = Infinity, u1 = -Infinity, vTop = Infinity, vBot = -Infinity;
    let text = '', prevEnd = null, fh = 0;
    const fontCount = new Map();
    for (const it of group) {
      u0 = Math.min(u0, it.u); u1 = Math.max(u1, it.u + it.w);
      vTop = Math.min(vTop, it.v - it.asc * it.fh); vBot = Math.max(vBot, it.v - it.desc * it.fh);
      if (prevEnd !== null) {
        const gap = it.u - prevEnd;
        if (gap > it.fh * 0.12 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      prevEnd = it.u + it.w;
      fh = Math.max(fh, it.fh);
      fontCount.set(it.fontId, (fontCount.get(it.fontId) || 0) + it.str.length);
    }
    const frame = { angle, u: u0, v: vTop, w: Math.max(u1 - u0, 2), h: Math.max(vBot - vTop, 2) };
    const poly = framePoly(frame, 0);
    const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
    const fontId  = [...fontCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const fInfo   = pdfFontInfo(page, fontId);
    const famItem = group.find(g => g.fontId === fontId) || first;
    const base    = toXY(u0, first.v);
    blocks.push({
      key: `${num}:${Math.round(base.x)}:${Math.round(base.y)}:${blocks.length}`, page: num,
      text: text.trim(), origText: text.trim(),
      frame,
      bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      baseline: base,
      fontSize: Math.round(fh * 2) / 2,
      fontName: resolveStdFont(fInfo, famItem.family),
      fontLabel: fInfo?.name || famItem.family || '',
      rotation: Math.round(-angle * 180 / Math.PI),
    });
  };

  const buckets = new Map();
  for (const it of items) {
    if (!buckets.has(it.bucket)) buckets.set(it.bucket, []);
    buckets.get(it.bucket).push(it);
  }
  for (const group of buckets.values()) {
    const angle = group[0].angle;
    // Lines (same v), then segments separated by large gaps (columns / cells)
    const sorted = group.sort((a, b) => a.v - b.v || a.u - b.u);
    const lines = [];
    for (const it of sorted) {
      let line = null;
      for (let li = lines.length - 1; li >= 0 && li >= lines.length - 4; li--) {
        const L = lines[li];
        if (Math.abs(L.v - it.v) <= 0.3 * Math.min(L.fh, it.fh) + 0.5) { line = L; break; }
      }
      if (!line) { line = { v: it.v, fh: it.fh, items: [] }; lines.push(line); }
      line.items.push(it);
      line.fh = Math.max(line.fh, it.fh);
    }
    for (const line of lines) {
      const its = line.items.sort((a, b) => a.u - b.u);
      let seg = [];
      let end = -Infinity;
      for (const it of its) {
        if (seg.length) {
          if (seg.some(g => g.str === it.str && Math.abs(g.u - it.u) < it.fh * 0.3)) continue;   // fake-bold duplicates
          if (it.u - end > 1.6 * Math.max(it.fh, seg[seg.length - 1].fh)) { makeBlock(seg, angle); seg = []; end = -Infinity; }
        }
        seg.push(it);
        end = Math.max(end, it.u + it.w);
      }
      if (seg.length) makeBlock(seg, angle);
    }
  }

  info.blocks = blocks;
  return blocks;
}

async function buildEditOverlays(seq) {
  const list = $('blockList');
  let blocks;
  try { blocks = await getTextBlocks(currentPage); }
  catch (e) { console.warn('[Folio] text extraction failed:', e); blocks = []; }
  if (seq !== renderSeq || currentMode !== 'edit') return;

  list.innerHTML = '';
  const wrap = $('pdfPageWrap');
  const sc = viewScale();
  blocks.forEach(block => {
    const edited = textEdits.has(block.key);
    const div = document.createElement('div');
    div.className = 'text-overlay' + (edited ? ' modified' : '') + (block.key === selectedBlockKey ? ' selected' : '');
    div.dataset.key = block.key;
    div.style.cssText = `left:${block.bbox.x * sc}px;top:${block.bbox.y * sc}px;width:${block.bbox.w * sc}px;height:${block.bbox.h * sc}px;z-index:5;`;
    div.title = edited ? textEdits.get(block.key).text : block.text;
    div.addEventListener('click', () => selectBlock(block.key));
    wrap.appendChild(div);

    const li = document.createElement('div');
    li.className  = 'block-item' + (block.key === selectedBlockKey ? ' selected' : '');
    li.dataset.key = block.key;
    const shown = edited ? textEdits.get(block.key).text : block.text;
    const prev  = document.createElement('div');
    prev.className = 'block-preview';
    prev.textContent = shown.slice(0, 38) + (shown.length > 38 ? '…' : '');
    const meta = document.createElement('div');
    meta.className = 'block-meta';
    const t1 = document.createElement('span'); t1.className = 'block-tag'; t1.textContent = block.fontSize + 'pt';
    const t2 = document.createElement('span'); t2.className = 'block-tag'; t2.textContent = block.fontName.split('-')[0].slice(0, 10);
    meta.append(t1, t2);
    if (edited) { const t3 = document.createElement('span'); t3.className = 'block-tag modified'; t3.textContent = '✓ edited'; meta.appendChild(t3); }
    li.append(prev, meta);
    li.addEventListener('click', () => selectBlock(block.key));
    list.appendChild(li);
  });

  if (!blocks.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">No detectable text on this page (scanned image?). Use “Edit libre” to add text anywhere.</div>';
  }
  updateModBadge();
}

function findBlock(key) {
  return getPageInfo(currentPage).blocks?.find(b => b.key === key) || null;
}

function selectBlock(key) {
  const block = findBlock(key);
  if (!block) return;
  selectedBlockKey = key;
  draftEdit = null;
  document.querySelectorAll('.text-overlay').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
  document.querySelectorAll('#blockList .block-item').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
  const li = document.querySelector(`#blockList .block-item[data-key="${CSS.escape(key)}"]`);
  li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const edit = textEdits.get(key);
  const colors = sampleRegion(block.bbox, 3);
  block._detected = colors;

  $('propPanel').style.display = '';
  $('applyProps').disabled = false;
  $('propText').value      = edit ? edit.text : block.text;
  $('propSize').value      = edit ? edit.fontSize : block.fontSize;
  $('propColor').value     = edit ? edit.color : colors.fg;
  $('propBgColor').value   = edit ? edit.bgColor : '#ffffff';
  $('propBgOpacity').value = edit ? edit.bgOpacity : 0;
  $('propRotation').value  = edit ? edit.rotation : block.rotation;
  $('propCoverAuto').checked = edit ? edit.coverAuto : true;
  $('propCoverColor').value  = edit ? edit.coverColor : colors.bg;
  const fontName = edit ? edit.fontName : block.fontName;
  const sel = $('propFont');
  sel.value = [...sel.options].some(o => o.value === fontName) ? fontName : 'Helvetica';
  $('propFontHint').textContent = block.fontLabel
    ? `Original font: ${block.fontLabel} · background ${colors.bg}`
    : `Background detected: ${colors.bg}`;
  $('btnResetBlock').disabled = !edit;
}

function editFromPanel() {
  const block = findBlock(selectedBlockKey);
  if (!block) return null;
  const detected = block._detected || sampleRegion(block.bbox, 3);
  const coverAuto = $('propCoverAuto').checked;
  return {
    key: block.key, page: block.page,
    bbox: block.bbox, frame: block.frame, baseline: block.baseline, origText: block.origText,
    text: sanitizeText($('propText').value),
    fontName: $('propFont').value,
    fontSize: clamp(parseFloat($('propSize').value) || block.fontSize, 1, 400),
    color: $('propColor').value,
    coverAuto,
    coverColor: coverAuto ? detected.bg : $('propCoverColor').value,
    bgColor: $('propBgColor').value,
    bgOpacity: clamp(parseFloat($('propBgOpacity').value) || 0, 0, 1),
    rotation: parseFloat($('propRotation').value) || 0,
  };
}

function updateDraft() {
  if (!selectedBlockKey) return;
  draftEdit = editFromPanel();
  ensureCanvasFont(draftEdit?.fontName, composite);
  composite();
}

// Area hiding the original text: the text frame (rotated with the text), padded
function coverPoly(e) {
  if (e.frame) return framePoly(e.frame, 1);
  const r = e.bbox;
  return framePoly({ angle: 0, u: r.x, v: r.y, w: r.w, h: r.h }, 1);
}

function fillPoly(ctx, poly) {
  ctx.beginPath();
  poly.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.fill();
}

function polyPath(poly) {
  return poly.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' ') + ' Z';
}

function drawTextEditCanvas(ctx, e) {
  const poly = coverPoly(e);
  ctx.globalAlpha = 1;
  ctx.fillStyle = e.coverColor || '#ffffff';
  fillPoly(ctx, poly);
  if (e.bgOpacity > 0) {
    ctx.globalAlpha = e.bgOpacity;
    ctx.fillStyle = e.bgColor || '#ffffff';
    fillPoly(ctx, poly);
    ctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.translate(e.baseline.x, e.baseline.y);
  if (e.rotation) ctx.rotate(-e.rotation * Math.PI / 180);
  ctx.font = buildCanvasFont(e.fontName, e.fontSize);
  ctx.fillStyle = e.color || '#000000';
  ctx.textBaseline = 'alphabetic';
  (e.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, 0, i * e.fontSize * LINE_HEIGHT));
  ctx.restore();
}

$('applyProps').addEventListener('click', async () => {
  if (!selectedBlockKey) { webEditorToast('Select a text block first', 'error'); return; }
  const edit = editFromPanel();
  if (!edit) return;
  const allowed = await _canEdit();
  if (!allowed) return;
  textEdits.set(edit.key, edit);
  draftEdit = null;
  dirtySinceExport = true;
  ensureCanvasFont(edit.fontName, composite);
  composite();
  await buildOverlays();
  selectBlock(edit.key);
  webEditorToast('✓ Modification saved', 'success');
});

$('btnResetBlock').addEventListener('click', async () => {
  if (!selectedBlockKey || !textEdits.has(selectedBlockKey)) return;
  textEdits.delete(selectedBlockKey);
  draftEdit = null;
  composite();
  const key = selectedBlockKey;
  await buildOverlays();
  selectBlock(key);
  webEditorToast('↺ Original text restored');
});

['propText', 'propFont', 'propSize', 'propColor', 'propBgColor', 'propBgOpacity', 'propRotation', 'propCoverColor', 'propCoverAuto']
  .forEach(id => $(id).addEventListener('input', () => {
    if (id === 'propCoverColor') $('propCoverAuto').checked = false;
    if (id === 'propCoverAuto' && $('propCoverAuto').checked) {
      const b = findBlock(selectedBlockKey);
      if (b?._detected) $('propCoverColor').value = b._detected.bg;
    }
    updateDraft();
  }));

function updateModBadge() {
  const badge = $('modBadge');
  if (textEdits.size > 0) {
    badge.classList.remove('hidden');
    badge.textContent = textEdits.size + ' edited';
  } else {
    badge.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EYEDROPPER — pick a color from the page
// ═══════════════════════════════════════════════════════════════════════════
let pickState = null;

function startPick(inputId, btn) {
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  cancelPick();
  const wrap = $('pdfPageWrap');
  wrap.classList.add('page-picking');
  btn?.classList.add('active');
  const handler = e => {
    e.preventDefault();
    e.stopPropagation();
    const p = eventToPu(e);
    const c = $('pdfCanvas');
    const k = basePr * viewScale();
    let hex = '#ffffff';
    try {
      const x = clamp(Math.round(p.x * k) - 1, 0, c.width - 3), y = clamp(Math.round(p.y * k) - 1, 0, c.height - 3);
      const d = c.getContext('2d').getImageData(x, y, 3, 3).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      hex = toHex({ r: r / 9, g: g / 9, b: b / 9 });
    } catch { /* ignore */ }
    const input = $(inputId);
    input.value = hex;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    cancelPick();
    webEditorToast(`🎨 Color picked: ${hex}`);
  };
  wrap.addEventListener('pointerdown', handler, true);
  pickState = { handler, btn };
  webEditorToast('💧 Click on the page to pick a color (Esc to cancel)');
}

function cancelPick() {
  if (!pickState) return;
  $('pdfPageWrap').removeEventListener('pointerdown', pickState.handler, true);
  $('pdfPageWrap').classList.remove('page-picking');
  pickState.btn?.classList.remove('active');
  pickState = null;
}

document.querySelectorAll('.pick-btn[data-pick]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (pickState?.btn === btn) { cancelPick(); return; }
    startPick(btn.dataset.pick, btn);
  });
});

function eventToPu(e) {
  const r = $('pdfCanvas').getBoundingClientRect();
  const sc = viewScale();
  return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAG / RESIZE helper (pointer events: mouse + touch + pen)
// ═══════════════════════════════════════════════════════════════════════════
function attachDragResize(container, { resizeHandle, getRect, setRect, onSelect, minW = 8, minH = 6, keepRatio = false, canDrag = () => true }) {
  const sc = () => viewScale();
  const pageSize = () => ({ w: $('pdfPageWrap').offsetWidth / sc(), h: $('pdfPageWrap').offsetHeight / sc() });

  const start = (e, mode) => {
    if (e.button !== undefined && e.button !== 0) return;
    onSelect?.();
    if (mode === 'move' && !canDrag()) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const r0 = { ...getRect() };
    const ratio = r0.w / Math.max(r0.h, 0.001);
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    let moved = false;
    const move = ev => {
      const dx = (ev.clientX - startX) / sc(), dy = (ev.clientY - startY) / sc();
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
      const ps = pageSize();
      const r = { ...r0 };
      if (mode === 'move') {
        r.x = clamp(r0.x + dx, -r0.w * 0.5, ps.w - r0.w * 0.5);
        r.y = clamp(r0.y + dy, -r0.h * 0.5, ps.h - r0.h * 0.5);
      } else {
        r.w = Math.max(minW, r0.w + dx);
        r.h = keepRatio ? r.w / ratio : Math.max(minH, r0.h + dy);
      }
      setRect(r, false);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (moved) { setRect(getRect(), true); dirtySinceExport = true; }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  container.addEventListener('pointerdown', e => { if (e.target === resizeHandle || e.target.classList.contains('sig-delete')) return; start(e, 'move'); });
  resizeHandle?.addEventListener('pointerdown', e => start(e, 'resize'));
  container.style.touchAction = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// FORM MODE — AcroForm fields, detected zones, free text anywhere
// ═══════════════════════════════════════════════════════════════════════════
function normRect(r) {
  const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
  return { x, y, w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
}

function defaultFieldStyle(rect, source) {
  const fontSize = clamp(Math.round(rect.h * 0.62 * 2) / 2, 6, 14);
  return {
    font: 'Helvetica', fontSize, color: null, align: 'left',
    bgMode: source === 'acroform' ? 'auto' : 'none', bgColor: '#ffffff', bgResolved: null,
  };
}

async function getPageFields(num) {
  const info = getPageInfo(num);
  if (info.fields) return info.fields;
  if (info.fieldsPromise) return info.fieldsPromise;
  info.fieldsPromise = (async () => {
    const page = await pdfDoc.getPage(num);
    const vp1  = page.getViewport({ scale: 1 });
    const fields = [];
    let annots = [];
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch (e) { console.warn('[Folio] annotations:', e); }

    annots.forEach((a, i) => {
      if (a.subtype !== 'Widget' || !a.fieldType || a.hidden || !Array.isArray(a.rect)) return;
      let kind = null;
      if (a.fieldType === 'Tx') kind = 'text';
      else if (a.fieldType === 'Btn') kind = a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : null;
      else if (a.fieldType === 'Ch') kind = 'choice';
      if (!kind || a.readOnly) return;
      const rect = normRect(vp1.convertToViewportRectangle(a.rect));
      if (rect.w < 2 || rect.h < 2) return;
      const style = defaultFieldStyle(rect, 'acroform');
      const da = a.defaultAppearanceData;
      if (da?.fontSize > 0) style.fontSize = clamp(da.fontSize, 4, 72);
      if (kind === 'text' && a.multiLine) style.fontSize = Math.min(style.fontSize, 11);
      if (a.textAlignment === 1) style.align = 'center';
      if (a.textAlignment === 2) style.align = 'right';
      fields.push({
        key: `acro-${num}-${a.id || i}`, page: num, source: 'acroform', kind,
        name: a.fieldName || `Field ${i + 1}`, rect, multiLine: !!a.multiLine,
        options: (a.options || []).map(o => ({ value: String(o.exportValue ?? o.displayValue ?? ''), label: String(o.displayValue ?? o.exportValue ?? '') })),
        exportValue: kind === 'checkbox' ? a.exportValue : kind === 'radio' ? a.buttonValue : null,
        initial: a.fieldValue ?? null, maxLen: a.maxLen || 0,
        value: kind === 'text' ? (typeof a.fieldValue === 'string' ? a.fieldValue : '')
             : kind === 'checkbox' ? (a.fieldValue != null && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue)
             : kind === 'radio' ? (a.fieldValue != null && a.fieldValue === a.buttonValue)
             : (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue) ?? '',
        style, dirty: false,
      });
    });

    if (!fields.length) {
      // Heuristic: runs of underscores / dots ("Name: ________")
      try {
        const content = await page.getTextContent();
        let zi = 0;
        for (const it of content.items) {
          const str = it.str || '';
          if (!str || !/[_.…]{4,}/.test(str)) continue;
          const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
          const fh = Math.hypot(tx[2], tx[3]);
          if (Math.abs(tx[1]) > 0.01 * Math.abs(tx[0]) || !(fh > 1)) continue;
          const re = /[_.…]{4,}/g;
          let m;
          while ((m = re.exec(str))) {
            // Position inside the item from real glyph widths ("Date: ....." — the
            // label is much wider than the dots, an average char width overlaps it)
            const total = measureRatio(str, str.length) || 1;
            const x = tx[4] + (it.width || 0) * (measureRatio(str, m.index) / total);
            const w = Math.max((it.width || 0) * (measureRatio(str, m.index + m[0].length) - measureRatio(str, m.index)) / total, 20);
            const rect = { x, y: tx[5] - fh * 1.05, w, h: fh * 1.3 };
            fields.push({
              key: `heu-${num}-${zi}`, page: num, source: 'heuristic', kind: 'text',
              name: `Zone ${++zi}`, rect, value: '', style: defaultFieldStyle(rect, 'heuristic'), dirty: false,
            });
          }
        }
      } catch (e) { console.warn('[Folio] zone detection:', e); }
    }
    const existing = info.fields || [];
    info.fields = [...fields, ...existing.filter(f => f.source === 'free')];
    return info.fields;
  })();
  try { return await info.fieldsPromise; } finally { info.fieldsPromise = null; }
}

let measureCtx = null;
function measureRatio(str, end) {
  if (!measureCtx) { measureCtx = document.createElement('canvas').getContext('2d'); measureCtx.font = '100px Helvetica, Arial, sans-serif'; }
  return measureCtx.measureText(str.slice(0, end)).width;
}

function allFields() {
  const out = [];
  for (const info of pageCache.values()) if (info.fields) out.push(...info.fields);
  return out;
}

function findField(key) { return allFields().find(f => f.key === key) || null; }

function fieldHasContent(f) {
  if (f.kind === 'text') return !!(f.value && f.value.trim());
  if (f.kind === 'checkbox' || f.kind === 'radio') return f.dirty;
  if (f.kind === 'choice') return f.dirty;
  return false;
}

function resolveFieldBg(f) {
  if (f.style.bgMode === 'none') return null;
  if (f.style.bgMode === 'custom') return f.style.bgColor;
  return f.style.bgResolved || '#ffffff';
}

function cssFontFamily(name) {
  return buildCanvasFont(name, 10).replace(/^(italic )?(bold )?[\d.]+px /, '');
}

function createFieldOverlay(field) {
  const wrap = $('pdfPageWrap');
  const sc = viewScale();
  const inForm = currentMode === 'form';
  const content = fieldHasContent(field);
  const keepCovered = field.dirty && field.source === 'acroform';
  if (!inForm && !(field.dirty && content) && !keepCovered) return;

  const el = document.createElement('div');
  el.className = 'form-field-overlay'
    + (field.source === 'acroform' ? ' fixed' : '')
    + (inForm ? '' : ' passive')
    + (field.key === activeFieldKey ? ' selected' : '');
  el.dataset.key = field.key;
  el.tabIndex = inForm ? 0 : -1;
  const place = r => {
    el.style.left = r.x * sc + 'px'; el.style.top = r.y * sc + 'px';
    el.style.width = r.w * sc + 'px'; el.style.height = r.h * sc + 'px';
  };
  el.style.cssText = `position:absolute;box-sizing:border-box;border:${content ? '1.5px solid var(--success)' : '2px dashed var(--accent)'};`
    + `border-radius:3px;display:flex;overflow:hidden;z-index:6;cursor:${field.source === 'acroform' ? 'pointer' : 'move'};`;
  place(field.rect);

  const label = document.createElement('div');
  label.className = 'form-field-label';
  const st = field.style;
  const bg = field.dirty || field.source !== 'acroform' ? resolveFieldBg(field) : null;
  const color = st.color || '#000000';
  if (field.kind === 'checkbox' || field.kind === 'radio') {
    label.style.cssText = `flex:1;display:flex;align-items:center;justify-content:center;font-size:${Math.max(field.rect.h * 0.8, 6) * sc}px;`
      + `color:${color};background:${field.dirty ? (bg || 'transparent') : 'transparent'};line-height:1;pointer-events:none;user-select:none;`;
    label.textContent = field.value ? (field.kind === 'checkbox' ? '✓' : '●') : '';
  } else {
    const txt = field.kind === 'choice' ? (field.options?.find(o => o.value === field.value)?.label ?? field.value ?? '') : (field.value || '');
    const single = field.rect.h < st.fontSize * LINE_HEIGHT * 2;
    label.style.cssText = `flex:1;padding:${FIELD_PAD * sc}px ${FIELD_PAD * sc}px;font-size:${st.fontSize * sc}px;`
      + `font:${buildCanvasFont(st.font, st.fontSize * sc)};line-height:${LINE_HEIGHT};text-align:${st.align};`
      + `color:${txt ? color : 'rgba(150,150,150,0.8)'};background:${(txt || keepCovered) && bg ? bg : 'transparent'};`
      + `display:flex;flex-direction:column;justify-content:${single ? 'center' : 'flex-start'};pointer-events:none;user-select:none;`;
    const inner = document.createElement('div');
    inner.style.cssText = 'white-space:pre-wrap;word-break:break-word;';
    inner.textContent = txt || (inForm ? field.name : '');
    label.appendChild(inner);
    if (!txt && !inForm && !keepCovered) el.classList.add('empty');
  }
  el.appendChild(label);

  const del = document.createElement('div');
  del.className = 'sig-delete';
  del.textContent = '×';
  del.title = field.source === 'free' ? 'Delete field' : 'Clear field';
  del.addEventListener('pointerdown', e => e.stopPropagation());
  del.addEventListener('click', e => { e.stopPropagation(); deleteField(field.key); });
  el.appendChild(del);

  const resize = document.createElement('div');
  resize.className = 'sig-resize';
  el.appendChild(resize);

  if (inForm) {
    attachDragResize(el, {
      resizeHandle: resize,
      getRect: () => field.rect,
      setRect: (r, final) => { field.rect = r; place(r); if (final) { field.dirty = field.dirty || field.source !== 'acroform'; } },
      onSelect: () => selectField(field.key, { toggle: true }),
      canDrag: () => field.source !== 'acroform',
      minW: 12, minH: 6,
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteField(field.key); }
      if (field.source !== 'acroform' && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const d = e.shiftKey ? 5 : 1;
        if (e.key === 'ArrowLeft')  field.rect.x -= d;
        if (e.key === 'ArrowRight') field.rect.x += d;
        if (e.key === 'ArrowUp')    field.rect.y -= d;
        if (e.key === 'ArrowDown')  field.rect.y += d;
        place(field.rect);
        dirtySinceExport = true;
      }
    });
    el.title = field.source === 'acroform' ? `${field.name} — click to fill` : 'Drag · Resize · Click to edit';
  }
  wrap.appendChild(el);
}

let lastToggle = { key: null, t: 0 };

async function selectField(key, { toggle = false } = {}) {
  const field = findField(key);
  if (!field) return;
  // Typed but not applied on the previous field → keep it
  if (activeFieldKey && activeFieldKey !== key) applyFormProps({ silent: true });
  const wasActive = activeFieldKey === key;
  activeFieldKey = key;
  document.querySelectorAll('.form-field-overlay').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
  document.querySelectorAll('#formFieldList .block-item').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
  openFormPropPanel(field);

  // Checkbox / radio: a click on the page toggles directly
  if (toggle && (field.kind === 'checkbox' || field.kind === 'radio')) {
    const now = Date.now();
    if (lastToggle.key === key && now - lastToggle.t < 250) return;
    lastToggle = { key, t: now };
    if (!(await _canEdit())) return;
    if (field.kind === 'checkbox') setFieldValue(field, !field.value);
    else setRadio(field);
    return;
  }
  if (!wasActive && field.kind === 'text') {
    setTimeout(() => { const t = $('formPropText'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 30);
  }
}

function setFieldValue(field, value) {
  field.value = value;
  field.dirty = true;
  field.style.bgResolved = field.style.bgResolved || sampleRegion(field.rect, 2).bg;
  dirtySinceExport = true;
  refreshFields();
}

function setRadio(field) {
  for (const f of allFields()) {
    if (f.kind === 'radio' && f.source === 'acroform' && f.name === field.name) {
      f.value = f === field;
      f.dirty = true;
      if (f.page === currentPage) f.style.bgResolved = f.style.bgResolved || sampleRegion(f.rect, 2).bg;
    }
  }
  dirtySinceExport = true;
  refreshFields();
}

function refreshFields() {
  const wrap = $('pdfPageWrap');
  wrap.querySelectorAll('.form-field-overlay').forEach(el => el.remove());
  (getPageInfo(currentPage).fields || []).forEach(createFieldOverlay);
  if (currentMode === 'form') buildFormFieldList();
  updateFormBadge();
  const f = activeFieldKey && findField(activeFieldKey);
  if (f && currentMode === 'form') openFormPropPanel(f, { keepText: true });
}

function openFormPropPanel(field, { keepText = false } = {}) {
  const panel = $('formPropPanel');
  panel.style.display = '';
  const kindLabel = { text: 'Text', checkbox: 'Checkbox', radio: 'Option', choice: 'List' }[field.kind] || '';
  $('formPropKind').textContent = (field.source === 'acroform' ? 'Form · ' : field.source === 'free' ? 'Free · ' : 'Zone · ') + kindLabel;
  $('formCheckRow').style.display  = field.kind === 'checkbox' ? '' : 'none';
  $('formChoiceRow').style.display = field.kind === 'choice' ? '' : 'none';
  $('formRadioHint').style.display = field.kind === 'radio' ? '' : 'none';
  $('formTextProps').style.display = field.kind === 'text' || field.kind === 'choice' ? '' : 'none';
  $('formPropText').closest('.prop-row').style.display = field.kind === 'text' ? '' : 'none';
  $('formApplyProps').style.display = field.kind === 'text' || field.kind === 'choice' ? '' : 'none';

  if (field.kind === 'checkbox') $('formPropCheck').checked = !!field.value;
  if (field.kind === 'choice') {
    const sel = $('formPropChoice');
    sel.innerHTML = '';
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '—';
    sel.appendChild(blank);
    for (const o of field.options || []) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = field.value ?? '';
  }
  if (!keepText) $('formPropText').value = field.kind === 'text' ? (field.value || '') : '';
  const st = field.style;
  $('formPropFont').value  = st.font;
  $('formPropSize').value  = st.fontSize;
  $('formPropAlign').value = st.align;
  $('formPropBgMode').value = st.bgMode;
  const auto = sampleRegion(field.rect, 2);
  $('formPropBgColor').value = st.bgMode === 'custom' ? st.bgColor : (st.bgResolved || auto.bg);
  $('formPropColor').value = st.color || contrastColor(st.bgMode === 'custom' ? st.bgColor : auto.bg);
  $('btnFormDeleteField').title = field.source === 'free' ? 'Delete this field' : 'Clear this field';
}

async function applyFormProps({ silent = false } = {}) {
  const field = activeFieldKey && findField(activeFieldKey);
  if (!field) return;
  if (field.kind !== 'text' && field.kind !== 'choice') return;
  const text = field.kind === 'text' ? sanitizeText($('formPropText').value) : null;
  const choice = field.kind === 'choice' ? $('formPropChoice').value : null;
  const bgMode = $('formPropBgMode').value;
  const newStyle = {
    font: $('formPropFont').value,
    fontSize: clamp(parseFloat($('formPropSize').value) || 11, 3, 200),
    color: $('formPropColor').value,
    align: $('formPropAlign').value,
    bgMode,
    bgColor: $('formPropBgColor').value,
    bgResolved: bgMode === 'auto' ? sampleRegion(field.rect, 2).bg : field.style.bgResolved,
  };
  const valueChanged = field.kind === 'text' ? text !== (field.value || '') : choice !== (field.value ?? '');
  const st = field.style;
  const styleChanged = newStyle.font !== st.font || newStyle.fontSize !== st.fontSize ||
    (st.color && newStyle.color !== st.color) || newStyle.align !== st.align ||
    newStyle.bgMode !== st.bgMode || (newStyle.bgMode === 'custom' && newStyle.bgColor !== st.bgColor);
  if (silent ? !(valueChanged || (field.dirty && styleChanged)) : !(valueChanged || styleChanged || !field.dirty)) return;

  const allowed = await _canEdit();
  if (!allowed) return;
  if (field.kind === 'text') {
    field.value = field.maxLen > 0 ? text.slice(0, field.maxLen) : text;
    if (field.maxLen > 0 && text.length > field.maxLen) webEditorToast(`✂ This field accepts ${field.maxLen} characters max`, 'error');
  } else {
    field.value = choice;
  }
  field.style = newStyle;
  field.dirty = true;
  dirtySinceExport = true;
  ensureCanvasFont(newStyle.font, refreshFields);
  refreshFields();
  if (!silent) webEditorToast('✓ Field updated', 'success');
}

function deleteField(key) {
  const field = findField(key);
  if (!field) return;
  const info = getPageInfo(field.page);
  if (field.source === 'free') {
    info.fields = (info.fields || []).filter(f => f.key !== key);
  } else if (field.source === 'heuristic') {
    field.value = ''; field.dirty = false;
  } else {
    // AcroForm: back to the value stored in the PDF
    if (field.kind === 'radio') {
      for (const f of allFields()) if (f.kind === 'radio' && f.name === field.name) { f.dirty = false; f.value = f.initial != null && f.initial === f.exportValue; }
    } else {
      field.dirty = false;
      field.value = field.kind === 'checkbox' ? (field.initial != null && field.initial === field.exportValue)
                  : field.kind === 'text' ? (typeof field.initial === 'string' ? field.initial : '') : (field.initial ?? '');
    }
  }
  if (activeFieldKey === key) { activeFieldKey = null; $('formPropPanel').style.display = 'none'; }
  refreshFields();
}

function buildFormFieldList() {
  const list = $('formFieldList');
  list.innerHTML = '';
  const fields = getPageInfo(currentPage).fields || [];
  if (!fields.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">No fields on this page</div>';
    return;
  }
  fields.forEach(field => {
    const li = document.createElement('div');
    const content = fieldHasContent(field);
    li.className = 'block-item' + (field.key === activeFieldKey ? ' selected' : '');
    li.dataset.key = field.key;
    const prev = document.createElement('div');
    prev.className = 'block-preview';
    const shown = field.kind === 'text' ? (field.value || field.name)
      : field.kind === 'checkbox' ? `${field.value ? '☑' : '☐'} ${field.name}`
      : field.kind === 'radio' ? `${field.value ? '◉' : '○'} ${field.name} (${field.exportValue ?? ''})`
      : `${field.name}: ${field.value || '—'}`;
    prev.textContent = shown;
    const meta = document.createElement('div');
    meta.className = 'block-meta';
    const t = document.createElement('span');
    t.className = 'block-tag';
    t.textContent = field.source === 'acroform' ? 'AcroForm' : field.source === 'free' ? 'Free' : 'Auto';
    meta.appendChild(t);
    if (field.dirty && content) { const t2 = document.createElement('span'); t2.className = 'block-tag modified'; t2.textContent = '✓'; meta.appendChild(t2); }
    li.append(prev, meta);
    li.addEventListener('click', () => selectField(field.key));
    list.appendChild(li);
  });
}

function updateFormStatus() {
  const fields = getPageInfo(currentPage).fields || [];
  const acro = fields.filter(f => f.source === 'acroform').length;
  const heu  = fields.filter(f => f.source === 'heuristic').length;
  if (acro) updateFormSidebarStatus(`📋 ${acro} form field(s) detected`, 'success');
  else if (heu) updateFormSidebarStatus(`🔍 ${heu} zone(s) detected`, 'warn');
  else updateFormSidebarStatus('ℹ️ No fields detected — use click mode', 'muted');
}

function updateFormSidebarStatus(msg, type) {
  const el = $('formStatusMsg');
  el.textContent = msg;
  el.className   = 'form-status-msg form-status-' + type;
}

function updateFormBadge() {
  const badge = $('formBadge');
  const count = allFields().filter(f => f.dirty && fieldHasContent(f)).length;
  if (count > 0) { badge.classList.remove('hidden'); badge.textContent = count + ' filled'; }
  else           { badge.classList.add('hidden'); }
}

// ── Click mode (free placement) ─────────────────────────────────────────────
async function onFormClick(e) {
  if (!formClickActive || currentMode !== 'form' || pickState) return;
  if (e.target !== $('pdfCanvas') && e.target !== $('pdfPageWrap') && !e.target.classList.contains('annot-canvas')) return;
  const p = eventToPu(e);
  const page = currentPage;
  await getPageFields(page);            // never lose the detected fields of this page
  if (page !== currentPage) return;
  const fsz = clamp(parseFloat($('formPropSize').value) || 11, 4, 72);
  const h = fsz * LINE_HEIGHT + FIELD_PAD * 2;
  const rect = { x: p.x, y: p.y - h / 2, w: 140, h };
  const bg = sampleRegion(rect, 2);
  const field = {
    key: nextId('free'), page: currentPage, source: 'free', kind: 'text', name: 'Free field',
    rect, value: '', dirty: false,
    style: { font: $('formPropFont').value || 'Helvetica', fontSize: fsz, color: contrastColor(bg.bg), align: 'left', bgMode: 'none', bgColor: bg.bg, bgResolved: bg.bg },
  };
  const info = getPageInfo(currentPage);
  info.fields = [...(info.fields || []), field];
  activeFieldKey = field.key;
  refreshFields();
  openFormPropPanel(field);
  setTimeout(() => { const t = $('formPropText'); t.focus(); t.select(); }, 50);
}

function activateFormClickMode() {
  formClickActive = true;
  $('pdfPageWrap').style.cursor = 'crosshair';
  const btn = $('btnFormClickToggle');
  btn.textContent = '✓ Click mode active — click on the PDF';
  btn.style.background = 'rgba(123,97,255,0.2)';
}

function deactivateFormClickMode() {
  formClickActive = false;
  $('pdfPageWrap').style.cursor = '';
  const btn = $('btnFormClickToggle');
  btn.textContent = '🖱️ Enable click mode';
  btn.style.background = '';
}

$('pdfPageWrap').addEventListener('click', onFormClick);

$('btnFormClickToggle').addEventListener('click', () => {
  if (formClickActive) deactivateFormClickMode(); else activateFormClickMode();
});
$('formApplyProps').addEventListener('click', () => applyFormProps());
$('formPropText').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyFormProps(); }
});
$('formPropText').addEventListener('blur', () => { if (activeFieldKey) applyFormProps({ silent: true }); });
$('formPropChoice').addEventListener('change', () => applyFormProps());
$('formPropCheck').addEventListener('change', async () => {
  const f = activeFieldKey && findField(activeFieldKey);
  if (!f || f.kind !== 'checkbox') return;
  if (!(await _canEdit())) { $('formPropCheck').checked = !!f.value; return; }
  setFieldValue(f, $('formPropCheck').checked);
});
['formPropFont', 'formPropSize', 'formPropColor', 'formPropAlign', 'formPropBgMode', 'formPropBgColor'].forEach(id => {
  $(id).addEventListener('change', () => {
    if (id === 'formPropBgColor' && $('formPropBgMode').value !== 'custom') $('formPropBgMode').value = 'custom';
    const f = activeFieldKey && findField(activeFieldKey);
    if (f && f.dirty) applyFormProps({ silent: true });
    else livePreviewField();
  });
});
$('formPropText').addEventListener('input', livePreviewField);

function livePreviewField() {
  const field = activeFieldKey && findField(activeFieldKey);
  if (!field || field.kind !== 'text') return;
  const el = $('pdfPageWrap').querySelector(`.form-field-overlay[data-key="${CSS.escape(field.key)}"]`);
  const inner = el?.querySelector('.form-field-label > div');
  if (!inner) return;
  const txt = $('formPropText').value;
  inner.textContent = txt || field.name;
  const label = inner.parentElement;
  const sc = viewScale();
  const fs = clamp(parseFloat($('formPropSize').value) || 11, 3, 200);
  label.style.font = buildCanvasFont($('formPropFont').value, fs * sc);
  label.style.lineHeight = String(LINE_HEIGHT);
  label.style.textAlign = $('formPropAlign').value;
  label.style.color = txt ? $('formPropColor').value : 'rgba(150,150,150,0.8)';
}

$('btnFormClear').addEventListener('click', () => {
  for (const info of pageCache.values()) {
    if (!info.fields) continue;
    info.fields = info.fields.filter(f => f.source !== 'free');
    for (const f of info.fields) {
      f.dirty = false;
      f.value = f.kind === 'checkbox' ? (f.initial != null && f.initial === f.exportValue)
              : f.kind === 'radio' ? (f.initial != null && f.initial === f.exportValue)
              : f.kind === 'text' ? (f.source === 'acroform' && typeof f.initial === 'string' ? f.initial : '')
              : (f.initial ?? '');
    }
  }
  activeFieldKey = null;
  $('formPropPanel').style.display = 'none';
  refreshFields();
  webEditorToast('Fields cleared');
});

$('btnFormDeleteField').addEventListener('click', () => { if (activeFieldKey) deleteField(activeFieldKey); });

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURES
// ═══════════════════════════════════════════════════════════════════════════
function initSigCanvas() {
  sigCanvas = $('sigCanvas');
  const rect = sigCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = rect.width || 252, h = rect.height || 100;
  sigCanvas.width  = Math.round(w * dpr);
  sigCanvas.height = Math.round(h * dpr);
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sigCtx.strokeStyle = '#003380';
  sigCtx.lineWidth   = 2.5;
  sigCtx.lineCap     = 'round';
  sigCtx.lineJoin    = 'round';
  sigCanvas.style.touchAction = 'none';

  const pos = e => {
    const r = sigCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (w / r.width), (e.clientY - r.top) * (h / r.height)];
  };
  sigCanvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    sigIsDrawing = true;
    try { sigCanvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    sigCtx.beginPath();
    sigCtx.moveTo(...pos(e));
    sigCtx.lineTo(...pos(e));
    sigCtx.stroke();
    sigHasInk = true;
  });
  sigCanvas.addEventListener('pointermove', e => {
    if (!sigIsDrawing) return;
    sigCtx.lineTo(...pos(e));
    sigCtx.stroke();
  });
  const end = () => { sigIsDrawing = false; };
  sigCanvas.addEventListener('pointerup', end);
  sigCanvas.addEventListener('pointercancel', end);
}

// Crops transparent margins so the signature box fits the ink
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width: w, height: h } = src;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

$('sigClear').addEventListener('click', () => {
  if (sigCtx) { sigCtx.save(); sigCtx.setTransform(1, 0, 0, 1, 0, 0); sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); sigCtx.restore(); }
  sigHasInk = false;
});

$('sigApply').addEventListener('click', async () => {
  if (!sigCanvas || !pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const trimmed = sigHasInk ? trimCanvas(sigCanvas) : null;
  if (!trimmed) { webEditorToast('Draw your signature first', 'error'); return; }
  const allowed = await _canEdit();
  if (!allowed) return;
  placeSigOnPDF(trimmed.toDataURL('image/png'), trimmed.width / trimmed.height);
});

$('sigTextApply').addEventListener('click', async () => {
  const name = $('sigTextInput').value.trim();
  if (!name)   { webEditorToast('Enter your name', 'error'); return; }
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const allowed = await _canEdit();
  if (!allowed) return;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `italic 76px ${$('sigTextFont').value}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 32;
  c.width = Math.min(Math.max(w, 60), 4000); c.height = 130;
  ctx.font = font;
  ctx.fillStyle = $('sigTextColor').value;
  ctx.fillText(name, 16, 92);
  const trimmed = trimCanvas(c) || c;
  placeSigOnPDF(trimmed.toDataURL('image/png'), trimmed.width / trimmed.height);
});

// Any image format the browser can display → PNG (pdf-lib only embeds PNG/JPEG)
function normalizeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const k = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const c = document.createElement('canvas');
      c.width  = Math.max(1, Math.round((img.naturalWidth || 300) * k));
      c.height = Math.max(1, Math.round((img.naturalHeight || 100) * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ dataURL: c.toDataURL('image/png'), ratio: c.width / c.height });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unsupported image')); };
    img.src = url;
  });
}

$('sigImgDrop').addEventListener('click', () => $('sigImgInput').click());
$('sigImgInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  let img;
  try { img = await normalizeImage(f); }
  catch { webEditorToast('❌ This image format is not supported', 'error'); return; }
  const allowed = await _canEdit();
  if (!allowed) return;
  sigImgData = img;
  placeSigOnPDF(img.dataURL, img.ratio);
});

$('sigImgApply').addEventListener('click', async () => {
  if (!sigImgData) { webEditorToast('Choose an image first', 'error'); return; }
  if (!pdfDoc)     { webEditorToast('Open a PDF first', 'error');    return; }
  const allowed = await _canEdit();
  if (!allowed) return;
  placeSigOnPDF(sigImgData.dataURL, sigImgData.ratio);
});

document.querySelectorAll('.sig-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    sigMode = tab.dataset.sig;
    document.querySelectorAll('.sig-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $('sigDraw').classList.toggle('hidden',  sigMode !== 'draw');
    $('sigText').classList.toggle('hidden',  sigMode !== 'text');
    $('sigImage').classList.toggle('hidden', sigMode !== 'image');
    if (sigMode === 'draw' && !sigCtx) initSigCanvas();
  });
});

function placeSigOnPDF(dataURL, ratio = 3) {
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const sc = viewScale();
  const pageW = $('pdfPageWrap').offsetWidth / sc, pageH = $('pdfPageWrap').offsetHeight / sc;
  const w = Math.min(160, pageW * 0.4);
  const h = w / clamp(ratio || 3, 0.2, 12);
  // Place it in the visible part of the page
  const area = $('canvasArea'), wrap = $('pdfPageWrap');
  const visTop = (area.scrollTop - wrap.offsetTop + 40) / sc;
  let x = clamp(pageW * 0.1, 0, pageW - w);
  let y = clamp(visTop, 20, Math.max(20, pageH - h - 20));
  // Never drop a new signature on top of another one: stack it below
  for (let guard = 0; guard < 50; guard++) {
    const hit = signatures.find(s => s.page === currentPage && x < s.x + s.w && s.x < x + w && y < s.y + s.h && s.y < y + h);
    if (!hit || hit.y + hit.h + 8 + h > pageH) break;
    y = hit.y + hit.h + 8;
  }
  const sig = { id: nextId('sig'), page: currentPage, x, y, w, h, dataURL };
  signatures.push(sig);
  activeSigId = sig.id;
  dirtySinceExport = true;
  createSigOverlay(sig);
  webEditorToast('✓ Signature placed — drag to position', 'success');
}

function removeSig(id) {
  signatures = signatures.filter(s => s.id !== id);
  $('pdfPageWrap').querySelector(`.sig-overlay[data-id="${CSS.escape(id)}"]`)?.remove();
  if (activeSigId === id) activeSigId = null;
  webEditorToast('Signature deleted');
}

function createSigOverlay(sig) {
  const wrap = $('pdfPageWrap');
  const sc = viewScale();
  const el = document.createElement('div');
  el.className = 'sig-overlay';
  el.dataset.id = sig.id;
  el.tabIndex = 0;
  const place = r => {
    el.style.left = r.x * sc + 'px'; el.style.top = r.y * sc + 'px';
    el.style.width = r.w * sc + 'px'; el.style.height = r.h * sc + 'px';
  };
  el.style.cssText = 'position:absolute;cursor:move;outline:none;z-index:7;';
  place(sig);
  // Only movable in Sign mode: elsewhere it must not hide the text / fields below
  if (currentMode !== 'sign') {
    el.classList.add('passive');
    el.tabIndex = -1;
  } else if (sig.id === activeSigId) el.style.outline = '2px solid var(--accent)';

  const img = document.createElement('img');
  img.src = sig.dataURL;
  img.alt = 'Signature';
  img.draggable = false;
  img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
  el.appendChild(img);

  const del = document.createElement('div');
  del.className = 'sig-delete';
  del.textContent = '×';
  del.addEventListener('pointerdown', e => e.stopPropagation());
  del.addEventListener('click', e => { e.stopPropagation(); removeSig(sig.id); });
  el.appendChild(del);

  const resize = document.createElement('div');
  resize.className = 'sig-resize';
  el.appendChild(resize);

  const select = () => {
    wrap.querySelectorAll('.sig-overlay').forEach(o => o.style.outline = '');
    activeSigId = sig.id;
    el.style.outline = '2px solid var(--accent)';
    el.focus({ preventScroll: true });
  };
  attachDragResize(el, {
    resizeHandle: resize,
    getRect: () => sig,
    setRect: r => { Object.assign(sig, { x: r.x, y: r.y, w: r.w, h: r.h }); place(sig); },
    onSelect: select,
    minW: 10, minH: 4, keepRatio: true,
  });
  el.addEventListener('dblclick', () => removeSig(sig.id));
  el.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSig(sig.id); }
  });
  el.title = 'Drag to position · Double-click or Delete to remove';
  wrap.appendChild(el);
}

// ═══════════════════════════════════════════════════════════════════════════
// ANNOTATIONS
// ═══════════════════════════════════════════════════════════════════════════
const ANNOT_HINTS = {
  highlight: 'Drag on the PDF to highlight an area. Ctrl+Z to undo.',
  rect: 'Drag to draw a box.',
  pen: 'Draw freehand on the PDF.',
  text: 'Click where the note should start, type, then press Enter (Shift+Enter = new line).',
  cover: 'Drag over content to hide it with the page background color.',
  erase: 'Click an annotation to delete it.',
};

document.querySelectorAll('#annotTools .tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    annotTool = btn.dataset.tool;
    document.querySelectorAll('#annotTools .tool-btn').forEach(b => b.classList.toggle('active', b === btn));
    $('annotHint').textContent = ANNOT_HINTS[annotTool] || '';
    if (annotTool === 'highlight' && $('annotColor').value === '#000000') $('annotColor').value = '#e8ff47';
    if ((annotTool === 'pen' || annotTool === 'rect' || annotTool === 'text') && $('annotColor').value === '#e8ff47') $('annotColor').value = '#d62828';
  });
});

function setupAnnotationCanvas() {
  const wrap = $('pdfPageWrap');
  const pdfC = $('pdfCanvas');
  let ac = wrap.querySelector('.annot-canvas');
  if (!ac) {
    ac = document.createElement('canvas');
    ac.className = 'annot-canvas';
    ac.id = 'annotDrawCanvas';
    wrap.appendChild(ac);
    ac.addEventListener('pointerdown', onAnnotPointerDown);
  }
  ac.width  = pdfC.width;
  ac.height = pdfC.height;
  ac.style.cssText = `position:absolute;left:0;top:0;width:${pdfC.style.width};height:${pdfC.style.height};z-index:${currentMode === 'annotate' ? 20 : 1};touch-action:none;`;
  ac.classList.toggle('active', currentMode === 'annotate');
  ac.getContext('2d').clearRect(0, 0, ac.width, ac.height);
}

function annotCtx() {
  const ac = $('annotDrawCanvas');
  const ctx = ac.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ac.width, ac.height);
  const k = basePr * viewScale();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  return ctx;
}

function annotSettings(sampleRect) {
  const adapt = $('annotAdapt').checked;
  const picked = $('annotColor').value;
  const s = sampleRect ? sampleRegion(sampleRect, 2) : { bg: '#ffffff', bgLum: 1 };
  return {
    adapt, picked, bg: s.bg, bgLum: s.bgLum,
    opacity: clamp(parseFloat($('annotOpacity').value) || 0.35, 0.05, 1),
    width: clamp(parseFloat($('annotWidth').value) || 2, 0.25, 60),
    fontSize: clamp(parseFloat($('annotFontSize').value) || 12, 3, 200),
    stroke: adapt ? ensureContrast(picked, s.bg) : picked,
  };
}

function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function onAnnotPointerDown(e) {
  if (currentMode !== 'annotate' || !pdfDoc || pickState) return;
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const ac = e.currentTarget;
  const p0 = eventToPu(e);

  if (annotTool === 'text') { openTextNoteInput(p0); return; }
  if (annotTool === 'erase') { eraseAt(p0); return; }

  try { ac.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  const pts = [p0];
  let last = p0;
  const draw = () => {
    const ctx = annotCtx();
    const s = annotSettings(null);
    if (annotTool === 'pen') {
      drawAnnotationCanvas(ctx, { type: 'pen', points: pts, color: s.picked, width: s.width });
    } else {
      const r = rectFromPoints(p0, last);
      const preview = annotTool === 'highlight' ? { type: 'highlight', rect: r, color: s.picked, opacity: s.opacity, blend: 'source-over' }
        : annotTool === 'rect' ? { type: 'rect', rect: r, color: s.picked, width: s.width }
        : { type: 'rect', rect: r, color: '#7b61ff', width: 1, dash: true };
      drawAnnotationCanvas(ctx, preview);
    }
  };
  const move = ev => {
    last = eventToPu(ev);
    if (annotTool === 'pen') {
      const prev = pts[pts.length - 1];
      if (Math.hypot(last.x - prev.x, last.y - prev.y) >= 0.6) pts.push(last);
    }
    draw();
  };
  const up = ev => {
    ac.removeEventListener('pointermove', move);
    ac.removeEventListener('pointerup', up);
    ac.removeEventListener('pointercancel', up);
    last = eventToPu(ev);
    annotCtx();   // clear preview
    let annot = null;
    if (annotTool === 'pen') {
      if (pts.length === 1) pts.push({ x: p0.x + 0.3, y: p0.y + 0.3 });
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const s = annotSettings({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 });
      annot = { type: 'pen', points: pts, color: s.stroke, width: s.width };
    } else {
      const r = rectFromPoints(p0, last);
      if (r.w < 2 || r.h < 2) return;
      const s = annotSettings(r);
      if (annotTool === 'highlight') annot = { type: 'highlight', rect: r, color: s.picked, opacity: s.opacity, blend: s.adapt && s.bgLum < 0.35 ? 'screen' : 'multiply' };
      else if (annotTool === 'rect') annot = { type: 'rect', rect: r, color: s.stroke, width: s.width };
      else if (annotTool === 'cover') annot = { type: 'cover', rect: r, color: s.bg };
    }
    if (annot) addAnnotation(annot);
  };
  ac.addEventListener('pointermove', move);
  ac.addEventListener('pointerup', up);
  ac.addEventListener('pointercancel', up);
}

function addAnnotation(a) {
  a.id = nextId('an');
  a.page = currentPage;
  annotations.push(a);
  dirtySinceExport = true;
  composite();
  updateAnnotBadge();
}

let pendingNote = null;
function openTextNoteInput(p) {
  commitPendingInputs();
  const sc = viewScale();
  const s = annotSettings({ x: p.x, y: p.y, w: 60, h: 14 });
  const ta = document.createElement('textarea');
  ta.className = 'annot-note-input';
  ta.rows = 1;
  ta.style.cssText = `position:absolute;left:${p.x * sc}px;top:${p.y * sc}px;z-index:30;min-width:${80 * sc}px;`
    + `font:${buildCanvasFont('Helvetica', s.fontSize * sc)};line-height:${LINE_HEIGHT};color:${s.stroke};`
    + `background:rgba(232,255,71,0.08);border:1px dashed var(--accent);outline:none;resize:both;padding:0;overflow:hidden;`;
  $('pdfPageWrap').appendChild(ta);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(80 * sc, Math.min(ta.scrollWidth + 8, 900)) + 'px'; };
  ta.addEventListener('input', autosize);
  pendingNote = { ta, p, s };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitPendingInputs(); }
    if (e.key === 'Escape') { e.preventDefault(); pendingNote = null; ta.remove(); }
    e.stopPropagation();
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (pendingNote?.ta === ta) commitPendingInputs(); }, 0));
  ta.focus({ preventScroll: true });
  setTimeout(() => { if (pendingNote?.ta === ta && document.activeElement !== ta) ta.focus({ preventScroll: true }); }, 0);
}

function commitPendingInputs() {
  if (activeFieldKey && currentMode === 'form') applyFormProps({ silent: true });
  if (!pendingNote) return;
  const { ta, p, s } = pendingNote;
  pendingNote = null;
  const text = sanitizeText(ta.value).replace(/\s+$/, '');
  ta.remove();
  if (!text) return;
  addAnnotation({ type: 'text', x: p.x, y: p.y, text, fontSize: s.fontSize, color: s.stroke, font: 'Helvetica' });
}

function annotBounds(a) {
  if (a.rect) return a.rect;
  if (a.type === 'pen') {
    const xs = a.points.map(p => p.x), ys = a.points.map(p => p.y);
    const m = a.width / 2 + 2;
    return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m };
  }
  if (a.type === 'text') {
    const lines = a.text.split('\n');
    const w = Math.max(...lines.map(l => l.length)) * a.fontSize * 0.55;
    return { x: a.x, y: a.y, w, h: lines.length * a.fontSize * LINE_HEIGHT };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function eraseAt(p) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.page !== currentPage) continue;
    const b = annotBounds(a);
    if (p.x >= b.x - 2 && p.x <= b.x + b.w + 2 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2) {
      annotations.splice(i, 1);
      composite();
      updateAnnotBadge();
      webEditorToast('Annotation deleted');
      return;
    }
  }
}

function undoAnnotation() {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (annotations[i].page === currentPage) {
      annotations.splice(i, 1);
      composite();
      updateAnnotBadge();
      return true;
    }
  }
  return false;
}

function drawAnnotationCanvas(ctx, a) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (a.type === 'highlight') {
    ctx.globalCompositeOperation = a.blend === 'screen' ? 'screen' : a.blend === 'source-over' ? 'source-over' : 'multiply';
    ctx.globalAlpha = a.opacity ?? 0.35;
    ctx.fillStyle = a.color;
    ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
  } else if (a.type === 'rect') {
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width || 1;
    if (a.dash) ctx.setLineDash([4, 3]);
    ctx.strokeRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
  } else if (a.type === 'cover') {
    ctx.fillStyle = a.color;
    ctx.fillRect(a.rect.x, a.rect.y, a.rect.w, a.rect.h);
  } else if (a.type === 'pen') {
    ctx.strokeStyle = a.color;
    ctx.lineWidth = a.width || 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    a.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  } else if (a.type === 'text') {
    ctx.fillStyle = a.color;
    ctx.font = buildCanvasFont(a.font || 'Helvetica', a.fontSize);
    ctx.textBaseline = 'alphabetic';
    a.text.split('\n').forEach((ln, i) => ctx.fillText(ln, a.x, a.y + a.fontSize * BASELINE_RATIO + i * a.fontSize * LINE_HEIGHT));
  }
  ctx.restore();
}

function updateAnnotBadge() {
  const b = $('annotBadge');
  if (!b) return;
  if (annotations.length) { b.classList.remove('hidden'); b.textContent = annotations.length; }
  else b.classList.add('hidden');
}

$('btnAnnotUndo').addEventListener('click', () => { if (!undoAnnotation()) webEditorToast('Nothing to undo on this page'); });
$('btnAnnotateClear').addEventListener('click', () => {
  annotations = annotations.filter(a => a.page !== currentPage);
  composite();
  updateAnnotBadge();
  webEditorToast('✓ Annotations cleared for this page');
});

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT — build the modified PDF (source of truth)
// ═══════════════════════════════════════════════════════════════════════════
function sanitizeText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​﻿]/g, '');
}

function hasChanges() {
  return textEdits.size > 0 || annotations.length > 0 || signatures.length > 0 ||
    allFields().some(f => f.dirty && (f.source === 'acroform' || fieldHasContent(f)));
}

// Maps page units (display space at scale 1) to a target page user space.
function mapperFrom(origin, angleRad) {
  const ux = Math.cos(angleRad), uy = Math.sin(angleRad);
  const vx = -uy, vy = ux;
  const deg = angleRad * 180 / Math.PI;
  return {
    deg,
    pt: (x, y) => ({ x: origin[0] + x * ux - y * vx, y: origin[1] + x * uy - y * vy }),
    rect(r) { const p = this.pt(r.x, r.y + r.h); return { x: p.x, y: p.y, width: r.w, height: r.h, rotate: PDFLib.degrees(deg) }; },
  };
}

function viewportMapper(vp1) {
  const o = vp1.convertToPdfPoint(0, 0);
  const p = vp1.convertToPdfPoint(1, 0);
  return mapperFrom(o, Math.atan2(p[1] - o[1], p[0] - o[0]));
}

const FONT_MAP_STD = {
  'Helvetica':             'Helvetica',
  'Helvetica-Bold':        'HelveticaBold',
  'Helvetica-Oblique':     'HelveticaOblique',
  'Helvetica-BoldOblique': 'HelveticaBoldOblique',
  'Times-Roman':           'TimesRoman',
  'Times-Bold':            'TimesBold',
  'Times-Italic':          'TimesItalic',
  'Times-BoldItalic':      'TimesBoldItalic',
  'Courier':               'Courier',
  'Courier-Bold':          'CourierBold',
  'Courier-Oblique':       'CourierOblique',
};

const FONT_MAP_GF = {
  'Inter':           'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2',
  'Inter-Bold':      'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuI6fAZ9hiJ-Ek-_EeA.woff2',
  'Roboto':          'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff2',
  'Roboto-Bold':     'https://fonts.gstatic.com/s/roboto/v30/KFOlCnqEu92Fr1MmWUlfBBc4AMP6lQ.woff2',
  'Roboto-Italic':   'https://fonts.gstatic.com/s/roboto/v30/KFOkCnqEu92Fr1Mu51xIIzIXKMny.woff2',
  'OpenSans':        'https://fonts.gstatic.com/s/opensans/v40/memSYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsjZ0B4gaVc.woff2',
  'OpenSans-Bold':   'https://fonts.gstatic.com/s/opensans/v40/memSYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsg-1x4gaVc.woff2',
  'Lato':            'https://fonts.gstatic.com/s/lato/v24/S6uyw4BMUTPHjx4wXiWtFCc.woff2',
  'Lato-Bold':       'https://fonts.gstatic.com/s/lato/v24/S6u9w4BMUTPHh6UVSwiPGQ3q5d0.woff2',
  'Montserrat':      'https://fonts.gstatic.com/s/montserrat/v26/JTUSjIg1_i6t8kCHKm459WlhyyTh89Y.woff2',
  'Montserrat-Bold': 'https://fonts.gstatic.com/s/montserrat/v26/JTUSjIg1_i6t8kCHKm459WdhyyTh89Y.woff2',
  'Poppins':         'https://fonts.gstatic.com/s/poppins/v21/pxiEyp8kv8JHgFVrJJfecg.woff2',
  'Poppins-Bold':    'https://fonts.gstatic.com/s/poppins/v21/pxiByp8kv8JHgFVrLCz7Z1xlFd2JQEk.woff2',
  'Nunito':          'https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofiOc5wtlZ2di8HDFwmdTo3jQ.woff2',
  'Raleway':         'https://fonts.gstatic.com/s/raleway/v34/1Ptug8zYS_SKggPNyC0ITw.woff2',
  'Oswald':          'https://fonts.gstatic.com/s/oswald/v53/TK3_WkUHHAIjg75cFRf3bXL8LICs1_Fvsrm4.woff2',
  'DMSans':          'https://fonts.gstatic.com/s/dmsans/v15/rP2Hp2ywxg089UriCZOIHTWEBlwu8Q.woff2',
  'Merriweather':    'https://fonts.gstatic.com/s/merriweather/v30/u-440qyriQwlOrhSvowK_l5-fCZM.woff2',
  'Merriweather-Bold':'https://fonts.gstatic.com/s/merriweather/v30/u-4n0qyriQwlOrhSvowK_l52xwNZWMf_.woff2',
  'Playfair':        'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvXDXbtM.woff2',
  'Playfair-Bold':   'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKd3unDXbtM.woff2',
  'Lora':            'https://fonts.gstatic.com/s/lora/v35/0QI6MX1D_JOxE7fSWoO4Iegx.woff2',
  'Lora-Bold':       'https://fonts.gstatic.com/s/lora/v35/0QI6MX1D_JOxE7fSWoO4Iegx.woff2',
  'PTSerif':         'https://fonts.gstatic.com/s/ptserif/v18/EJRVQgYoZZY2vCFuvAFWzr-_dSb_.woff2',
  'CrimsonPro':      'https://fonts.gstatic.com/s/crimsonpro/v24/q5uUsoa5M_tv7IihmnkabC5XiXCAlXGks1WZTm18OJE_VNWoyQ.woff2',
  'FiraCode':        'https://fonts.gstatic.com/s/firacode/v22/uU9eCBsR6Z2vfE9aq3bL0fxyUs4tcw4W_D1sJVD7MOzlojwUKaJhhvA.woff2',
  'JetBrainsMono':   'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjOVmNIAWMtBBGg5.woff2',
  'SourceCodePro':   'https://fonts.gstatic.com/s/sourcecodepro/v23/HI_diYsKILxRpg3hIP6sJ7fM7PqlPevWnsUnxlC9.woff2',
  'BebasNeue':       'https://fonts.gstatic.com/s/bebasneue/v14/JTUSjIg69CK48gW7PXoo9WlhyyTh89Y.woff2',
  'Righteous':       'https://fonts.gstatic.com/s/righteous/v17/1cXxaUPXBpj2rGoU7C9mj3uEicG01A.woff2',
  'Pacifico':        'https://fonts.gstatic.com/s/pacifico/v22/FwZY7-Qmy14u9lezJ96A4sijpFu_.woff2',
  'Lobster':         'https://fonts.gstatic.com/s/lobster/v30/neILzCirqoswsqX9zoymM4MwWJU.woff2',
  'GreatVibes':      'https://fonts.gstatic.com/s/greatvibes/v19/RWmMoKWR9v4ksMfaWd_JN9XFiaQ.woff2',
  'DancingScript':   'https://fonts.gstatic.com/s/dancingscript/v25/If2cXTr6YS-zF4S-kcSWSVi_sxjsohD9F50Ruu7BMSo3ROp6.woff2',
};

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.arrayBuffer();
  } finally { clearTimeout(t); }
}

// Fonts for export. Text a standard font cannot encode (e.g. "ł", Cyrillic,
// Greek, "→") used to abort the whole export ("WinAnsi cannot encode");
// it now switches to an embedded Unicode font (Liberation Sans).
class FontManager {
  constructor(doc) { this.doc = doc; this.cache = new Map(); }

  async get(name) {
    name = name || 'Helvetica';
    if (this.cache.has(name)) return this.cache.get(name);
    let font;
    if (FONT_MAP_STD[name]) {
      font = await this.doc.embedFont(PDFLib.StandardFonts[FONT_MAP_STD[name]]);
    } else if (FONT_MAP_GF[name] && typeof fontkit !== 'undefined') {
      try { font = await this.doc.embedFont(await fetchWithTimeout(FONT_MAP_GF[name])); }
      catch (e) { console.warn('[Folio] Font fetch failed for', name, '— fallback Helvetica', e); }
    }
    if (!font) font = await this.get('Helvetica');
    this.cache.set(name, font);
    return font;
  }

  async unicode(name) {
    const n = String(name || '');
    const bold = /bold/i.test(n), italic = /italic|oblique/i.test(n);
    const variant = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
    const key = 'unicode:' + variant;
    if (this.cache.has(key)) return this.cache.get(key);
    let font = null;
    if (typeof fontkit !== 'undefined') {
      try {
        const bytes = await fetchWithTimeout(LIB_BASE + `pdfjs/standard_fonts/LiberationSans-${variant}.ttf`);
        font = await this.doc.embedFont(bytes, { subset: true });
      } catch (e) { console.warn('[Folio] Unicode font unavailable:', e); }
    }
    this.cache.set(key, font);
    return font;
  }

  canEncode(font, text) {
    if (!font) return false;
    const plain = text.replace(/\n/g, '');
    if (!plain) return true;
    try {
      const fk = font.embedder?.font;
      if (fk && typeof fk.hasGlyphForCodePoint === 'function') {
        for (const ch of plain) if (!fk.hasGlyphForCodePoint(ch.codePointAt(0))) return false;
        return true;
      }
      font.encodeText(plain);
      return true;
    } catch { return false; }
  }

  async std(key) {
    const k = 'std:' + key;
    if (!this.cache.has(k)) this.cache.set(k, await this.doc.embedFont(PDFLib.StandardFonts[key]));
    return this.cache.get(k);
  }

  // Fonts able to draw `text`: chosen font, then Unicode (Liberation Sans),
  // ZapfDingbats (✓ ✔ ✗ ★) and Symbol (math, Greek) for the missing characters.
  async chainFor(name, rawText) {
    const text = sanitizeText(rawText).replace(/\n/g, '');
    const primary = await this.get(name);
    if (this.canEncode(primary, text)) return [primary];
    const uni = await this.unicode(name);
    // Liberation Sans is metric-compatible with Helvetica: use it for whole
    // lines (clean copy/paste); other fonts keep their look char by char.
    const helvetica = /^Helvetica/.test(name) || (!FONT_MAP_STD[name] && !FONT_MAP_GF[name]);
    const chain = helvetica && uni ? [uni, primary] : [primary, uni];
    chain.push(await this.std('ZapfDingbats'), await this.std('Symbol'));
    return chain.filter(Boolean);
  }

  // Splits one line into runs drawable with a single font each
  runs(chain, line) {
    if (chain.length === 1 || this.canEncode(chain[0], line)) return [{ font: chain[0], text: line }];
    const out = [];
    for (const ch of line) {
      let font = chain.find(f => this.canEncode(f, ch));
      let c = ch;
      if (!font) { font = chain[0]; c = this.canEncode(font, '?') ? '?' : ''; }
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += c; else out.push({ font, text: c });
    }
    return out;
  }

  width(chain, line, size) {
    let w = 0;
    for (const r of this.runs(chain, line)) {
      try { w += r.font.widthOfTextAtSize(r.text, size); } catch { w += r.text.length * size * 0.5; }
    }
    return w;
  }

  // Draws one line starting at (x, y) = baseline in page units, rotated `rot`° ccw
  drawLine(page, M, chain, line, x, y, size, color, rot = 0) {
    const a = rot * Math.PI / 180;
    let adv = 0;
    for (const r of this.runs(chain, line)) {
      if (!r.text) continue;
      const P = M.pt(x + adv * Math.cos(a), y - adv * Math.sin(a));
      page.drawText(r.text, { x: P.x, y: P.y, size, font: r.font, color, rotate: PDFLib.degrees(M.deg + rot) });
      try { adv += r.font.widthOfTextAtSize(r.text, size); } catch { adv += r.text.length * size * 0.5; }
    }
  }

  // → { font, text } drawable with a single font (AcroForm appearances)
  async prepare(name, rawText) {
    const text = sanitizeText(rawText);
    const font = await this.get(name);
    if (this.canEncode(font, text)) return { font, text };
    const uni = await this.unicode(name);
    if (uni && this.canEncode(uni, text)) return { font: uni, text };
    // Last resort: drop the characters no available font can draw
    const target = uni || font;
    let out = '';
    for (const ch of text) out += (ch === '\n' || this.canEncode(target, ch)) ? ch : (this.canEncode(target, '?') ? '?' : '');
    return { font: target, text: out };
  }
}

function wrapLines(text, width, maxWidth) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para) { out.push(''); continue; }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const candidate = line + w;
      if (!line || width(candidate) <= maxWidth) { line = candidate; continue; }
      out.push(line.replace(/\s+$/, ''));
      line = w.replace(/^\s+/, '');
      // Hard-break words longer than the box
      while (line && width(line) > maxWidth && line.length > 1) {
        let i = line.length - 1;
        while (i > 1 && width(line.slice(0, i)) > maxWidth) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

// Rebuilds pages as images (used when the PDF can be displayed but not rewritten)
async function buildRasterDoc(pageNumbers = null, label = 'Rebuilding pages') {
  const doc = await PDFLib.PDFDocument.create();
  const nums = pageNumbers || Array.from({ length: totalPages }, (_, i) => i + 1);
  const mappers = new Map();
  for (let i = 0; i < nums.length; i++) {
    showLoading(`${label} ${i + 1}/${nums.length}…`);
    const page = await pdfDoc.getPage(nums[i]);
    const vp1  = page.getViewport({ scale: 1 });
    const sc   = clamp(Math.sqrt(10_000_000 / (vp1.width * vp1.height)), 0.5, 2.5);
    const vp   = page.getViewport({ scale: sc });
    const c    = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(vp.width)); c.height = Math.max(1, Math.floor(vp.height));
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const jpg  = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
    const img  = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
    const p    = doc.addPage([vp1.width, vp1.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    mappers.set(nums[i], mapperFrom([0, vp1.height], 0));
    c.width = c.height = 0;
  }
  return { doc, mappers };
}

async function buildModifiedPdfBytes({ forceRaster = false } = {}) {
  commitPendingInputs();
  let doc = null, mapperFor, native = false;
  if (exportMode === 'native' && !forceRaster) {
    try {
      doc = await PDFLib.PDFDocument.load(workBytes, PDFLIB_LOAD_OPTS);
      native = true;
      const vpCache = new Map();
      mapperFor = async n => {
        if (!vpCache.has(n)) vpCache.set(n, viewportMapper((await pdfDoc.getPage(n)).getViewport({ scale: 1 })));
        return vpCache.get(n);
      };
    } catch (e) { console.warn('[Folio] native export unavailable:', e); doc = null; }
  }
  if (!doc) {
    const r = await buildRasterDoc();
    doc = r.doc;
    mapperFor = async n => r.mappers.get(n);
  }
  if (typeof fontkit !== 'undefined') doc.registerFontkit(fontkit);
  const fonts = new FontManager(doc);

  try {
    await drawAllChanges(doc, fonts, mapperFor, native);
    showLoading('Saving PDF…');
    return await safeSave(doc);
  } catch (e) {
    if (!native) throw e;
    // Anything unexpected with this PDF's structure → rebuild from rendering
    console.warn('[Folio] native export failed, falling back to rebuilt pages:', e);
    webEditorToast('⚠️ This PDF could not be rewritten directly — exporting rebuilt pages', 'error');
    return buildModifiedPdfBytes({ forceRaster: true });
  }
}

async function drawAllChanges(doc, fonts, mapperFor, native) {
  const pageOf = n => doc.getPage(n - 1);

  // 1. Text edits: cover (adapted background) + new text
  for (const e of textEdits.values()) {
    const page = pageOf(e.page);
    const M = await mapperFor(e.page);
    const O = M.pt(0, 0), path = polyPath(coverPoly(e));
    page.drawSvgPath(path, { x: O.x, y: O.y, rotate: PDFLib.degrees(M.deg), color: rgbLib(e.coverColor || '#ffffff'), borderWidth: 0 });
    if (e.bgOpacity > 0) page.drawSvgPath(path, { x: O.x, y: O.y, rotate: PDFLib.degrees(M.deg), color: rgbLib(e.bgColor), opacity: e.bgOpacity, borderWidth: 0 });
    if (!e.text) continue;
    const text  = sanitizeText(e.text);
    const chain = await fonts.chainFor(e.fontName, text);
    const rot = e.rotation || 0, a = rot * Math.PI / 180, lh = e.fontSize * LINE_HEIGHT;
    text.split('\n').forEach((line, i) => {
      fonts.drawLine(page, M, chain, line,
        e.baseline.x + i * lh * Math.sin(a), e.baseline.y + i * lh * Math.cos(a),
        e.fontSize, rgbLib(e.color), rot);
    });
  }

  // 2. Annotations (in creation order)
  for (const a of annotations) {
    const page = pageOf(a.page);
    const M = await mapperFor(a.page);
    if (a.type === 'highlight') {
      page.drawRectangle({ ...M.rect(a.rect), color: rgbLib(a.color), opacity: a.opacity ?? 0.35,
        blendMode: a.blend === 'screen' ? PDFLib.BlendMode.Screen : PDFLib.BlendMode.Multiply });
    } else if (a.type === 'rect') {
      page.drawRectangle({ ...M.rect(a.rect), borderColor: rgbLib(a.color), borderWidth: a.width || 1 });
    } else if (a.type === 'cover') {
      page.drawRectangle({ ...M.rect(a.rect), color: rgbLib(a.color) });
    } else if (a.type === 'pen') {
      const O = M.pt(0, 0);
      const d = a.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      page.drawSvgPath(d, { x: O.x, y: O.y, rotate: PDFLib.degrees(M.deg), borderColor: rgbLib(a.color),
        borderWidth: a.width || 2, borderLineCap: PDFLib.LineCapStyle.Round });
    } else if (a.type === 'text') {
      const text  = sanitizeText(a.text);
      const chain = await fonts.chainFor(a.font || 'Helvetica', text);
      text.split('\n').forEach((line, i) => {
        fonts.drawLine(page, M, chain, line, a.x, a.y + a.fontSize * BASELINE_RATIO + i * a.fontSize * LINE_HEIGHT, a.fontSize, rgbLib(a.color));
      });
    }
  }

  // 3. Form fields
  let form = null;
  if (native) { try { form = doc.getForm(); } catch (e) { console.warn('[Folio] getForm:', e); } }
  const handledRadio = new Set();
  for (const f of allFields()) {
    if (!f.dirty) continue;
    if (f.source === 'acroform' && form) {
      if (f.kind === 'radio') {
        if (handledRadio.has(f.name)) continue;
        const chosen = allFields().find(x => x.kind === 'radio' && x.name === f.name && x.value);
        handledRadio.add(f.name);
        if (chosen && await setAcroField(form, chosen, fonts)) continue;
        if (chosen) await drawFieldFlat(pageOf(chosen.page), chosen, fonts, await mapperFor(chosen.page));
        continue;
      }
      if (await setAcroField(form, f, fonts)) continue;
    }
    if (f.kind === 'radio' && !f.value) continue;
    await drawFieldFlat(pageOf(f.page), f, fonts, await mapperFor(f.page));
  }
  if (form && $('formFlatten').checked) {
    try { form.flatten({ updateFieldAppearances: true }); }
    catch (e) { console.warn('[Folio] flatten failed:', e); webEditorToast('⚠️ Some fields could not be flattened', 'error'); }
  }

  // 4. Signatures (on top)
  for (const s of signatures) {
    const page = pageOf(s.page);
    const M = await mapperFor(s.page);
    const b64 = (s.dataURL || '').split(',')[1];
    if (!b64) continue;
    const bytes = base64ToBytes(b64);
    let img;
    try { img = s.dataURL.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); }
    catch { img = await doc.embedPng(bytes); }
    page.drawImage(img, M.rect(s));
  }
}

async function setAcroField(form, f, fonts) {
  let field;
  try { field = form.getField(f.name); } catch { return false; }
  try {
    if (f.kind === 'text' && field instanceof PDFLib.PDFTextField) {
      const { font, text } = await fonts.prepare(f.style.font, f.value || '');
      try {
        const c = parseHex(f.style.color || '#000000');
        field.acroField.setDefaultAppearance(`/Helv ${f.style.fontSize} Tf ${(c.r / 255).toFixed(3)} ${(c.g / 255).toFixed(3)} ${(c.b / 255).toFixed(3)} rg`);
      } catch { /* keep the field's own appearance settings */ }
      field.setText(text || undefined);
      field.updateAppearances(font);
      const exact = sanitizeText(f.value || '');
      if (exact && exact !== text) {
        try { field.acroField.setValue(PDFLib.PDFHexString.fromText(exact)); } catch { /* keep drawable value */ }
      }
      return true;
    }
    if (f.kind === 'checkbox' && field instanceof PDFLib.PDFCheckBox) {
      if (f.value) field.check(); else field.uncheck();
      return true;
    }
    if (f.kind === 'radio' && field instanceof PDFLib.PDFRadioGroup) {
      if (f.value && f.exportValue != null) field.select(String(f.exportValue));
      return true;
    }
    if (f.kind === 'choice' && (field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList)) {
      if (f.value) field.select(String(f.value)); else field.clear();
      return true;
    }
  } catch (e) {
    console.warn('[Folio] AcroForm fill failed for', f.name, '— drawing it instead:', e.message);
    try { form.markFieldAsClean(field.ref); } catch { /* ignore */ }
  }
  return false;
}

async function drawFieldFlat(page, f, fonts, M) {
  const st = f.style;
  const bg = resolveFieldBg(f);
  const color = rgbLib(st.color || '#000000');
  if (bg && (fieldHasContent(f) || f.source === 'acroform')) {
    page.drawRectangle({ ...M.rect(f.rect), color: rgbLib(bg) });
  }
  if (f.kind === 'checkbox') {
    if (!f.value) return;
    const r = f.rect, s = Math.min(r.w, r.h) * 0.7;
    const x0 = r.x + (r.w - s) / 2, y0 = r.y + (r.h - s) / 2;
    const O = M.pt(0, 0);
    const d = `M ${x0 + s * 0.1} ${y0 + s * 0.55} L ${x0 + s * 0.4} ${y0 + s * 0.85} L ${x0 + s * 0.9} ${y0 + s * 0.15}`;
    page.drawSvgPath(d, { x: O.x, y: O.y, rotate: PDFLib.degrees(M.deg), borderColor: color, borderWidth: Math.max(s * 0.12, 0.8), borderLineCap: PDFLib.LineCapStyle.Round });
    return;
  }
  if (f.kind === 'radio') {
    if (!f.value) return;
    const c = M.pt(f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2);
    page.drawCircle({ x: c.x, y: c.y, size: Math.min(f.rect.w, f.rect.h) * 0.25, color });
    return;
  }
  const raw = f.kind === 'choice' ? (f.options?.find(o => o.value === f.value)?.label ?? f.value ?? '') : (f.value || '');
  if (!raw.trim()) return;
  const text  = sanitizeText(raw);
  const chain = await fonts.chainFor(st.font, text);
  const size = st.fontSize;
  const lh = size * LINE_HEIGHT;
  const maxW = Math.max(f.rect.w - FIELD_PAD * 2, size);
  const widthOf = s => fonts.width(chain, s, size);
  const lines = wrapLines(text, widthOf, maxW);
  const single = f.rect.h < lh * 2;
  const blockH = lines.length * lh;
  const top = single ? f.rect.y + (f.rect.h - blockH) / 2 : f.rect.y + FIELD_PAD;
  lines.forEach((ln, i) => {
    if (!ln) return;
    const w = widthOf(ln);
    const x = st.align === 'center' ? f.rect.x + (f.rect.w - w) / 2
            : st.align === 'right'  ? f.rect.x + f.rect.w - FIELD_PAD - w
            : f.rect.x + FIELD_PAD;
    fonts.drawLine(page, M, chain, ln, x, top + i * lh + (lh - size) / 2 + size * 0.8, size, color);
  });
}

function outputName(suffix) {
  const base = (fileName || 'document.pdf').replace(/\.pdf$/i, '');
  return `${base}${suffix}.pdf`;
}

$('btnExport').addEventListener('click', async () => {
  if (!pdfDoc) { webEditorToast('No PDF loaded', 'error'); return; }
  if (currentMode === 'extract') { $('btnExtractDo').click(); return; }
  if (currentMode === 'merge')   { $('btnMergeDo').click();   return; }
  if (currentMode === 'convert') { $('btnConvertDo').click(); return; }

  if (currentMode === 'form' && activeFieldKey) await applyFormProps({ silent: true });
  showLoading('Building modified PDF…');
  try {
    const bytes = await buildModifiedPdfBytes();
    downloadBytes(bytes, outputName('-edited'));
    dirtySinceExport = false;
    hideLoading();
    const filled = allFields().filter(f => f.dirty).length;
    webEditorToast(`✓ PDF exported (${textEdits.size} edit(s), ${filled} field(s), ${signatures.length} signature(s), ${annotations.length} annotation(s))`, 'success');
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Export failed: ' + e.message, 'error');
    console.error('[Folio] export error:', e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION, ZOOM, MODES
// ═══════════════════════════════════════════════════════════════════════════
$('prevPage').addEventListener('click', () => { if (currentPage > 1)          renderPage(currentPage - 1); });
$('nextPage').addEventListener('click', () => { if (currentPage < totalPages) renderPage(currentPage + 1); });

function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { cancelPick(); if (formClickActive) deactivateFormClickMode(); }
  if (isTypingTarget(e.target)) return;
  if (document.getElementById('folio-payment-modal') || document.getElementById('folio-pw-modal')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && currentMode === 'annotate') {
    e.preventDefault();
    undoAnnotation();
    return;
  }
  if (e.target.closest?.('.form-field-overlay, .sig-overlay')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && currentMode === 'sign' && activeSigId && signatures.some(s => s.id === activeSigId && s.page === currentPage)) {
    e.preventDefault();
    removeSig(activeSigId);
    return;
  }
  if (!pdfDoc) return;
  if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   { if (currentPage > 1)          renderPage(currentPage - 1); }
  if (e.key === 'ArrowRight' || e.key === 'PageDown') { if (currentPage < totalPages) renderPage(currentPage + 1); }
  if (e.key === '+' || e.key === '=') { zoom = Math.min(+(zoom + 0.15).toFixed(2), 3);   updateZoom(); }
  if (e.key === '-')                   { zoom = Math.max(+(zoom - 0.15).toFixed(2), 0.3); updateZoom(); }
});

$('zoomIn').addEventListener('click',  () => { zoom = Math.min(+(zoom + 0.15).toFixed(2), 3);   updateZoom(); });
$('zoomOut').addEventListener('click', () => { zoom = Math.max(+(zoom - 0.15).toFixed(2), 0.3); updateZoom(); });

function updateZoom() {
  $('zoomVal').textContent = Math.round(zoom * 100) + '%';
  if (pdfDoc) renderPage(currentPage);
}

document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

function switchMode(mode) {
  if (!MODES.includes(mode)) mode = 'edit';
  commitPendingInputs();
  cancelPick();
  if (currentMode === 'form' && mode !== 'form' && activeFieldKey) applyFormProps({ silent: true });
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode)
  );
  ['Edit','Sign','Annotate','Extract','Merge','Convert','Form'].forEach(m =>
    $('sidebar' + m)?.classList.add('hidden')
  );
  const TARGET = {
    edit: 'sidebarEdit', sign: 'sidebarSign', annotate: 'sidebarAnnotate',
    extract: 'sidebarExtract', merge: 'sidebarMerge', convert: 'sidebarConvert',
    form: 'sidebarForm',
  };
  $(TARGET[mode])?.classList.remove('hidden');

  const LABELS = {
    edit: '↓ Export PDF', sign: '↓ Export PDF', annotate: '↓ Export PDF',
    extract: '✂ Extract', merge: '🔀 Merge', convert: '⚡ Convert',
    form: '↓ Export PDF',
  };
  $('btnExport').textContent = LABELS[mode] || '↓ Export PDF';

  if (mode !== 'form' && formClickActive) deactivateFormClickMode();
  if (mode !== 'edit') { draftEdit = null; }
  if (mode === 'sign' && !sigCtx) initSigCanvas();

  if (pdfDoc) {
    composite();
    buildOverlays();
  }
  if (mode === 'extract'  && pdfDoc && !$('thumbGrid').children.length) buildThumbnails();
  if (mode === 'merge'    && workBytes) syncMergeCurrentFile(fileName);
}

// ═══════════════════════════════════════════════════════════════════════════
// THUMBNAILS / EXTRACT
// ═══════════════════════════════════════════════════════════════════════════
let thumbSeq = 0;
async function buildThumbnails() {
  if (!pdfDoc) return;
  const seq = ++thumbSeq;
  const grid = $('thumbGrid');
  grid.innerHTML = '';
  selExtract.clear();

  for (let i = 1; i <= totalPages; i++) {
    if (seq !== thumbSeq) return;
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.page = i;
    const cw = document.createElement('div');
    cw.className = 'thumb-canvas-wrap';
    const num = document.createElement('div');
    num.className = 'thumb-num';
    num.textContent = `Page ${i}`;
    item.append(cw, num);
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      if (item.classList.contains('selected')) selExtract.add(i);
      else selExtract.delete(i);
    });
    grid.appendChild(item);
    try {
      const page = await pdfDoc.getPage(i);
      const vp   = page.getViewport({ scale: 0.18 });
      const c    = document.createElement('canvas');
      c.width = Math.max(1, vp.width); c.height = Math.max(1, vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      cw.appendChild(c);
    } catch (e) {
      cw.textContent = '⚠️';
    }
  }
}

// Returns a pdf-lib document with the current content (edits included)
async function currentDocForCopy(pageNumbers) {
  if (hasChanges()) {
    const bytes = await buildModifiedPdfBytes();
    return PDFLib.PDFDocument.load(bytes, PDFLIB_LOAD_OPTS);
  }
  if (pdfLibDoc) return pdfLibDoc;
  return (await buildRasterDoc(pageNumbers)).doc;
}

$('btnExtractDo').addEventListener('click', async () => {
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  if (!selExtract.size) { webEditorToast('Select at least one page', 'error'); return; }
  const allowed = await _canEdit();
  if (!allowed) return;
  showLoading('Extracting pages…');
  try {
    const pages  = Array.from(selExtract).sort((a, b) => a - b);
    const newDoc = await PDFLib.PDFDocument.create();
    let src, indices;
    if (!hasChanges() && !pdfLibDoc) {
      src = (await buildRasterDoc(pages)).doc;
      indices = pages.map((_, i) => i);
    } else {
      src = await currentDocForCopy();
      indices = pages.map(p => p - 1);
    }
    const copied = await newDoc.copyPages(src, indices);
    copied.forEach(p => newDoc.addPage(p));
    const label = pages.length > 6 ? `${pages[0]}-${pages[pages.length - 1]}` : pages.join('-');
    downloadBytes(await safeSave(newDoc), outputName(`_pages_${label}`));
    hideLoading();
    webEditorToast(`✓ ${pages.length} page(s) extracted`, 'success');
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Extraction failed: ' + e.message, 'error');
    console.error(e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MERGE
// ═══════════════════════════════════════════════════════════════════════════
function syncMergeCurrentFile(name) {
  const list  = $('mergeList');
  list.innerHTML = '';
  if (!workBytes) return;
  const item = document.createElement('div');
  item.className = 'merge-item';
  item.dataset.current = '1';
  const n = document.createElement('div'); n.className = 'merge-item-num'; n.textContent = '1';
  const t = document.createElement('div'); t.className = 'merge-item-name'; t.textContent = `📌 ${name} (current)`;
  item.append(n, t);
  list.appendChild(item);
  renderMergeList();
}

$('mergeDropZone').addEventListener('click', () => $('mergeInput').click());
$('mergeDropZone').addEventListener('dragover', e => { e.preventDefault(); $('mergeDropZone').style.borderColor = 'var(--success)'; });
$('mergeDropZone').addEventListener('dragleave', () => $('mergeDropZone').style.borderColor = '');
$('mergeDropZone').addEventListener('drop', e => {
  e.preventDefault(); $('mergeDropZone').style.borderColor = '';
  Array.from(e.dataTransfer.files).filter(looksLikePdfFile).forEach(addMergeFile);
});
$('mergeInput').addEventListener('change', e => { Array.from(e.target.files).forEach(addMergeFile); e.target.value = ''; });

function addMergeFile(file) {
  if (mergeFiles.find(f => f.name === file.name && f.size === file.size)) return;
  mergeFiles.push(file);
  renderMergeList();
}

function renderMergeList() {
  const list  = $('mergeList');
  list.querySelectorAll('.merge-item:not([data-current])').forEach(el => el.remove());
  const offset = list.querySelector('[data-current]') ? 2 : 1;
  mergeFiles.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'merge-item';
    const n = document.createElement('div'); n.className = 'merge-item-num'; n.textContent = String(idx + offset);
    const t = document.createElement('div'); t.className = 'merge-item-name'; t.textContent = file.name;
    const del = document.createElement('button'); del.className = 'merge-item-del'; del.type = 'button'; del.textContent = '×';
    del.addEventListener('click', () => { mergeFiles = mergeFiles.filter(f => f !== file); renderMergeList(); });
    item.append(n, t, del);
    list.appendChild(item);
  });
}

// Loads another PDF for merging, with the same robustness as the main loader
async function loadForMerge(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let res = await tryPdfLib(bytes);
  if (res.doc?.isEncrypted) {
    let dec = await decryptBytes(bytes, '').catch(() => null);
    if (!dec) {
      const pw = await askPassword(file.name, false);
      if (pw !== null) dec = await decryptBytes(bytes, pw).catch(() => null);
    }
    if (dec) res = await tryPdfLib(dec);
  }
  if (!res.doc || res.doc.isEncrypted) {
    const repaired = res.doc ? null : await repairWithPdfLib(bytes);
    if (repaired) res = await tryPdfLib(repaired);
  }
  if (res.doc && !res.doc.isEncrypted) return res.doc;
  // Last resort: rasterize with PDF.js
  const { doc: jd } = await openWithPdfJs(bytes, file.name);
  const out = await PDFLib.PDFDocument.create();
  for (let i = 1; i <= jd.numPages; i++) {
    showLoading(`Rebuilding ${file.name} ${i}/${jd.numPages}…`);
    const page = await jd.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const sc = clamp(Math.sqrt(10_000_000 / (vp1.width * vp1.height)), 0.5, 2.5);
    const vp = page.getViewport({ scale: sc });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  jd.destroy();
  return out;
}

$('btnMergeDo').addEventListener('click', async () => {
  if ((workBytes ? 1 : 0) + mergeFiles.length < 2) {
    webEditorToast('Add at least one more PDF', 'error'); return;
  }
  const allowed = await _canEdit();
  if (!allowed) return;
  showLoading('Merging PDFs…');
  try {
    const mergedDoc = await PDFLib.PDFDocument.create();

    if (workBytes) {
      showLoading('Preparing current document…');
      const srcDoc = await currentDocForCopy();
      (await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));
    }

    for (const file of mergeFiles) {
      showLoading(`Adding ${file.name}…`);
      let srcDoc;
      try { srcDoc = await loadForMerge(file); }
      catch (e) { throw new Error(`"${file.name}" could not be read (${friendlyOpenError(e)})`); }
      (await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));
    }

    downloadBytes(await safeSave(mergedDoc), 'folio_merged.pdf');
    hideLoading();
    webEditorToast(`✓ ${mergedDoc.getPageCount()} pages merged`, 'success');
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Merge failed: ' + e.message, 'error');
    console.error(e);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONVERT
// ═══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.fmt-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.fmt-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    convertFmt = card.dataset.fmt;
  });
});

$('convertPages').addEventListener('change', e => {
  $('pageRangeRow').style.display = e.target.value === 'range' ? '' : 'none';
});

$('btnConvertDo').addEventListener('click', async () => {
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }

  const pagesOpt = $('convertPages').value;
  let pages;
  if (pagesOpt === 'all')          pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  else if (pagesOpt === 'current') pages = [currentPage];
  else                             pages = parsePageRange($('pageRangeInput').value, totalPages);
  if (!pages.length) { webEditorToast('Invalid page range', 'error'); return; }

  const allowed = await _canEdit();
  if (!allowed) return;

  showLoading('Preparing…');
  $('convertProgress').style.display = '';
  const bar = $('convertBar');
  bar.style.width = '0';

  let tempDoc = null;
  try {
    // Include edits / signatures / fields / annotations in the conversion
    let exportPdfDoc = pdfDoc;
    if (hasChanges()) {
      showLoading('Applying modifications…');
      const modBytes = await buildModifiedPdfBytes();
      tempDoc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: modBytes }).promise;
      exportPdfDoc = tempDoc;
    }
    showLoading('Converting…');

    if (['txt', 'html', 'csv'].includes(convertFmt)) {
      let output = convertFmt === 'html'
        ? '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Folio Export</title><style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:2em;line-height:1.6}</style></head><body>'
        : '';
      for (let i = 0; i < pages.length; i++) {
        bar.style.width = ((i + 1) / pages.length * 100) + '%';
        const page    = await exportPdfDoc.getPage(pages[i]);
        const content = await page.getTextContent();
        const text    = content.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join(' ').replace(/ \n /g, '\n');
        if (convertFmt === 'txt')  output += `\n\n── Page ${pages[i]} ──\n\n${text}`;
        if (convertFmt === 'html') output += `<section><h2>Page ${pages[i]}</h2><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></section>`;
        if (convertFmt === 'csv')  output += (i === 0 ? 'Page,Text\n' : '') + `${pages[i]},"${csvSafe(text).replace(/"/g, '""')}"\n`;
      }
      if (convertFmt === 'html') output += '</body></html>';
      const mimes = { txt: 'text/plain;charset=utf-8', html: 'text/html;charset=utf-8', csv: 'text/csv;charset=utf-8' };
      downloadText((convertFmt === 'csv' ? '﻿' : '') + output, `folio_export.${convertFmt}`, mimes[convertFmt]);

    } else if (convertFmt === 'docx') {
      await convertToDocx(exportPdfDoc, pages, bar);
    } else {
      // Image: jpg / png
      const fmt = convertFmt === 'png' ? 'image/png' : 'image/jpeg';
      const ext = convertFmt === 'png' ? 'png' : 'jpg';
      for (let i = 0; i < pages.length; i++) {
        bar.style.width = ((i + 1) / pages.length * 100) + '%';
        const page = await exportPdfDoc.getPage(pages[i]);
        const vp1  = page.getViewport({ scale: 1 });
        const vp   = page.getViewport({ scale: clamp(Math.sqrt(16_000_000 / (vp1.width * vp1.height)), 0.2, 2) });
        const c    = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise(r => c.toBlob(r, fmt, 0.93));
        downloadBlob(blob, pages.length > 1 ? `folio_page_${pages[i]}.${ext}` : `folio_export.${ext}`);
        await delay(250);
      }
    }

    $('convertProgress').style.display = 'none';
    bar.style.width = '0';
    hideLoading();
    webEditorToast(`✓ ${pages.length} page(s) converted to ${convertFmt.toUpperCase()}`, 'success');
  } catch(e) {
    $('convertProgress').style.display = 'none';
    hideLoading();
    webEditorToast('❌ Conversion failed: ' + e.message, 'error');
    console.error(e);
  } finally {
    if (tempDoc) { try { tempDoc.destroy(); } catch {} }
  }
});

// Excel/LibreOffice: cells starting with = + - @ are formulas (CSV injection)
function csvSafe(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

async function convertToDocx(exportPdfDoc, pages, bar) {
  // docx 8.x UMD exposes window.docx
  if (typeof docx === 'undefined') throw new Error('docx lib not loaded — check the <script> tag in web-editor.html');
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak, AlignmentType } = docx;
  const children = [];

  for (let i = 0; i < pages.length; i++) {
    bar.style.width = ((i + 1) / pages.length * 100) + '%';
    const page = await exportPdfDoc.getPage(pages[i]);
    const content = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });

    // Group lines (display space, so rotated pages work too)
    const lineMap = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const y = Math.round(tx[5]);
      let key = y;
      for (const k of lineMap.keys()) { if (Math.abs(k - y) <= 3) { key = k; break; } }
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key).push({ item, x: tx[4], fs: Math.hypot(tx[2], tx[3]) });
    }

    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => a - b);
    if (sortedYs.length === 0) {
      children.push(new Paragraph({ children: [new TextRun({ text: `[Page ${pages[i]} — no extractable text]`, italics: true, color: '999999' })] }));
    }

    for (const y of sortedYs) {
      const items = lineMap.get(y).sort((a, b) => a.x - b.x);
      const runs = items.map(({ item, fs }) => {
        const fontName = (item.fontName || '').toLowerCase();
        const family = (content.styles?.[item.fontName]?.fontFamily || '').toLowerCase();
        return new TextRun({
          text: item.str,
          size: Math.round(Math.max(fs, 6) * 2),
          bold: fontName.includes('bold'),
          italics: fontName.includes('italic') || fontName.includes('oblique'),
          font: family.includes('serif') && !family.includes('sans') ? 'Times New Roman'
              : family.includes('mono') ? 'Courier New' : 'Arial',
        });
      });
      const avgX = items.reduce((s, it) => s + it.x, 0) / items.length;
      let alignment = AlignmentType.LEFT;
      if (avgX > vp.width * 0.6) alignment = AlignmentType.RIGHT;
      else if (avgX > vp.width * 0.35) alignment = AlignmentType.CENTER;
      children.push(new Paragraph({ alignment, spacing: { before: 0, after: 80 }, children: runs }));
    }

    // Signatures
    for (const sig of signatures.filter(s => s.page === pages[i])) {
      try {
        const bytes = base64ToBytes(sig.dataURL.split(',')[1]);
        const widthPt = Math.min(sig.w, 450);
        children.push(new Paragraph({
          children: [new ImageRun({
            data: bytes,
            transformation: { width: Math.round(widthPt * 1.33), height: Math.round(widthPt * 1.33 * sig.h / sig.w) },
            type: sig.dataURL.startsWith('data:image/png') ? 'png' : 'jpg',
          })],
        }));
      } catch (e) { console.warn('docx sig embed:', e); }
    }

    if (i < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const wordDoc = new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children,
    }],
  });
  downloadBlob(await Packer.toBlob(wordDoc), 'folio_export.docx');
}

// ═══════════════════════════════════════════════════════════════════════════
// CREDITS
// ═══════════════════════════════════════════════════════════════════════════
function updateCreditsPill(status) {
  const el = $('creditsCount');
  const pill = $('creditsPill');
  const active = WebPayment.hasActiveSession();
  if (!status) { el.textContent = '? credits'; return; }
  if (status.lifetime_free) {
    el.textContent = '∞ Unlimited';
  } else {
    const free = Number(status.freeRemaining) || 0;
    el.textContent = `${Number(status.credits) || 0} credits` + (free ? ` + ${free} free` : '');
  }
  pill.title = (active ? '✓ Editing session active for this document\n' : '') + 'Click to buy credits';
  pill.querySelector('.c-dot').style.background = active || status.lifetime_free ? 'var(--success)'
    : ((Number(status.credits) || 0) + (Number(status.freeRemaining) || 0)) > 0 ? 'var(--warn)' : 'var(--danger)';
}

$('creditsPill').addEventListener('click', () => WebPayment.showPaymentModal({ reason: 'buy' }));

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

function downloadBytes(bytes, name) {
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
}

function downloadText(content, name, mime) {
  downloadBlob(new Blob([content], { type: mime }), name);
}

function parsePageRange(str, max) {
  const pages = new Set();
  (str || '').split(',').forEach(part => {
    part = part.trim();
    if (!part) return;
    const m = part.match(/^(\d+)\s*-\s*(\d*)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : max;
      for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(max, Math.max(a, b)); i++) pages.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= max) pages.add(n);
    }
  });
  return Array.from(pages).sort((a, b) => a - b);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g, '&#39;');
}

function buildCanvasFont(pdfFontName, sizePx) {
  const f      = (pdfFontName || '').toLowerCase();
  const bold   = f.includes('bold')                             ? 'bold '   : '';
  const italic = f.includes('oblique') || f.includes('italic') ? 'italic ' : '';

  const familyMap = {
    'helvetica':      'Helvetica, Arial, sans-serif',
    'inter':          'Inter, Helvetica, sans-serif',
    'roboto':         'Roboto, Helvetica, sans-serif',
    'opensans':       '"Open Sans", Helvetica, sans-serif',
    'lato':           'Lato, Helvetica, sans-serif',
    'montserrat':     'Montserrat, Helvetica, sans-serif',
    'poppins':        'Poppins, Helvetica, sans-serif',
    'nunito':         'Nunito, Helvetica, sans-serif',
    'raleway':        'Raleway, Helvetica, sans-serif',
    'oswald':         'Oswald, Helvetica, sans-serif',
    'dmsans':         '"DM Sans", Helvetica, sans-serif',
    'times':          '"Times New Roman", Times, serif',
    'merriweather':   'Merriweather, Georgia, serif',
    'playfair':       '"Playfair Display", Georgia, serif',
    'lora':           'Lora, Georgia, serif',
    'ptserif':        '"PT Serif", Georgia, serif',
    'crimsonpro':     '"Crimson Pro", Georgia, serif',
    'courier':        '"Courier New", Courier, monospace',
    'firacode':       '"Fira Code", "Courier New", monospace',
    'jetbrainsmono':  '"JetBrains Mono", "Courier New", monospace',
    'sourcecodepro':  '"Source Code Pro", "Courier New", monospace',
    'bebasneue':      '"Bebas Neue", Impact, sans-serif',
    'righteous':      'Righteous, Impact, sans-serif',
    'pacifico':       'Pacifico, cursive',
    'lobster':        'Lobster, cursive',
    'greatvibes':     '"Great Vibes", cursive',
    'dancingscript':  '"Dancing Script", cursive',
  };

  const key = f.replace(/[-_](bold|italic|oblique|roman|regular).*$/, '').trim();
  const family = familyMap[key] || familyMap[f.split('-')[0]] || 'Helvetica, Arial, sans-serif';
  return `${italic}${bold}${Math.max(1, +sizePx).toFixed(2)}px ${family}`;
}

// Redraw once a web font used in the preview has finished loading
const loadedCanvasFonts = new Set();
function ensureCanvasFont(name, cb) {
  if (!name || loadedCanvasFonts.has(name) || !document.fonts?.load) return;
  loadedCanvasFonts.add(name);
  document.fonts.load(buildCanvasFont(name, 16)).then(() => cb && cb()).catch(() => {});
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
$('mainFileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) loadFile(f);
});

$('btnLoadUrl').addEventListener('click', () => {
  const url = $('urlInput').value.trim();
  if (url) loadPDFFromURL(url);
});
$('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLoadUrl').click(); });

window.addEventListener('beforeunload', e => {
  if (pdfDoc && dirtySinceExport && hasChanges()) { e.preventDefault(); e.returnValue = ''; }
});

async function init() {
  const params = new URLSearchParams(location.search);
  const modeParam = params.get('mode');
  if (modeParam && MODES.includes(modeParam)) switchMode(modeParam);

  WebPayment.onStatus(updateCreditsPill);
  WebPayment.getStatus().then(s => { if (!s) updateCreditsPill(null); });

  // Drag & drop (empty state and page area)
  const emptyInner = $('emptyInner');
  emptyInner.addEventListener('dragover', e => { e.preventDefault(); emptyInner.classList.add('drag-over'); });
  emptyInner.addEventListener('dragleave', () => emptyInner.classList.remove('drag-over'));
  emptyInner.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    emptyInner.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  const ca = $('canvasArea');
  ca.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  ca.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    loadFile(f);
  });

  // Restore the previously opened PDF (reload / return from payment)
  const restored = await restoreDocument();
  if (restored) await openPdfBytes(restored.bytes, restored.name, { persist: false });
}

init();
