// ── Folio PDF Studio — web-editor.js ─────────────────────────────────────────
// Main editor logic for the web version (no chrome.* APIs)
// Must be loaded AFTER web-payment.js

  // ── Config PDF.js ──────────────────────────────────────────────────────────
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // ── State ──────────────────────────────────────────────────────────────────
  let pdfDoc         = null;
  let pdfLibDoc      = null;
  let rawPdfBytes    = null;
  let currentPage    = 1;
  let totalPages     = 0;
  let zoom           = 1.0;
  let currentMode    = 'edit';
  let textBlocks     = [];
  let selectedBlock  = null;
  let modifiedBlocks = new Map();
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
  let sigsByPage     = new Map();
  let fileName       = 'document.pdf';

  const $ = id => document.getElementById(id);

  // ── Toast ──────────────────────────────────────────────────────────────────
  function webEditorToast(msg, type = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3000);
  }
  // Alias used by web-payment.js
  window.webEditorToast = webEditorToast;

  function showLoading(msg = 'Loading…') {
    $('loadingText').textContent = msg;
    $('loadingOverlay').classList.remove('hidden');
  }
  function hideLoading() { $('loadingOverlay').classList.add('hidden'); }

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    // Read URL params for mode
    const params = new URLSearchParams(location.search);
    const modeParam = params.get('mode');
    if (modeParam) switchMode(modeParam);

    // Check session storage for a previously stored PDF (same-tab)
    const stored = sessionStorage.getItem('folioPDFData');
    const storedName = sessionStorage.getItem('folioPDFName');
    if (stored) {
      await loadPDFFromDataURL(stored, storedName || 'document.pdf');
    }

    // Restore credits display
    updateCreditsDisplay();

    // Drag & drop on empty state
    const emptyInner = $('emptyInner');
    emptyInner.addEventListener('dragover', e => { e.preventDefault(); emptyInner.classList.add('drag-over'); });
    emptyInner.addEventListener('dragleave', () => emptyInner.classList.remove('drag-over'));
    emptyInner.addEventListener('drop', e => {
      e.preventDefault(); emptyInner.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f?.type === 'application/pdf') loadFile(f);
      else webEditorToast('❌ PDF files only', 'error');
    });

    // Also allow drop on the canvas area
    const ca = $('canvasArea');
    ca.addEventListener('dragover', e => { if (pdfDoc) return; e.preventDefault(); });
    ca.addEventListener('drop', e => {
      if (pdfDoc) return;
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f?.type === 'application/pdf') loadFile(f);
    });
  }

  // ── File loading ───────────────────────────────────────────────────────────
  $('mainFileInput').addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  $('btnLoadUrl').addEventListener('click', () => {
    const url = $('urlInput').value.trim();
    if (!url) return;
    loadPDFFromURL(url);
  });

  $('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btnLoadUrl').click();
  });

  function loadFile(file) {
    fileName = file.name;
    const reader = new FileReader();
    reader.onload = e => loadPDFFromDataURL(e.target.result, file.name);
    reader.readAsDataURL(file);
  }

  async function loadPDFFromURL(url) {
    showLoading('Fetching PDF…');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const base64 = btoa(new Uint8Array(buf).reduce((d, b) => d + String.fromCharCode(b), ''));
      const dataURL = 'data:application/pdf;base64,' + base64;
      fileName = url.split('/').pop().split('?')[0] || 'document.pdf';
      await loadPDFFromDataURL(dataURL, fileName);
    } catch(e) {
      hideLoading();
      webEditorToast('❌ Could not load PDF: ' + e.message, 'error');
    }
  }

  async function loadPDFFromDataURL(dataURL, name = 'document.pdf') {
    showLoading('Reading PDF…');
    fileName = name;

    // Convert dataURL → Uint8Array
    const base64 = dataURL.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    rawPdfBytes = bytes;

    // Reset state
    modifiedBlocks.clear();
    annotations = [];
    sigsByPage.clear();
    selectedBlock = null;
    mergeFiles = [];
    selExtract.clear();
    textBlocks = [];
    currentPage = 1;

    // Store in session
    sessionStorage.setItem('folioPDFData', dataURL);
    sessionStorage.setItem('folioPDFName', name);

    try {
      // Load with pdf.js
      pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      totalPages = pdfDoc.numPages;

      // Load with pdf-lib
      pdfLibDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });

      updatePageNav();
      $('pdfPageWrap').classList.remove('hidden');
      $('emptyState').classList.add('hidden');
      $('pageNav').style.display = '';
      $('zoomCtrl').style.display = '';
      $('btnExport').disabled = false;

      await renderPage(1);

      if (currentMode === 'extract') buildExtractThumbs();

      hideLoading();
      webEditorToast('✓ PDF loaded — ' + name, 'success');
    } catch(e) {
      hideLoading();
      webEditorToast('❌ Error loading PDF: ' + e.message, 'error');
      console.error('[Folio] loadPDF error:', e);
    }
  }

  // ── Render page ────────────────────────────────────────────────────────────
  async function renderPage(num) {
    if (!pdfDoc) return;
    showLoading('Rendering page ' + num + '…');
    currentPage = num;
    updatePageNav();

    const page = await pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale: zoom });

    const canvas = $('pdfCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width  = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Re-overlay modified blocks
    applyModifiedBlockVisuals(page, viewport);

    // Render existing signatures for this page
    renderSigsForPage(num);

    // Render annotations
    renderAnnotations(viewport);

    // In edit mode: detect text blocks
    if (currentMode === 'edit') await detectTextBlocks(page, viewport);

    // In annotate mode: activate draw canvas
    setupAnnotateCanvas(viewport);

    hideLoading();
  }

  function updatePageNav() {
    $('pageNum').textContent = currentPage;
    $('totalPagesSpan').textContent = totalPages;
  }

  $('prevPage').addEventListener('click', () => {
    if (currentPage > 1) renderPage(currentPage - 1);
  });
  $('nextPage').addEventListener('click', () => {
    if (currentPage < totalPages) renderPage(currentPage + 1);
  });

  $('zoomIn').addEventListener('click', () => {
    zoom = Math.min(zoom + 0.2, 3);
    $('zoomVal').textContent = Math.round(zoom * 100) + '%';
    renderPage(currentPage);
  });
  $('zoomOut').addEventListener('click', () => {
    zoom = Math.max(zoom - 0.2, 0.4);
    $('zoomVal').textContent = Math.round(zoom * 100) + '%';
    renderPage(currentPage);
  });

  // ── Mode switching ─────────────────────────────────────────────────────────
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });

  function switchMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));

    // Hide all sidebars
    ['Edit','Sign','Annotate','Extract','Merge','Convert'].forEach(m =>
      $('sidebar' + m)?.classList.add('hidden')
    );

    // Show the right one
    const map = {
      edit: 'sidebarEdit', sign: 'sidebarSign', annotate: 'sidebarAnnotate',
      extract: 'sidebarExtract', merge: 'sidebarMerge', convert: 'sidebarConvert'
    };
    if (map[mode]) $('sidebarEdit').classList.add('hidden');
    const target = map[mode];
    if (target && $(target)) $(target).classList.remove('hidden');
    if (mode === 'edit') $('sidebarEdit').classList.remove('hidden');

    // Set export button label
    const labels = {
      edit: '↓ Export PDF', sign: '↓ Export PDF', annotate: '↓ Export PDF',
      extract: '✂ Extract', merge: '🔀 Merge', convert: '⚡ Convert'
    };
    $('btnExport').textContent = labels[mode] || '↓ Export PDF';

    // Re-render with mode-specific overlays
    if (pdfDoc) {
      if (mode === 'extract') buildExtractThumbs();
      renderPage(currentPage);
    }

    // Setup annotate canvas
    const dc = $('annotDrawCanvas');
    if (dc) dc.classList.toggle('active', mode === 'annotate');
  }

  // ── Text block detection ───────────────────────────────────────────────────
  async function detectTextBlocks(page, viewport) {
    const content = await page.getTextContent();
    textBlocks = [];

    // Group items by approximate line / block
    const items = content.items.filter(i => i.str.trim());
    items.forEach((item, idx) => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x = tx[4];
      const y = tx[5];
      const fs = Math.sqrt(tx[2]*tx[2] + tx[3]*tx[3]);
      textBlocks.push({
        id: idx,
        text: item.str,
        x: x,
        y: y - fs,
        w: item.width * zoom,
        h: fs * 1.4,
        fontSize: fs,
        page: currentPage
      });
    });

    renderBlockList();
    renderBlockOverlays(viewport);
  }

  function renderBlockList() {
    const list = $('blockList');
    if (!textBlocks.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:8px 4px;">No text blocks on this page</div>';
      return;
    }
    list.innerHTML = textBlocks.map(b => {
      const key = `${b.page}-${b.id}`;
      const isModified = modifiedBlocks.has(key);
      return `<div class="block-item ${selectedBlock?.id === b.id ? 'selected' : ''}" data-id="${b.id}">
        <div class="block-preview">${isModified ? '✎ ' : ''}${b.text.slice(0, 36)}${b.text.length > 36 ? '…' : ''}</div>
        <div class="block-meta">Size ${b.fontSize.toFixed(1)}px · x${b.x.toFixed(0)} y${b.y.toFixed(0)}</div>
      </div>`;
    }).join('');

    list.querySelectorAll('.block-item').forEach(el => {
      el.addEventListener('click', () => selectBlock(parseInt(el.dataset.id)));
    });
  }

  function renderBlockOverlays(viewport) {
    // Remove old overlays
    document.querySelectorAll('.block-overlay').forEach(el => el.remove());
    const wrap = $('pdfPageWrap');

    textBlocks.forEach(b => {
      const div = document.createElement('div');
      div.className = 'block-overlay' + (selectedBlock?.id === b.id ? ' selected' : '');
      div.style.left   = b.x + 'px';
      div.style.top    = b.y + 'px';
      div.style.width  = Math.max(b.w, 20) + 'px';
      div.style.height = Math.max(b.h, 12) + 'px';
      div.dataset.id = b.id;
      div.addEventListener('click', () => selectBlock(b.id));
      wrap.appendChild(div);
    });
  }

  function selectBlock(id) {
    selectedBlock = textBlocks.find(b => b.id === id);
    if (!selectedBlock) return;

    // Highlight in list
    document.querySelectorAll('.block-item').forEach(el =>
      el.classList.toggle('selected', parseInt(el.dataset.id) === id)
    );
    // Highlight overlay
    document.querySelectorAll('.block-overlay').forEach(el =>
      el.classList.toggle('selected', parseInt(el.dataset.id) === id)
    );

    // Show props
    $('propPanel').style.display = '';
    $('propText').value = selectedBlock.text;
    $('propSize').value = selectedBlock.fontSize.toFixed(1);
    $('applyProps').disabled = false;

    // Load saved mod if any
    const key = `${selectedBlock.page}-${selectedBlock.id}`;
    if (modifiedBlocks.has(key)) {
      const mod = modifiedBlocks.get(key);
      $('propText').value  = mod.text ?? selectedBlock.text;
      $('propColor').value = mod.color ?? '#000000';
      $('propSize').value  = mod.size ?? selectedBlock.fontSize.toFixed(1);
      $('propFont').value  = mod.font ?? 'Helvetica';
      $('propBgColor').value   = mod.bgColor ?? '#ffffff';
      $('propBgOpacity').value = mod.bgOpacity ?? 0;
      $('propRotation').value  = mod.rotation ?? 0;
    }
  }

  function applyModifiedBlockVisuals(page, viewport) {
    // Overlay text from modified blocks on top of canvas
    if (!modifiedBlocks.size) return;
    const canvas = $('pdfCanvas');
    const ctx = canvas.getContext('2d');

    modifiedBlocks.forEach((mod, key) => {
      const [pg, idStr] = key.split('-');
      if (parseInt(pg) !== currentPage) return;
      const id = parseInt(idStr);
      const block = textBlocks.find(b => b.id === id);
      if (!block) return;

      const fs = parseFloat(mod.size) || block.fontSize;
      if (parseFloat(mod.bgOpacity) > 0) {
        ctx.globalAlpha = parseFloat(mod.bgOpacity);
        ctx.fillStyle = mod.bgColor || '#ffffff';
        ctx.fillRect(block.x, block.y, Math.max(block.w, 20), Math.max(block.h, 12));
        ctx.globalAlpha = 1;
      }
      ctx.font = `${fs}px ${mod.font || 'sans-serif'}`;
      ctx.fillStyle = mod.color || '#000000';
      if (mod.rotation) {
        ctx.save();
        ctx.translate(block.x + block.w/2, block.y + block.h/2);
        ctx.rotate(parseFloat(mod.rotation) * Math.PI / 180);
        ctx.fillText(mod.text || block.text, -block.w/2, fs/2);
        ctx.restore();
      } else {
        ctx.fillText(mod.text || block.text, block.x, block.y + fs);
      }
    });
  }

  function updateModBadge() {
    const badge = $('modBadge');
    badge.classList.toggle('hidden', modifiedBlocks.size === 0);
    if (modifiedBlocks.size > 0) badge.textContent = modifiedBlocks.size + ' modified';
  }

  $('applyProps').addEventListener('click', async () => {
    if (!selectedBlock) return;

    if (!(await WebPayment.canEdit())) return;

    const key = `${selectedBlock.page}-${selectedBlock.id}`;
    modifiedBlocks.set(key, {
      text:      $('propText').value,
      font:      $('propFont').value,
      size:      parseFloat($('propSize').value),
      color:     $('propColor').value,
      bgColor:   $('propBgColor').value,
      bgOpacity: parseFloat($('propBgOpacity').value),
      rotation:  parseFloat($('propRotation').value),
      x: selectedBlock.x, y: selectedBlock.y,
      w: selectedBlock.w, h: selectedBlock.h
    });

    updateModBadge();
    await renderPage(currentPage);
    webEditorToast('✓ Changes applied', 'success');
    updateCreditsDisplay();
  });

  // ── Signatures ─────────────────────────────────────────────────────────────
  sigCanvas = $('sigCanvas');
  sigCtx    = sigCanvas.getContext('2d');

  function initSigCanvas() {
    sigCanvas.width  = sigCanvas.offsetWidth;
    sigCanvas.height = sigCanvas.offsetHeight;
    sigCtx.strokeStyle = '#003380';
    sigCtx.lineWidth   = 2.5;
    sigCtx.lineCap     = 'round';
    sigCtx.lineJoin    = 'round';
  }

  setTimeout(initSigCanvas, 100);

  sigCanvas.addEventListener('mousedown', e => {
    sigIsDrawing = true;
    sigCtx.beginPath();
    const r = sigCanvas.getBoundingClientRect();
    sigCtx.moveTo(e.clientX - r.left, e.clientY - r.top);
  });
  sigCanvas.addEventListener('mousemove', e => {
    if (!sigIsDrawing) return;
    const r = sigCanvas.getBoundingClientRect();
    sigCtx.lineTo(e.clientX - r.left, e.clientY - r.top);
    sigCtx.stroke();
  });
  sigCanvas.addEventListener('mouseup', () => sigIsDrawing = false);
  sigCanvas.addEventListener('touchstart', e => {
    e.preventDefault(); sigIsDrawing = true;
    sigCtx.beginPath();
    const r = sigCanvas.getBoundingClientRect();
    const t = e.touches[0];
    sigCtx.moveTo(t.clientX - r.left, t.clientY - r.top);
  }, { passive: false });
  sigCanvas.addEventListener('touchmove', e => {
    e.preventDefault(); if (!sigIsDrawing) return;
    const r = sigCanvas.getBoundingClientRect();
    const t = e.touches[0];
    sigCtx.lineTo(t.clientX - r.left, t.clientY - r.top);
    sigCtx.stroke();
  }, { passive: false });
  sigCanvas.addEventListener('touchend', () => sigIsDrawing = false);

  $('sigClear').addEventListener('click', () => {
    sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  });

  $('sigApply').addEventListener('click', () => {
    if (!pdfDoc) return webEditorToast('❌ Open a PDF first', 'error');
    placeSig(sigCanvas.toDataURL());
  });

  $('sigTextApply').addEventListener('click', () => {
    if (!pdfDoc) return webEditorToast('❌ Open a PDF first', 'error');
    const name  = $('sigTextInput').value.trim();
    const font  = $('sigTextFont').value;
    const color = $('sigTextColor').value;
    if (!name) return webEditorToast('❌ Enter your name', 'error');

    const c = document.createElement('canvas');
    c.width = 300; c.height = 80;
    const ctx = c.getContext('2d');
    ctx.font = `40px ${font}`;
    ctx.fillStyle = color;
    ctx.fillText(name, 10, 55);
    placeSig(c.toDataURL());
  });

  $('sigImgDrop').addEventListener('click', () => $('sigImgInput').click());
  $('sigImgInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
      sigImgData = ev.target.result;
      webEditorToast('✓ Image loaded — click "Replace image"', 'success');
    };
    r.readAsDataURL(f);
  });
  $('sigImgApply').addEventListener('click', () => {
    if (!sigImgData) return webEditorToast('❌ Choose an image first', 'error');
    if (!pdfDoc)     return webEditorToast('❌ Open a PDF first', 'error');
    placeSig(sigImgData);
  });

  document.querySelectorAll('.sig-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sig-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      sigMode = tab.dataset.sig;
      $('sigDraw').classList.toggle('hidden', sigMode !== 'draw');
      $('sigText').classList.toggle('hidden', sigMode !== 'text');
      $('sigImage').classList.toggle('hidden', sigMode !== 'image');
    });
  });

  function placeSig(dataURL) {
    const wrap = $('pdfPageWrap');
    const canvas = $('pdfCanvas');
    const container = document.createElement('div');
    container.className = 'sig-overlay';
    container.style.left   = '40px';
    container.style.top    = '40px';
    container.style.width  = '200px';
    container.style.height = '60px';

    const img = document.createElement('img');
    img.src = dataURL;
    container.appendChild(img);

    const del = document.createElement('div');
    del.className = 'sig-delete';
    del.textContent = '×';
    del.addEventListener('click', () => {
      container.remove();
      const sigs = sigsByPage.get(currentPage) || [];
      sigsByPage.set(currentPage, sigs.filter(s => s.el !== container));
    });
    container.appendChild(del);

    const resize = document.createElement('div');
    resize.className = 'sig-resize';
    container.appendChild(resize);

    // Drag
    let dragging = false, dx = 0, dy = 0;
    container.addEventListener('mousedown', e => {
      if (e.target === resize || e.target === del) return;
      dragging = true;
      dx = e.clientX - container.offsetLeft;
      dy = e.clientY - container.offsetTop;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      container.style.left = (e.clientX - dx) + 'px';
      container.style.top  = (e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', () => dragging = false);

    // Resize
    let resizing = false, rw = 0, rh = 0, rx = 0, ry = 0;
    resize.addEventListener('mousedown', e => {
      e.stopPropagation();
      resizing = true; rw = container.offsetWidth; rh = container.offsetHeight;
      rx = e.clientX; ry = e.clientY;
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      container.style.width  = Math.max(60, rw + (e.clientX - rx)) + 'px';
      container.style.height = Math.max(20, rh + (e.clientY - ry)) + 'px';
    });
    document.addEventListener('mouseup', () => resizing = false);

    wrap.appendChild(container);

    const sigs = sigsByPage.get(currentPage) || [];
    sigs.push({ dataURL, el: container });
    sigsByPage.set(currentPage, sigs);
    webEditorToast('✓ Signature placed — drag to position', 'success');
  }

  function renderSigsForPage(page) {
    document.querySelectorAll('.sig-overlay').forEach(el => el.remove());
    const sigs = sigsByPage.get(page) || [];
    sigs.forEach(s => {
      if (s.el) $('pdfPageWrap').appendChild(s.el);
    });
  }

  // ── Annotations ────────────────────────────────────────────────────────────
  function setupAnnotateCanvas(viewport) {
    let ac = $('annotDrawCanvas');
    if (!ac) {
      ac = document.createElement('canvas');
      ac.id = 'annotDrawCanvas';
      ac.style.cssText = 'position:absolute;inset:0;';
      $('pdfPageWrap').appendChild(ac);
    }
    ac.width  = viewport.width;
    ac.height = viewport.height;
    ac.style.width  = viewport.width + 'px';
    ac.style.height = viewport.height + 'px';
    ac.classList.toggle('active', currentMode === 'annotate');

    const actx = ac.getContext('2d');

    ac.onmousedown = e => {
      if (currentMode !== 'annotate') return;
      isAnnotating = true;
      const r = ac.getBoundingClientRect();
      annotStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    ac.onmousemove = e => {
      if (!isAnnotating) return;
      const r = ac.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      actx.clearRect(0, 0, ac.width, ac.height);
      redrawAnnotations(actx);
      actx.globalAlpha = parseFloat($('annotOpacity').value);
      actx.fillStyle = $('annotColor').value;
      actx.fillRect(annotStart.x, annotStart.y, cx - annotStart.x, cy - annotStart.y);
      actx.globalAlpha = 1;
    };
    ac.onmouseup = e => {
      if (!isAnnotating) return;
      isAnnotating = false;
      const r = ac.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      annotations.push({
        x: annotStart.x, y: annotStart.y,
        w: cx - annotStart.x, h: cy - annotStart.y,
        color: $('annotColor').value,
        opacity: parseFloat($('annotOpacity').value),
        page: currentPage
      });
      redrawAnnotations(actx);
    };

    redrawAnnotations(actx);
  }

  function redrawAnnotations(ctx) {
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    annotations.filter(a => a.page === currentPage).forEach(a => {
      ctx.globalAlpha = a.opacity;
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
    });
    ctx.globalAlpha = 1;
  }

  function renderAnnotations(viewport) {
    const ac = $('annotDrawCanvas');
    if (!ac) return;
    const actx = ac.getContext('2d');
    redrawAnnotations(actx);
  }

  $('btnAnnotateClear').addEventListener('click', () => {
    annotations = annotations.filter(a => a.page !== currentPage);
    const ac = $('annotDrawCanvas');
    if (ac) ac.getContext('2d').clearRect(0, 0, ac.width, ac.height);
    webEditorToast('✓ Annotations cleared for this page', 'success');
  });

  // ── Extract thumbnails ─────────────────────────────────────────────────────
  async function buildExtractThumbs() {
    if (!pdfDoc) return;
    const grid = $('thumbGrid');
    grid.innerHTML = '';
    selExtract.clear();

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 0.15 });
      const c = document.createElement('canvas');
      c.width = viewport.width; c.height = viewport.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;

      const item = document.createElement('div');
      item.className = 'thumb-item';
      item.dataset.page = i;
      item.innerHTML = `<div class="thumb-num">p.${i}</div>`;
      item.prepend(c);
      item.addEventListener('click', () => {
        item.classList.toggle('selected');
        if (item.classList.contains('selected')) selExtract.add(i);
        else selExtract.delete(i);
      });
      grid.appendChild(item);
    }
  }

  $('btnExtractDo').addEventListener('click', async () => {
    if (!selExtract.size) return webEditorToast('❌ Select at least one page', 'error');
    showLoading('Extracting pages…');
    try {
      const src = await PDFLib.PDFDocument.load(rawPdfBytes);
      const out = await PDFLib.PDFDocument.create();
      const pages = Array.from(selExtract).sort((a,b) => a-b);
      const copied = await out.copyPages(src, pages.map(p => p - 1));
      copied.forEach(p => out.addPage(p));
      const bytes = await out.save();
      downloadBytes(bytes, 'extracted-pages.pdf');
      hideLoading();
      webEditorToast(`✓ ${pages.length} page(s) extracted`, 'success');
    } catch(e) {
      hideLoading();
      webEditorToast('❌ Extraction failed: ' + e.message, 'error');
    }
  });

  // ── Merge ──────────────────────────────────────────────────────────────────
  $('mergeDropZone').addEventListener('click', () => $('mergeInput').click());
  $('mergeInput').addEventListener('change', e => {
    Array.from(e.target.files).forEach(addMergeFile);
    e.target.value = '';
  });
  $('mergeDropZone').addEventListener('dragover', e => e.preventDefault());
  $('mergeDropZone').addEventListener('drop', e => {
    e.preventDefault();
    Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf').forEach(addMergeFile);
  });

  function addMergeFile(file) {
    mergeFiles.push(file);
    const item = document.createElement('div');
    item.className = 'merge-file';
    item.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${file.name}</span>
      <span style="color:var(--muted);font-size:9px;">${(file.size/1024).toFixed(0)} KB</span>`;
    $('mergeList').appendChild(item);
  }

  $('btnMergeDo').addEventListener('click', async () => {
    if (!rawPdfBytes && !mergeFiles.length) return webEditorToast('❌ Add PDFs to merge', 'error');
    showLoading('Merging PDFs…');
    try {
      const out = await PDFLib.PDFDocument.create();

      // Current PDF first
      if (rawPdfBytes) {
        const src = await PDFLib.PDFDocument.load(rawPdfBytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      }

      for (const file of mergeFiles) {
        const bytes = await file.arrayBuffer();
        const src = await PDFLib.PDFDocument.load(bytes);
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach(p => out.addPage(p));
      }

      const bytes = await out.save();
      downloadBytes(bytes, 'merged.pdf');
      hideLoading();
      webEditorToast(`✓ ${mergeFiles.length + (rawPdfBytes ? 1 : 0)} PDFs merged`, 'success');
    } catch(e) {
      hideLoading();
      webEditorToast('❌ Merge failed: ' + e.message, 'error');
    }
  });

  // ── Convert ────────────────────────────────────────────────────────────────
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
    if (!pdfDoc) return webEditorToast('❌ Open a PDF first', 'error');

    // Determine which pages
    let pages = [];
    const sel = $('convertPages').value;
    if (sel === 'current') pages = [currentPage];
    else if (sel === 'range') {
      const raw = $('pageRangeInput').value;
      pages = parsePageRange(raw, totalPages);
    } else {
      pages = Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    if (!pages.length) return webEditorToast('❌ Invalid page range', 'error');

    showLoading('Converting…');
    const bar = $('convertBar');
    $('convertProgress').style.display = '';
    bar.style.width = '0%';

    try {
      if (convertFmt === 'txt' || convertFmt === 'html' || convertFmt === 'csv') {
        let text = '';
        for (let i = 0; i < pages.length; i++) {
          const page = await pdfDoc.getPage(pages[i]);
          const content = await page.getTextContent();
          const pageText = content.items.map(item => item.str).join(' ');
          text += (convertFmt === 'csv') ? pageText.replace(/,/g, ';') + '\n' : pageText + '\n\n';
          bar.style.width = ((i + 1) / pages.length * 100) + '%';
        }
        if (convertFmt === 'html') {
          text = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Converted PDF</title></head><body><pre style="font-family:sans-serif;white-space:pre-wrap;">${text}</pre></body></html>`;
        }
        const ext = convertFmt;
        const blob = new Blob([text], { type: ext === 'html' ? 'text/html' : 'text/plain' });
        downloadBlob(blob, fileName.replace('.pdf', '.' + ext));
        hideLoading();
        $('convertProgress').style.display = 'none';
        webEditorToast(`✓ Converted to ${convertFmt.toUpperCase()}`, 'success');
        return;
      }

      // Image formats
      const zip = [];
      for (let i = 0; i < pages.length; i++) {
        const page = await pdfDoc.getPage(pages[i]);
        const viewport = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas');
        c.width = viewport.width; c.height = viewport.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;

        if (pages.length === 1) {
          const ext = convertFmt === 'png' ? 'png' : 'jpg';
          const mime = convertFmt === 'png' ? 'image/png' : 'image/jpeg';
          c.toBlob(blob => downloadBlob(blob, fileName.replace('.pdf', `-p${pages[i]}.${ext}`)), mime, 0.92);
        } else {
          zip.push({ page: pages[i], dataURL: c.toDataURL(convertFmt === 'png' ? 'image/png' : 'image/jpeg', 0.92) });
        }
        bar.style.width = ((i + 1) / pages.length * 100) + '%';
      }

      if (pages.length > 1) {
        // Download each as individual file
        zip.forEach(({ page, dataURL }) => {
          const ext = convertFmt === 'png' ? 'png' : 'jpg';
          const a = document.createElement('a');
          a.href = dataURL;
          a.download = fileName.replace('.pdf', `-p${page}.${ext}`);
          a.click();
        });
      }

      hideLoading();
      $('convertProgress').style.display = 'none';
      webEditorToast(`✓ Converted ${pages.length} page(s) to ${convertFmt.toUpperCase()}`, 'success');
    } catch(e) {
      hideLoading();
      $('convertProgress').style.display = 'none';
      webEditorToast('❌ Conversion failed: ' + e.message, 'error');
    }
  });

  function parsePageRange(str, max) {
    const pages = new Set();
    str.split(',').forEach(part => {
      part = part.trim();
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number);
        for (let i = a; i <= Math.min(b, max); i++) pages.add(i);
      } else {
        const n = parseInt(part);
        if (n >= 1 && n <= max) pages.add(n);
      }
    });
    return Array.from(pages).sort((a, b) => a - b);
  }

  // ── Export PDF ─────────────────────────────────────────────────────────────
  $('btnExport').addEventListener('click', async () => {
    if (!pdfDoc) return;
    if (currentMode === 'extract') { $('btnExtractDo').click(); return; }
    if (currentMode === 'merge')   { $('btnMergeDo').click();   return; }
    if (currentMode === 'convert') { $('btnConvertDo').click();  return; }

    showLoading('Building PDF…');
    try {
      const bytes = await buildModifiedPdfBytes();
      downloadBytes(bytes, fileName.replace('.pdf', '-edited.pdf'));
      hideLoading();
      webEditorToast('✓ PDF downloaded', 'success');
    } catch(e) {
      hideLoading();
      webEditorToast('❌ Export failed: ' + e.message, 'error');
    }
  });

  async function buildModifiedPdfBytes() {
    const doc = await PDFLib.PDFDocument.load(rawPdfBytes);
    doc.registerFontkit(fontkit);

    // Apply text modifications
    for (const [key, mod] of modifiedBlocks) {
      const [pgStr] = key.split('-');
      const pg = parseInt(pgStr);
      const page = doc.getPage(pg - 1);
      const { height } = page.getSize();

      // Map font name to pdf-lib standard font
      const fontMap = {
        'Helvetica': PDFLib.StandardFonts.Helvetica,
        'Times-Roman': PDFLib.StandardFonts.TimesRoman,
        'Courier': PDFLib.StandardFonts.Courier,
      };
      const pdfFont = await doc.embedFont(fontMap[mod.font] || PDFLib.StandardFonts.Helvetica);

      const fs = parseFloat(mod.size) || 12;
      const x  = mod.x / zoom;
      const y  = (height - (mod.y / zoom) - (mod.h / zoom));

      if (parseFloat(mod.bgOpacity) > 0) {
        const c = hexToRgb(mod.bgColor);
        page.drawRectangle({
          x, y, width: mod.w / zoom, height: mod.h / zoom,
          color: PDFLib.rgb(c.r/255, c.g/255, c.b/255),
          opacity: parseFloat(mod.bgOpacity)
        });
      }

      const tc = hexToRgb(mod.color || '#000000');
      page.drawText(mod.text || '', {
        x, y, size: fs, font: pdfFont,
        color: PDFLib.rgb(tc.r/255, tc.g/255, tc.b/255),
        rotate: mod.rotation ? PDFLib.degrees(parseFloat(mod.rotation)) : undefined
      });
    }

    // Embed signatures
    for (const [pg, sigs] of sigsByPage) {
      const page = doc.getPage(pg - 1);
      const { width: pw, height: ph } = page.getSize();

      for (const s of sigs) {
        if (!s.el || !s.dataURL) continue;
        const dataURL = s.dataURL;
        const mimeMatch = dataURL.match(/data:image\/([a-z]+);base64,/);
        if (!mimeMatch) continue;
        const mime = mimeMatch[1];
        const b64 = dataURL.split(',')[1];
        const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

        let embImg;
        try {
          embImg = mime === 'png' ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
        } catch(e) {
          // Try PNG as fallback
          try { embImg = await doc.embedPng(imgBytes); } catch(e2) { continue; }
        }

        // Get position from DOM element (relative to canvas)
        const canvas = $('pdfCanvas');
        const cRect  = canvas.getBoundingClientRect();
        const eRect  = s.el.getBoundingClientRect();
        const elLeft = s.el.offsetLeft;
        const elTop  = s.el.offsetTop;
        const elW    = s.el.offsetWidth;
        const elH    = s.el.offsetHeight;

        page.drawImage(embImg, {
          x: elLeft / zoom,
          y: ph - (elTop + elH) / zoom,
          width:  elW / zoom,
          height: elH / zoom,
        });
      }
    }

    // Embed annotations
    for (const ann of annotations) {
      const page = doc.getPage(ann.page - 1);
      const { height: ph } = page.getSize();
      const c = hexToRgb(ann.color);
      page.drawRectangle({
        x: ann.x / zoom, y: ph - (ann.y + ann.h) / zoom,
        width: ann.w / zoom, height: ann.h / zoom,
        color: PDFLib.rgb(c.r/255, c.g/255, c.b/255),
        opacity: ann.opacity
      });
    }

    return doc.save();
  }

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return { r, g, b };
  }

  // ── Download helpers ───────────────────────────────────────────────────────
  function downloadBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    downloadBlob(blob, name);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ── Credits display ────────────────────────────────────────────────────────
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

  // ── Boot ───────────────────────────────────────────────────────────────────
  init();