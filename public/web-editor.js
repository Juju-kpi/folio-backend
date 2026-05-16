// ── Folio PDF Studio — web-editor.js ─────────────────────────────────────────
// Web version of editor.js — no chrome.* APIs.
// Full feature parity: text edit with whiteout, signature (draw/text/image),
// annotations, extract, merge, convert — all using real PDF coordinates.
// Must be loaded AFTER web-payment.js.

'use strict';

// ── PDF.js worker ─────────────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── State ─────────────────────────────────────────────────────────────────────
let pdfDoc         = null;   // PDF.js doc — always on the ORIGINAL
let pdfLibDoc      = null;   // pdf-lib doc for structure reading
let rawPdfBytes    = null;   // original bytes — never overwritten
let currentPage    = 1;
let totalPages     = 0;
let zoom           = 1.0;
let currentMode    = 'edit';
let textBlocks     = [];
let selectedBlock  = null;
let modifiedBlocks = new Map(); // `${page}-${id}` → mod data
let mergeFiles     = [];
let selExtract     = new Set();
let convertFmt     = 'jpg';
let sigMode        = 'draw';
let sigImgData     = null;
let sigCanvas, sigCtx, sigIsDrawing = false;
let annotations    = [];
let isAnnotating   = false;
let annotStart     = null;
let activeSigContainer = null;
let sigsByPage     = new Map(); // Map<pageNum, [{dataURL, left, top, width, height}]>
let fileName       = 'document.pdf';

const $ = id => document.getElementById(id);

// ── Toast / Loading ───────────────────────────────────────────────────────────
function webEditorToast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}
window.webEditorToast = webEditorToast; // alias for web-payment.js

function showLoading(msg = 'Loading…') {
  $('loadingText').textContent = msg;
  $('loadingOverlay').classList.remove('hidden');
}
function hideLoading() { $('loadingOverlay').classList.add('hidden'); }

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const modeParam = params.get('mode');
  if (modeParam) switchMode(modeParam);

  // Restore previously opened PDF from sessionStorage
  const stored = sessionStorage.getItem('folioPDFData');
  const storedName = sessionStorage.getItem('folioPDFName');
  if (stored) await loadPDFFromDataURL(stored, storedName || 'document.pdf', false);

  updateCreditsDisplay();

  // Drag & drop on empty state
  const emptyInner = $('emptyInner');
  emptyInner.addEventListener('dragover', e => { e.preventDefault(); emptyInner.classList.add('drag-over'); });
  emptyInner.addEventListener('dragleave', () => emptyInner.classList.remove('drag-over'));
  emptyInner.addEventListener('drop', e => {
    e.preventDefault();
    emptyInner.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f?.type === 'application/pdf') loadFile(f);
    else webEditorToast('❌ PDF files only', 'error');
  });

  const ca = $('canvasArea');
  ca.addEventListener('dragover', e => { if (pdfDoc) return; e.preventDefault(); });
  ca.addEventListener('drop', e => {
    if (pdfDoc) return; e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.type === 'application/pdf') loadFile(f);
  });
}

// ── File loading ──────────────────────────────────────────────────────────────
$('mainFileInput').addEventListener('change', e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = '';
});

$('btnLoadUrl').addEventListener('click', () => {
  const url = $('urlInput').value.trim();
  if (url) loadPDFFromURL(url);
});
$('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLoadUrl').click(); });

function loadFile(file) {
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = e => loadPDFFromDataURL(e.target.result, file.name, true);
  reader.readAsDataURL(file);
}

async function loadPDFFromURL(url) {
  showLoading('Fetching PDF…');
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf   = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const b64   = uint8ToBase64(bytes);
    fileName    = url.split('/').pop().split('?')[0] || 'document.pdf';
    await loadPDFFromDataURL('data:application/pdf;base64,' + b64, fileName, true);
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Could not load PDF: ' + e.message, 'error');
  }
}

async function loadPDFFromDataURL(dataURL, name = 'document.pdf', isNew = true) {
  showLoading('Reading PDF…');
  fileName = name;

  const base64 = dataURL.includes(',') ? dataURL.split(',')[1] : dataURL;
  const bytes  = base64ToBytes(base64);

  if (isNew) {
    // New document → full reset
    modifiedBlocks.clear();
    annotations = [];
    sigsByPage.clear();
    selectedBlock = null;
    mergeFiles = [];
    selExtract.clear();
    textBlocks = [];
    currentPage = 1;
    sessionStorage.setItem('folioPDFData', dataURL);
    sessionStorage.setItem('folioPDFName', name);
  }

  rawPdfBytes = bytes;

  try {
    showLoading('Loading PDF.js…');
    pdfDoc     = await pdfjsLib.getDocument({ data: rawPdfBytes.slice() }).promise;
    totalPages = pdfDoc.numPages;
    $('totalPagesSpan').textContent = totalPages;

    showLoading('Loading pdf-lib…');
    pdfLibDoc  = await PDFLib.PDFDocument.load(rawPdfBytes.slice(), { ignoreEncryption: true });
    if (typeof fontkit !== 'undefined') pdfLibDoc.registerFontkit(fontkit);

    $('emptyState').classList.add('hidden');
    $('pdfPageWrap').classList.remove('hidden');
    $('pageNav').style.display    = '';
    $('zoomCtrl').style.display   = '';
    $('btnExport').disabled       = false;
    $('applyProps').disabled      = false;

    await renderPage(1);
    if (['extract', 'merge'].includes(currentMode)) await buildThumbnails();
    if (currentMode === 'merge') syncMergeCurrentFile(name);

    hideLoading();
    webEditorToast(`✓ "${name}" — ${totalPages} page(s)`, 'success');
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Error loading PDF: ' + e.message, 'error');
    console.error('[Folio] loadPDF error:', e);
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
async function renderPage(num) {
  if (!pdfDoc) return;
  showLoading(`Rendering page ${num}…`);

  if (currentPage !== num) saveSigsForPage(currentPage);

  const page   = await pdfDoc.getPage(num);
  const scale  = zoom * 1.5;
  const vp     = page.getViewport({ scale });
  const canvas = $('pdfCanvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = vp.width;
  canvas.height = vp.height;
  canvas.style.width  = vp.width  + 'px';
  canvas.style.height = vp.height + 'px';
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  currentPage = num;
  $('pageNum').textContent = num;

  clearOverlays();

  // Whiteout + redraw modified text blocks on canvas
  await redrawModificationsOnCanvas(ctx, vp, num);

  if (currentMode === 'edit')     await detectTextBlocks(num);
  if (currentMode === 'annotate') setupAnnotationCanvas(vp);

  restoreSigsForPage(num);
  redrawAnnotationsForPage(num);

  hideLoading();
}

async function redrawModificationsOnCanvas(ctx, vp, pageNum) {
  for (const [modKey, mod] of modifiedBlocks.entries()) {
    if (parseInt(modKey.split('-')[0]) !== pageNum) continue;
    const block = mod._block;
    if (!block) continue;

    // Erase original text with white rectangle
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(block.x - 2, block.y - 2, block.w + 6, block.h + 6);

    if (mod.bgOpacity > 0) {
      ctx.fillStyle = hexToRgbCanvas(mod.bgColor || '#ffffff', mod.bgOpacity);
      ctx.fillRect(block.x - 2, block.y - 2, block.w + 6, block.h + 6);
    }

    ctx.font      = buildCanvasFont(mod.fontName, mod.fontSize * zoom * 1.5);
    ctx.fillStyle = mod.color || '#000000';
    ctx.save();
    if (mod.rotation) {
      ctx.translate(block.x, block.y + block.h);
      ctx.rotate((mod.rotation * Math.PI) / 180);
      ctx.fillText(mod.text, 0, 0);
    } else {
      ctx.fillText(mod.text, block.x, block.y + block.h - 2);
    }
    ctx.restore();
  }
}

function clearOverlays() {
  $('pdfPageWrap')
    .querySelectorAll('.text-overlay, .annot-canvas, .block-overlay')
    .forEach(el => el.remove());
}

// ── Signature page management ─────────────────────────────────────────────────
function saveSigsForPage(pageNum) {
  const sigs = $('pdfPageWrap').querySelectorAll('.sig-overlay');
  if (!sigs.length) return;
  const saved = [];
  sigs.forEach(container => {
    const img = container.querySelector('img');
    if (!img) return;
    saved.push({
      dataURL: img.src,
      left:   container.style.left,
      top:    container.style.top,
      width:  container.offsetWidth  || 200,
      height: container.offsetHeight || 60,
    });
    container.remove();
  });
  if (saved.length > 0) sigsByPage.set(pageNum, saved);
}

function restoreSigsForPage(pageNum) {
  const saved = sigsByPage.get(pageNum);
  if (!saved || !saved.length) return;
  saved.forEach(s => placeSigOnPDF(s.dataURL, s.left, s.top, s.width + 'px', s.height + 'px'));
}

// ── Text block detection ──────────────────────────────────────────────────────
async function detectTextBlocks(pageNum) {
  if (!pdfDoc) return;
  const page    = await pdfDoc.getPage(pageNum);
  const content = await page.getTextContent();
  const vp      = page.getViewport({ scale: zoom * 1.5 });

  textBlocks = [];
  const list  = $('blockList');
  list.innerHTML = '';

  const items   = content.items.filter(i => i.str && i.str.trim().length > 0);
  const grouped = groupTextItems(items, vp);

  grouped.forEach((block, idx) => {
    block.id = idx;
    const modKey = `${pageNum}-${idx}`;
    if (modifiedBlocks.has(modKey)) {
      const saved = modifiedBlocks.get(modKey);
      Object.assign(block, saved);
      block.modified = true;
      saved._block   = block; // link screen coords
    }
    textBlocks.push(block);
    createTextOverlay(block);
    appendBlockItem(block, idx);
  });

  updateModBadge();

  if (items.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 2px;">No detectable text (image PDF or protected)</div>';
  }
}

function groupTextItems(items, viewport) {
  const blocks = [];
  const used   = new Set();

  items.forEach((item, i) => {
    if (used.has(i)) return;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const x  = tx[4];
    const y  = tx[5];
    const h  = Math.abs(item.transform[3]) * zoom * 1.5;
    const w  = item.width * zoom * 1.5;
    const fs = Math.round(Math.abs(item.transform[3]));

    let lineText = item.str;
    let maxX = x + w, minX = x;

    items.forEach((other, j) => {
      if (j === i || used.has(j)) return;
      const tx2 = pdfjsLib.Util.transform(viewport.transform, other.transform);
      const oy  = tx2[5], ox = tx2[4];
      if (Math.abs(oy - y) < h * 0.6 && ox >= minX - 200 && ox <= maxX + 300) {
        lineText += ' ' + other.str;
        maxX = Math.max(maxX, ox + other.width * zoom * 1.5);
        used.add(j);
      }
    });
    used.add(i);

    let color = '#000000';
    if (item.color && Array.isArray(item.color)) {
      color = '#' + item.color.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    }

    blocks.push({
      text: lineText.trim(), origText: lineText.trim(),
      x: minX, y: y - h,
      w: Math.max(maxX - minX, 30), h: Math.max(h, 8),
      fontSize: fs,
      fontName: resolvePDFFont(item.fontName || ''),
      rawFont:  item.fontName || '',
      color, bgColor: '#ffffff', bgOpacity: 0, rotation: 0,
      // Real PDF coordinate space — used for pdf-lib embedding
      pdfX: item.transform[4], pdfY: item.transform[5],
      transform: item.transform, modified: false,
    });
  });

  return blocks;
}

function resolvePDFFont(raw) {
  const f = raw.toLowerCase();
  if (f.includes('bold') && (f.includes('italic') || f.includes('oblique'))) return 'Helvetica-BoldOblique';
  if (f.includes('bold') || f.includes('heavy'))   return 'Helvetica-Bold';
  if (f.includes('italic') || f.includes('oblique') || f.includes('ital')) return 'Helvetica-Oblique';
  if (f.includes('times') || f.includes('serif'))   return 'Times-Roman';
  if (f.includes('courier') || f.includes('mono'))  return 'Courier';
  return 'Helvetica';
}

function createTextOverlay(block) {
  const div = document.createElement('div');
  div.className = 'text-overlay' + (block.modified ? ' modified' : '');
  div.dataset.id = block.id;
  div.style.cssText = `position:absolute;left:${block.x}px;top:${block.y}px;width:${block.w}px;height:${block.h}px;cursor:pointer;`;
  div.title = block.text;
  div.addEventListener('click', () => selectBlock(block.id));
  $('pdfPageWrap').appendChild(div);
}

function appendBlockItem(block, idx) {
  const li = document.createElement('div');
  li.className  = 'block-item' + (block.modified ? ' selected' : '');
  li.dataset.id = idx;
  const preview = block.text.slice(0, 38) + (block.text.length > 38 ? '…' : '');
  li.innerHTML = `
    <div class="block-preview">${escapeHtml(preview)}</div>
    <div class="block-meta">
      <span class="block-tag">${block.fontSize}pt</span>
      <span class="block-tag">${block.fontName.split('-')[0].slice(0, 10)}</span>
      ${block.modified ? '<span class="block-tag modified">✓ edited</span>' : ''}
    </div>`;
  li.addEventListener('click', () => selectBlock(idx));
  $('blockList').appendChild(li);
}

function selectBlock(id) {
  selectedBlock = textBlocks[id];
  if (!selectedBlock) return;

  document.querySelectorAll('.text-overlay').forEach(el => el.classList.remove('selected'));
  document.querySelectorAll('.block-item').forEach(el => el.classList.remove('selected'));
  document.querySelector(`.text-overlay[data-id="${id}"]`)?.classList.add('selected');
  const li = document.querySelector(`.block-item[data-id="${id}"]`);
  if (li) { li.classList.add('selected'); li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

  $('propPanel').style.display = '';
  $('applyProps').disabled = false;

  $('propText').value      = selectedBlock.text;
  $('propSize').value      = selectedBlock.fontSize;
  $('propColor').value     = selectedBlock.color     || '#000000';
  $('propBgColor').value   = selectedBlock.bgColor   || '#ffffff';
  $('propBgOpacity').value = selectedBlock.bgOpacity ?? 0;
  $('propRotation').value  = selectedBlock.rotation  || 0;

  const sel = $('propFont');
  let matched = false;
  for (const opt of sel.options) {
    if (opt.value === selectedBlock.fontName) { sel.value = opt.value; matched = true; break; }
  }
  if (!matched) sel.value = 'Helvetica';
}

// ── Apply text modification ───────────────────────────────────────────────────
$('applyProps').addEventListener('click', async () => {
  if (!selectedBlock) { webEditorToast('Select a text block first', 'error'); return; }

  const allowed = await WebPayment.canEdit();
  if (!allowed) return;

  selectedBlock.text      = $('propText').value;
  selectedBlock.fontName  = $('propFont').value;
  selectedBlock.fontSize  = parseFloat($('propSize').value)      || selectedBlock.fontSize;
  selectedBlock.color     = $('propColor').value;
  selectedBlock.bgColor   = $('propBgColor').value;
  selectedBlock.bgOpacity = parseFloat($('propBgOpacity').value) || 0;
  selectedBlock.rotation  = parseFloat($('propRotation').value)  || 0;
  selectedBlock.modified  = true;

  const modKey = `${currentPage}-${selectedBlock.id}`;
  modifiedBlocks.set(modKey, { ...selectedBlock, _block: { ...selectedBlock } });

  document.querySelector(`.text-overlay[data-id="${selectedBlock.id}"]`)?.classList.add('modified');
  const li = document.querySelector(`.block-item[data-id="${selectedBlock.id}"]`);
  if (li) {
    li.querySelector('.block-preview').textContent =
      selectedBlock.text.slice(0, 38) + (selectedBlock.text.length > 38 ? '…' : '');
    const meta = li.querySelector('.block-meta');
    if (!meta.querySelector('.modified')) {
      const t = document.createElement('span');
      t.className = 'block-tag modified';
      t.textContent = '✓ edited';
      meta.appendChild(t);
    }
  }

  updateModBadge();

  // Re-render page: original + all modifications
  const page   = await pdfDoc.getPage(currentPage);
  const vp     = page.getViewport({ scale: zoom * 1.5 });
  const canvas = $('pdfCanvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  await redrawModificationsOnCanvas(ctx, vp, currentPage);
  clearOverlays();
  await detectTextBlocks(currentPage);
  restoreSigsForPage(currentPage);
  redrawAnnotationsForPage(currentPage);

  webEditorToast('✓ Modification saved', 'success');
  updateCreditsDisplay();
});

function updateModBadge() {
  const badge = $('modBadge');
  if (modifiedBlocks.size > 0) {
    badge.classList.remove('hidden');
    badge.textContent = modifiedBlocks.size + ' edited';
  } else {
    badge.classList.add('hidden');
  }
}

// ── Build modified PDF (source of truth) ─────────────────────────────────────
async function buildModifiedPdfBytes() {
  const editDoc   = await PDFLib.PDFDocument.load(rawPdfBytes, { ignoreEncryption: true });
  if (typeof fontkit !== 'undefined') editDoc.registerFontkit(fontkit);
  const fontCache = {};

  const FONT_MAP = {
    'Helvetica':             PDFLib.StandardFonts.Helvetica,
    'Helvetica-Bold':        PDFLib.StandardFonts.HelveticaBold,
    'Helvetica-Oblique':     PDFLib.StandardFonts.HelveticaOblique,
    'Helvetica-BoldOblique': PDFLib.StandardFonts.HelveticaBoldOblique,
    'Times-Roman':           PDFLib.StandardFonts.TimesRoman,
    'Times-Bold':            PDFLib.StandardFonts.TimesBold,
    'Times-Italic':          PDFLib.StandardFonts.TimesItalic,
    'Times-BoldItalic':      PDFLib.StandardFonts.TimesBoldItalic,
    'Courier':               PDFLib.StandardFonts.Courier,
    'Courier-Bold':          PDFLib.StandardFonts.CourierBold,
    'Courier-Oblique':       PDFLib.StandardFonts.CourierOblique,
  };

  const getFont = async name => {
    if (fontCache[name]) return fontCache[name];
    fontCache[name] = await editDoc.embedFont(FONT_MAP[name] || PDFLib.StandardFonts.Helvetica);
    return fontCache[name];
  };

  const hexToRgbLib = hex => PDFLib.rgb(
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255
  );

  // ── 1. Text edits ─────────────────────────────────────────────────────────
  for (const [modKey, mod] of modifiedBlocks.entries()) {
    const pageNum = parseInt(modKey.split('-')[0]);
    const page    = editDoc.getPage(pageNum - 1);
    const { width } = page.getSize();

    const font     = await getFont(mod.fontName || 'Helvetica');
    const origFont = await getFont(resolvePDFFont(mod.rawFont || ''));
    const origWidth = origFont.widthOfTextAtSize(mod.origText || '', mod.fontSize);

    // Whiteout original text in PDF space
    page.drawRectangle({
      x: mod.pdfX - 2, y: mod.pdfY - 3,
      width:  Math.max(origWidth + 6, 20),
      height: mod.fontSize + 6,
      color: PDFLib.rgb(1, 1, 1), opacity: 1,
    });

    if (mod.bgOpacity > 0) {
      page.drawRectangle({
        x: mod.pdfX - 2, y: mod.pdfY - 3,
        width:  Math.max(origWidth + 6, 20),
        height: mod.fontSize + 6,
        color: hexToRgbLib(mod.bgColor || '#ffffff'),
        opacity: mod.bgOpacity,
      });
    }

    page.drawText(mod.text || '', {
      x: mod.pdfX, y: mod.pdfY,
      size: mod.fontSize, font,
      color: hexToRgbLib(mod.color || '#000000'),
      rotate: mod.rotation ? PDFLib.degrees(mod.rotation) : undefined,
      lineHeight: mod.fontSize * 1.2,
      maxWidth: width - mod.pdfX - 10,
    });
  }

  // ── 2. Collect DOM signatures on current page before embedding ────────────
  const domSigs = [];
  $('pdfPageWrap').querySelectorAll('.sig-overlay').forEach(container => {
    const img = container.querySelector('img');
    if (!img) return;
    domSigs.push({
      pageNum: currentPage,
      dataURL: img.src,
      left:   parseFloat(container.style.left) || 40,
      top:    parseFloat(container.style.top)  || 40,
      width:  container.offsetWidth  || 200,
      height: container.offsetHeight || 60,
    });
  });

  // ── 3. Embed signatures (all pages) ──────────────────────────────────────
  const embedSig = async (page, pageNum, sig) => {
    const { width: pw, height: ph } = page.getSize();
    const pdfJsPage = await pdfDoc.getPage(pageNum);
    const pdfJsVp   = pdfJsPage.getViewport({ scale: zoom * 1.5 });
    const scaleX = pw / pdfJsVp.width;
    const scaleY = ph / pdfJsVp.height;

    const sw = parseFloat(sig.width)  || 200;
    const sh = parseFloat(sig.height) || 60;
    const sx = parseFloat(sig.left)   || 40;
    const sy = parseFloat(sig.top)    || 40;

    const pdfX = sx * scaleX;
    const pdfY = ph - (sy + sh) * scaleY;
    const pdfW = sw * scaleX;
    const pdfH = sh * scaleY;

    try {
      const src = sig.dataURL || '';
      const b64 = src.split(',')[1];
      if (!b64) return;
      const imgBytes = base64ToBytes(b64);
      let embedded;
      if (src.startsWith('data:image/png')) {
        embedded = await editDoc.embedPng(imgBytes);
      } else {
        try { embedded = await editDoc.embedJpg(imgBytes); }
        catch { embedded = await editDoc.embedPng(imgBytes); }
      }
      page.drawImage(embedded, {
        x: pdfX, y: Math.max(0, pdfY),
        width: Math.max(pdfW, 1), height: Math.max(pdfH, 1),
      });
    } catch(e) { console.warn('[Folio] sig embed error:', e); }
  };

  for (const [pageNum, sigs] of sigsByPage.entries()) {
    const page = editDoc.getPage(pageNum - 1);
    for (const sig of sigs) await embedSig(page, pageNum, sig);
  }

  // DOM sigs (current page, not yet in sigsByPage if user hasn't navigated)
  for (const sig of domSigs) {
    if (sigsByPage.has(sig.pageNum)) continue;
    const page = editDoc.getPage(sig.pageNum - 1);
    await embedSig(page, sig.pageNum, sig);
  }

  // ── 4. Annotations ────────────────────────────────────────────────────────
  for (const annot of annotations) {
    const pageNum   = annot.page || currentPage;
    const page      = editDoc.getPage(pageNum - 1);
    const { width: pw, height: ph } = page.getSize();
    const pdfJsPage = await pdfDoc.getPage(pageNum);
    const pdfJsVp   = pdfJsPage.getViewport({ scale: zoom * 1.5 });
    const scaleX = pw / pdfJsVp.width;
    const scaleY = ph / pdfJsVp.height;

    const pdfAW = Math.abs(annot.w) * scaleX;
    const pdfAH = Math.abs(annot.h) * scaleY;
    const pdfAX = Math.min(annot.x, annot.x + annot.w) * scaleX;
    const pdfAY = ph - (Math.min(annot.y, annot.y + annot.h) + Math.abs(annot.h)) * scaleY;
    const c     = hexToRgbObj(annot.color);

    page.drawRectangle({
      x: pdfAX, y: pdfAY, width: pdfAW, height: pdfAH,
      color: PDFLib.rgb(c.r / 255, c.g / 255, c.b / 255),
      opacity: annot.opacity,
    });
  }

  return editDoc.save();
}

// ── Export PDF ────────────────────────────────────────────────────────────────
$('btnExport').addEventListener('click', async () => {
  if (!pdfDoc) { webEditorToast('No PDF loaded', 'error'); return; }
  if (currentMode === 'extract') { $('btnExtractDo').click(); return; }
  if (currentMode === 'merge')   { $('btnMergeDo').click();   return; }
  if (currentMode === 'convert') { $('btnConvertDo').click(); return; }

  showLoading('Building modified PDF…');
  try {
    saveSigsForPage(currentPage);
    const bytes = await buildModifiedPdfBytes();
    restoreSigsForPage(currentPage);
    downloadBytes(bytes, fileName.replace('.pdf', '-edited.pdf'));
    hideLoading();
    webEditorToast(`✓ PDF exported (${modifiedBlocks.size} edit(s), ${sigsByPage.size} signed page(s))`, 'success');
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Export failed: ' + e.message, 'error');
    console.error('[Folio] export error:', e);
  }
});

// ── Navigation & Zoom ─────────────────────────────────────────────────────────
$('prevPage').addEventListener('click', () => { if (currentPage > 1)          renderPage(currentPage - 1); });
$('nextPage').addEventListener('click', () => { if (currentPage < totalPages) renderPage(currentPage + 1); });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && activeSigContainer) {
    e.preventDefault();
    activeSigContainer.remove();
    activeSigContainer = null;
    webEditorToast('Signature deleted');
    return;
  }
  if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   { if (currentPage > 1)          renderPage(currentPage - 1); }
  if (e.key === 'ArrowRight' || e.key === 'PageDown')  { if (currentPage < totalPages) renderPage(currentPage + 1); }
  if (e.key === '+' || e.key === '=') { zoom = Math.min(zoom + 0.15, 3);   updateZoom(); }
  if (e.key === '-')                   { zoom = Math.max(zoom - 0.15, 0.3); updateZoom(); }
});

$('zoomIn').addEventListener('click',  () => { zoom = Math.min(zoom + 0.15, 3);   updateZoom(); });
$('zoomOut').addEventListener('click', () => { zoom = Math.max(zoom - 0.15, 0.3); updateZoom(); });

function updateZoom() {
  $('zoomVal').textContent = Math.round(zoom * 100) + '%';
  if (pdfDoc) renderPage(currentPage);
}

// ── Mode switching ────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.mode === mode)
  );
  ['Edit','Sign','Annotate','Extract','Merge','Convert'].forEach(m =>
    $('sidebar' + m)?.classList.add('hidden')
  );
  const TARGET = {
    edit: 'sidebarEdit', sign: 'sidebarSign', annotate: 'sidebarAnnotate',
    extract: 'sidebarExtract', merge: 'sidebarMerge', convert: 'sidebarConvert',
  };
  if (TARGET[mode] && $(TARGET[mode])) $(TARGET[mode]).classList.remove('hidden');

  const LABELS = {
    edit: '↓ Export PDF', sign: '↓ Export PDF', annotate: '↓ Export PDF',
    extract: '✂ Extract', merge: '🔀 Merge', convert: '⚡ Convert',
  };
  $('btnExport').textContent = LABELS[mode] || '↓ Export PDF';

  const ac = $('annotDrawCanvas');
  if (ac) ac.classList.toggle('active', mode === 'annotate');

  if (mode === 'sign'     && !sigCtx)  initSigCanvas();
  if (mode === 'edit'     && pdfDoc)   detectTextBlocks(currentPage);
  if (mode === 'annotate' && pdfDoc) {
    pdfDoc.getPage(currentPage).then(page => {
      setupAnnotationCanvas(page.getViewport({ scale: zoom * 1.5 }));
    });
  }
  if (mode === 'extract'  && pdfDoc && !$('thumbGrid').children.length) buildThumbnails();
  if (mode === 'merge'    && rawPdfBytes) syncMergeCurrentFile(fileName);
}

// ── Signature ─────────────────────────────────────────────────────────────────
function initSigCanvas() {
  sigCanvas = $('sigCanvas');
  const rect = sigCanvas.getBoundingClientRect();
  sigCanvas.width  = rect.width  || 252;
  sigCanvas.height = rect.height || 100;
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.strokeStyle = '#003380';
  sigCtx.lineWidth   = 2.5;
  sigCtx.lineCap     = 'round';
  sigCtx.lineJoin    = 'round';

  const getPos  = e => { const r = sigCanvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const getTPos = e => { const r = sigCanvas.getBoundingClientRect(); const t = e.touches[0]; return [t.clientX - r.left, t.clientY - r.top]; };

  sigCanvas.addEventListener('mousedown',  e => { sigIsDrawing = true; sigCtx.beginPath(); sigCtx.moveTo(...getPos(e)); });
  sigCanvas.addEventListener('mousemove',  e => { if (!sigIsDrawing) return; sigCtx.lineTo(...getPos(e)); sigCtx.stroke(); });
  sigCanvas.addEventListener('mouseup',    () => sigIsDrawing = false);
  sigCanvas.addEventListener('mouseleave', () => sigIsDrawing = false);
  sigCanvas.addEventListener('touchstart', e => { e.preventDefault(); sigIsDrawing = true; sigCtx.beginPath(); sigCtx.moveTo(...getTPos(e)); }, { passive: false });
  sigCanvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!sigIsDrawing) return; sigCtx.lineTo(...getTPos(e)); sigCtx.stroke(); }, { passive: false });
  sigCanvas.addEventListener('touchend',   () => sigIsDrawing = false);
}

$('sigClear').addEventListener('click', () => {
  if (sigCtx) sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
});

$('sigApply').addEventListener('click', async () => {
  if (!sigCanvas || !pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;
  placeSigOnPDF(sigCanvas.toDataURL('image/png'));
  updateCreditsDisplay();
});

$('sigTextApply').addEventListener('click', async () => {
  const name = $('sigTextInput').value.trim();
  if (!name)   { webEditorToast('Enter your name', 'error'); return; }
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;

  const c = document.createElement('canvas');
  c.width = 300; c.height = 80;
  const ctx = c.getContext('2d');
  ctx.font      = `italic 38px ${$('sigTextFont').value}`;
  ctx.fillStyle = $('sigTextColor').value;
  ctx.fillText(name, 8, 56);
  placeSigOnPDF(c.toDataURL('image/png'));
  updateCreditsDisplay();
});

$('sigImgDrop').addEventListener('click', () => $('sigImgInput').click());
$('sigImgInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const allowed = await WebPayment.canEdit();
  if (!allowed) { e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = ev => { sigImgData = ev.target.result; placeSigOnPDF(sigImgData); };
  r.readAsDataURL(f);
  updateCreditsDisplay();
});

$('sigImgApply').addEventListener('click', async () => {
  if (!sigImgData) { webEditorToast('Choose an image first', 'error'); return; }
  if (!pdfDoc)     { webEditorToast('Open a PDF first', 'error');    return; }
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;
  placeSigOnPDF(sigImgData);
  updateCreditsDisplay();
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

function placeSigOnPDF(dataURL, leftCSS, topCSS, widthCSS, heightCSS) {
  if (!pdfDoc) { webEditorToast('Open a PDF first', 'error'); return; }
  const wrap = $('pdfPageWrap');

  const container = document.createElement('div');
  container.className = 'sig-overlay';
  container.style.cssText = `
    position:absolute;
    left:${leftCSS || '40px'};
    top:${topCSS   || '40px'};
    width:${widthCSS   || '200px'};
    height:${heightCSS || '60px'};
    cursor:move; outline:none;
  `;
  container.tabIndex = 0;

  const img = document.createElement('img');
  img.src = dataURL;
  img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
  container.appendChild(img);

  const del = document.createElement('div');
  del.className = 'sig-delete';
  del.textContent = '×';
  del.addEventListener('click', e => {
    e.stopPropagation();
    container.remove();
    if (activeSigContainer === container) activeSigContainer = null;
    webEditorToast('Signature deleted');
  });
  container.appendChild(del);

  const resize = document.createElement('div');
  resize.className = 'sig-resize';
  container.appendChild(resize);

  const selectSig = () => {
    wrap.querySelectorAll('.sig-overlay').forEach(el => el.style.outline = '');
    activeSigContainer = container;
    container.style.outline = '2px solid var(--accent)';
    container.focus();
  };

  // Drag
  let startX, startY;
  container.addEventListener('mousedown', e => {
    if (e.target === resize || e.target === del) return;
    e.preventDefault(); selectSig();
    startX = e.clientX - container.offsetLeft;
    startY = e.clientY - container.offsetTop;
    const onMove = ev => {
      container.style.left = (ev.clientX - startX) + 'px';
      container.style.top  = (ev.clientY - startY) + 'px';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', onMove), { once: true });
  });

  // Resize
  let rSX, rSY, rW, rH;
  resize.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    rSX = e.clientX; rSY = e.clientY;
    rW  = container.offsetWidth; rH = container.offsetHeight;
    const onMove = ev => {
      container.style.width  = Math.max(40, rW + ev.clientX - rSX) + 'px';
      container.style.height = Math.max(20, rH + ev.clientY - rSY) + 'px';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', () => document.removeEventListener('mousemove', onMove), { once: true });
  });

  container.addEventListener('dblclick', () => {
    container.remove();
    if (activeSigContainer === container) activeSigContainer = null;
    webEditorToast('Signature deleted');
  });
  container.addEventListener('keydown', e => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      container.remove();
      if (activeSigContainer === container) activeSigContainer = null;
      webEditorToast('Signature deleted');
    }
  });

  container.title = 'Drag to position · Double-click or Delete to remove';
  wrap.appendChild(container);
  selectSig();
  webEditorToast('✓ Signature placed — drag to position', 'success');
}

// ── Annotation ────────────────────────────────────────────────────────────────
function setupAnnotationCanvas(vp) {
  const wrap  = $('pdfPageWrap');
  const pdfC  = $('pdfCanvas');
  let annotCanvas = wrap.querySelector('.annot-canvas');
  if (!annotCanvas) {
    annotCanvas = document.createElement('canvas');
    annotCanvas.className = 'annot-canvas';
    annotCanvas.id = 'annotDrawCanvas';
    annotCanvas.style.cssText = 'position:absolute;left:0;top:0;z-index:10;';
    wrap.appendChild(annotCanvas);
  }
  annotCanvas.width  = pdfC.width;
  annotCanvas.height = pdfC.height;
  annotCanvas.style.width  = pdfC.width  + 'px';
  annotCanvas.style.height = pdfC.height + 'px';
  annotCanvas.classList.toggle('active', currentMode === 'annotate');

  const ctx    = annotCanvas.getContext('2d');
  const getPos = e => {
    const r = annotCanvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (annotCanvas.width  / r.width),
      (e.clientY - r.top)  * (annotCanvas.height / r.height),
    ];
  };

  annotCanvas.onmousedown = e => { isAnnotating = true; annotStart = getPos(e); };
  annotCanvas.onmousemove = e => {
    if (!isAnnotating) return;
    const [x, y]   = getPos(e);
    const [sx, sy] = annotStart;
    ctx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
    redrawAnnotationsOnCanvas(ctx, currentPage);
    ctx.globalAlpha = parseFloat($('annotOpacity').value);
    ctx.fillStyle   = $('annotColor').value;
    ctx.fillRect(sx, sy, x - sx, y - sy);
    ctx.globalAlpha = 1;
  };
  annotCanvas.onmouseup = e => {
    if (!isAnnotating) return;
    isAnnotating = false;
    const [x, y]   = getPos(e);
    const [sx, sy] = annotStart;
    if (Math.abs(x - sx) > 5 && Math.abs(y - sy) > 5) {
      annotations.push({
        x: sx, y: sy, w: x - sx, h: y - sy,
        color:   $('annotColor').value,
        opacity: parseFloat($('annotOpacity').value),
        page:    currentPage,
      });
      webEditorToast('Annotation added');
    }
    ctx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
    redrawAnnotationsOnCanvas(ctx, currentPage);
  };

  redrawAnnotationsOnCanvas(ctx, currentPage);
}

function redrawAnnotationsOnCanvas(ctx, pageNum) {
  annotations.filter(a => a.page === pageNum).forEach(a => {
    ctx.globalAlpha = a.opacity; ctx.fillStyle = a.color;
    ctx.fillRect(a.x, a.y, a.w, a.h);
  });
  ctx.globalAlpha = 1;
}

function redrawAnnotationsForPage(pageNum) {
  const ac = $('pdfPageWrap').querySelector('.annot-canvas');
  if (!ac) return;
  const ctx = ac.getContext('2d');
  ctx.clearRect(0, 0, ac.width, ac.height);
  redrawAnnotationsOnCanvas(ctx, pageNum);
}

$('btnAnnotateClear').addEventListener('click', () => {
  annotations = annotations.filter(a => a.page !== currentPage);
  const ac = $('pdfPageWrap').querySelector('.annot-canvas');
  if (ac) ac.getContext('2d').clearRect(0, 0, ac.width, ac.height);
  webEditorToast('✓ Annotations cleared for this page');
});

// ── Thumbnails ────────────────────────────────────────────────────────────────
async function buildThumbnails() {
  if (!pdfDoc) return;
  const grid = $('thumbGrid');
  grid.innerHTML = '';
  selExtract.clear();

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp   = page.getViewport({ scale: 0.18 });
    const c    = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;

    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.page = i;
    item.innerHTML = `<div class="thumb-canvas-wrap"></div><div class="thumb-info"><div class="thumb-num">Page ${i}</div></div><div class="thumb-check">✓</div>`;
    item.querySelector('.thumb-canvas-wrap').appendChild(c);
    item.addEventListener('click', () => {
      item.classList.toggle('selected');
      if (item.classList.contains('selected')) selExtract.add(i);
      else selExtract.delete(i);
    });
    grid.appendChild(item);
  }
}

// ── Extract ───────────────────────────────────────────────────────────────────
$('btnExtractDo').addEventListener('click', async () => {
  if (!selExtract.size) { webEditorToast('Select at least one page', 'error'); return; }
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;
  showLoading('Extracting pages…');
  try {
    const pages  = Array.from(selExtract).sort((a, b) => a - b);
    const newDoc = await PDFLib.PDFDocument.create();
    const copied = await newDoc.copyPages(pdfLibDoc, pages.map(p => p - 1));
    copied.forEach(p => newDoc.addPage(p));
    downloadBytes(await newDoc.save(), `folio_pages_${pages.join('-')}.pdf`);
    hideLoading();
    webEditorToast(`✓ ${pages.length} page(s) extracted`, 'success');
    updateCreditsDisplay();
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Extraction failed: ' + e.message, 'error');
  }
});

// ── Merge ─────────────────────────────────────────────────────────────────────
function syncMergeCurrentFile(name) {
  const list  = $('mergeList');
  list.innerHTML = '';
  if (!rawPdfBytes) return;
  const item = document.createElement('div');
  item.className = 'merge-item';
  item.innerHTML = `<div class="merge-item-num">1</div><div class="merge-item-name">📌 ${name} (current)</div>`;
  list.appendChild(item);
}

$('mergeDropZone').addEventListener('click', () => $('mergeInput').click());
$('mergeDropZone').addEventListener('dragover', e => { e.preventDefault(); $('mergeDropZone').style.borderColor = 'var(--success)'; });
$('mergeDropZone').addEventListener('dragleave', () => $('mergeDropZone').style.borderColor = '');
$('mergeDropZone').addEventListener('drop', e => {
  e.preventDefault(); $('mergeDropZone').style.borderColor = '';
  Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf').forEach(addMergeFile);
});
$('mergeInput').addEventListener('change', e => { Array.from(e.target.files).forEach(addMergeFile); e.target.value = ''; });

function addMergeFile(file) {
  if (mergeFiles.find(f => f.name === file.name)) return;
  mergeFiles.push(file);
  renderMergeList();
}

function renderMergeList() {
  const list  = $('mergeList');
  const first = list.firstChild;
  list.innerHTML = '';
  if (first) list.appendChild(first);
  mergeFiles.forEach((file, idx) => {
    const item = document.createElement('div');
    item.className = 'merge-item';
    item.innerHTML = `<div class="merge-item-num">${idx + 2}</div><div class="merge-item-name">${file.name}</div><button class="merge-item-del" data-name="${file.name}">×</button>`;
    item.querySelector('.merge-item-del').addEventListener('click', () => {
      mergeFiles = mergeFiles.filter(f => f.name !== file.name);
      renderMergeList();
    });
    list.appendChild(item);
  });
}

$('btnMergeDo').addEventListener('click', async () => {
  if ((rawPdfBytes ? 1 : 0) + mergeFiles.length < 2) {
    webEditorToast('Add at least one more PDF', 'error'); return;
  }
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;
  showLoading('Merging PDFs…');
  try {
    const mergedDoc = await PDFLib.PDFDocument.create();

    if (rawPdfBytes) {
      saveSigsForPage(currentPage);
      let srcBytes = rawPdfBytes;
      if (modifiedBlocks.size > 0 || annotations.length > 0 || sigsByPage.size > 0) {
        showLoading('Applying modifications…');
        srcBytes = await buildModifiedPdfBytes();
      }
      restoreSigsForPage(currentPage);
      const srcDoc = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true });
      (await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));
    }

    for (const file of mergeFiles) {
      const srcDoc = await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
      (await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices())).forEach(p => mergedDoc.addPage(p));
    }

    downloadBytes(await mergedDoc.save(), 'folio_merged.pdf');
    hideLoading();
    webEditorToast(`✓ ${mergedDoc.getPageCount()} pages merged`, 'success');
    updateCreditsDisplay();
  } catch(e) {
    hideLoading();
    webEditorToast('❌ Merge failed: ' + e.message, 'error');
    console.error(e);
  }
});

// ── Convert ───────────────────────────────────────────────────────────────────
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
  const allowed = await WebPayment.canEdit();
  if (!allowed) return;

  showLoading('Preparing…');
  $('convertProgress').style.display = '';
  const bar = $('convertBar');
  bar.style.width = '0';

  try {
    // Build modified PDF so export includes edits + sigs
    saveSigsForPage(currentPage);
    let exportPdfDoc = pdfDoc;
    const hasChanges = modifiedBlocks.size > 0 || annotations.length > 0 || sigsByPage.size > 0;
    if (hasChanges) {
      showLoading('Applying modifications…');
      const modBytes = await buildModifiedPdfBytes();
      exportPdfDoc   = await pdfjsLib.getDocument({ data: modBytes }).promise;
    }
    restoreSigsForPage(currentPage);

    const pagesOpt = $('convertPages').value;
    let pages;
    if (pagesOpt === 'all')          pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    else if (pagesOpt === 'current') pages = [currentPage];
    else                             pages = parsePageRange($('pageRangeInput').value, totalPages);
    if (!pages.length) { webEditorToast('Invalid page range', 'error'); hideLoading(); return; }

    if (['txt', 'html', 'csv'].includes(convertFmt)) {
      let output = convertFmt === 'html'
        ? '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Folio Export</title><style>body{font-family:sans-serif;max-width:800px;margin:auto;padding:2em;line-height:1.6}</style></head><body>'
        : '';
      for (let i = 0; i < pages.length; i++) {
        bar.style.width = ((i + 1) / pages.length * 100) + '%';
        const page    = await exportPdfDoc.getPage(pages[i]);
        const content = await page.getTextContent();
        const text    = content.items.map(it => it.str).join(' ');
        if (convertFmt === 'txt')  output += `\n\n── Page ${pages[i]} ──\n\n${text}`;
        if (convertFmt === 'html') output += `<section><h2>Page ${pages[i]}</h2><p>${escapeHtml(text)}</p></section>`;
        if (convertFmt === 'csv')  output += (i === 0 ? 'Page,Text\n' : '') + `${pages[i]},"${text.replace(/"/g, '""')}"\n`;
      }
      if (convertFmt === 'html') output += '</body></html>';
      const mimes = { txt: 'text/plain', html: 'text/html', csv: 'text/csv' };
      downloadText(output, `folio_export.${convertFmt}`, mimes[convertFmt]);

    } else if (convertFmt === 'docx') {

  // docx 8.x UMD exposes window.docx
  if (typeof docx === 'undefined') throw new Error('docx lib not loaded — check the <script> tag in web-editor.html');
  const { Document, Packer, Paragraph, TextRun, ImageRun, PageBreak, AlignmentType } = docx;
  const children = [];

  for (let i = 0; i < pages.length; i++) {

    bar.style.width = ((i + 1) / pages.length * 100) + '%';

    const page = await exportPdfDoc.getPage(pages[i]);
    const content = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });

    // Group lines
    const lineMap = new Map();

    for (const item of content.items) {

      if (!item.str || !item.str.trim()) continue;

      const y = Math.round(item.transform[5]);

      let key = y;

      for (const k of lineMap.keys()) {
        if (Math.abs(k - y) <= 3) {
          key = k;
          break;
        }
      }

      if (!lineMap.has(key)) lineMap.set(key, []);

      lineMap.get(key).push(item);
    }

    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);

    if (sortedYs.length === 0) {

      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `[Page ${pages[i]} — no extractable text]`,
              italics: true,
              color: '999999'
            })
          ]
        })
      );
    }

    for (const y of sortedYs) {

      const items = lineMap
        .get(y)
        .sort((a, b) => a.transform[4] - b.transform[4]);

      const runs = items.map(item => {

        const fontSize = Math.abs(item.transform[3]);

        const fontName = (item.fontName || '').toLowerCase();

        return new TextRun({
          text: item.str,
          size: Math.round(Math.max(fontSize, 6) * 2),
          bold: fontName.includes('bold'),
          italics: fontName.includes('italic') || fontName.includes('oblique'),
          font:
            fontName.includes('times') || fontName.includes('serif')
              ? 'Times New Roman'
              : fontName.includes('courier') || fontName.includes('mono')
              ? 'Courier New'
              : 'Arial',
        });
      });

      const avgX =
        items.reduce((s, it) => s + it.transform[4], 0) / items.length;

      let alignment = AlignmentType.LEFT;

      if (avgX > vp.width * 0.6)
        alignment = AlignmentType.RIGHT;
      else if (avgX > vp.width * 0.35)
        alignment = AlignmentType.CENTER;

      children.push(
        new Paragraph({
          alignment,
          spacing: { before: 0, after: 80 },
          children: runs,
        })
      );
    }

    // signatures
    const pageSigs = sigsByPage.get(pages[i]);

    if (pageSigs && pageSigs.length > 0) {

      for (const sig of pageSigs) {

        try {

          const b64 = sig.dataURL.split(',')[1];

          const bytes = base64ToBytes(b64);

          const widthPx = parseFloat(sig.width) || 180;

          children.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: bytes,
                  transformation: {
                    width: Math.round(widthPx * 0.75),
                    height: Math.round(widthPx * 0.3),
                  },
                  type: sig.dataURL.startsWith('data:image/png')
                    ? 'png'
                    : 'jpg',
                }),
              ],
            })
          );

        } catch (e) {

          console.warn('docx sig embed:', e);
        }
      }
    }

    if (i < pages.length - 1) {

      children.push(
        new Paragraph({
          children: [new PageBreak()]
        })
      );
    }
  }

  const wordDoc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: 11906,
              height: 16838,
            },
            margin: {
              top: 1134,
              right: 1134,
              bottom: 1134,
              left: 1134,
            },
          },
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(wordDoc);

  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');

  a.href = url;
  a.download = 'folio_export.docx';

  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 2000); 
}
    
    
    else {
      // Image: jpg / png
      const fmt = convertFmt === 'png' ? 'image/png' : 'image/jpeg';
      const ext = convertFmt === 'png' ? 'png' : 'jpg';
      for (let i = 0; i < pages.length; i++) {
        bar.style.width = ((i + 1) / pages.length * 100) + '%';
        const page = await exportPdfDoc.getPage(pages[i]);
        const vp   = page.getViewport({ scale: 2 });
        const c    = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const link    = document.createElement('a');
        link.href     = c.toDataURL(fmt, 0.93);
        link.download = pages.length > 1 ? `folio_page_${pages[i]}.${ext}` : `folio_export.${ext}`;
        link.click();
        await delay(250);
      }
    }

    $('convertProgress').style.display = 'none';
    bar.style.width = '0';
    hideLoading();
    webEditorToast(`✓ ${pages.length} page(s) converted to ${convertFmt.toUpperCase()}`, 'success');
    updateCreditsDisplay();
  } catch(e) {
    $('convertProgress').style.display = 'none';
    hideLoading();
    webEditorToast('❌ Conversion failed: ' + e.message, 'error');
    console.error(e);
  }
});

// ── Credits display ───────────────────────────────────────────────────────────
async function updateCreditsDisplay() {
  try {
    const status = await WebPayment.getStatus();
    if (!status) { $('creditsCount').textContent = '?'; return; }
    const freeText = status.free_used ? '' : ' + 1 free';
    $('creditsCount').textContent = status.credits + freeText;
  } catch(e) {
    $('creditsCount').textContent = '?';
  }
}

$('creditsPill').addEventListener('click', () => WebPayment.openCheckout('5'));

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a   = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function downloadText(content, name, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a   = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function parsePageRange(str, max) {
  const pages = new Set();
  (str || '').split(',').forEach(part => {
    part = part.trim();
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = Math.max(1, a); i <= Math.min(max, b || max); i++) pages.add(i);
    } else {
      const n = parseInt(part);
      if (n >= 1 && n <= max) pages.add(n);
    }
  });
  return Array.from(pages).sort((a, b) => a - b);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function hexToRgbCanvas(hex, alpha) {
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${alpha})`;
}

function hexToRgbObj(hex) {
  return {
    r: parseInt(hex.slice(1,3),16),
    g: parseInt(hex.slice(3,5),16),
    b: parseInt(hex.slice(5,7),16),
  };
}

function buildCanvasFont(pdfFontName, sizePx) {
  const f      = (pdfFontName || '').toLowerCase();
  const bold   = f.includes('bold')                             ? 'bold '   : '';
  const italic = f.includes('oblique') || f.includes('italic') ? 'italic ' : '';
  const family = f.includes('times')   ? 'Times New Roman, serif'
               : f.includes('courier') ? 'Courier New, monospace'
               : 'Helvetica, Arial, sans-serif';
  return `${italic}${bold}${Math.round(sizePx)}px ${family}`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
init();