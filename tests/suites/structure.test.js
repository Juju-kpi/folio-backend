// Table / layout structure suite
//  1. detection: each ground-truth cell (or line) must be exactly one text block
//     (never merged with the next cell, never cut) — a cell wrapped on several
//     lines by its author counts as one block per line;
//  2. editing: several cells are edited (longer and shorter texts), exported and
//     compared pixel by pixel with the original: table borders intact, other
//     texts and other cells untouched, new texts present;
//  3. same with property changes: font size ×1.6 to ×3, other font, text colour,
//     extra background, manual cover colour.
// Fixtures: fixtures/tables/*.pdf + *.json (see generators/).
const { setup, ORIGIN } = require('../lib/harness');
const { openFile, TABLES: DIR, OUT } = require('../lib/helpers');
const fs = require('fs'), path = require('path');
const norm = s => String(s || '').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

// cell text laid out on several lines by its author: blocks stacked in the same
// column (same left edge, one below the other) whose texts join to it
function wrapped(t, blocks) {
  const chain = (acc, last) => {
    if (acc === t) return true;
    if (!t.startsWith(acc + ' ')) return false;
    return blocks.some(b => b !== last && b.bbox.y > last.bbox.y + last.bbox.h * 0.5 && b.bbox.y < last.bbox.y + last.bbox.h * 2.5 &&
      Math.abs(b.bbox.x - last.bbox.x) < 3 && chain(acc + ' ' + norm(b.text), b));
  };
  return blocks.some(b => { const x = norm(b.text); return x !== t && t.startsWith(x + ' ') && chain(x, b); });
}

async function analyse(page, file) {
  const gt = JSON.parse(fs.readFileSync(file.replace(/\.pdf$/, '.json'), 'utf8')).pages[0];
  const blocks = await page.evaluate(() => getPageInfo(1).blocks.map(b => ({ key: b.key, text: b.text, bbox: b.bbox })));
  const btexts = blocks.map(b => norm(b.text));
  const res = { ok: 0, merged: [], split: [] };
  const expected = [...gt.cells.map(c => norm(c.text)), ...gt.lines.map(norm)].filter(Boolean);
  for (const t of expected) {
    if (btexts.includes(t)) res.ok++;
    else if (wrapped(t, blocks)) { res.ok++; res.wrapped = (res.wrapped || 0) + 1; }
    else if (btexts.some(b => b.includes(t))) res.merged.push(`"${t}" ⊂ "${btexts.find(b => b.includes(t))}"`);
    else res.split.push(`"${t}"`);
  }
  res.total = expected.length;
  return { gt, blocks, res };
}

async function editAndCheck(page, file, gt, blocks, props = false, maxEdits = 6) {
  // cells whose block is found (exact or containing)
  // match each ground-truth cell to the block drawn inside it (same text can appear in many rows)
  const inside = (b, box) => { const cx = b.bbox.x + b.bbox.w / 2, cy = b.bbox.y + b.bbox.h / 2; return cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3]; };
  const used = new Set();
  const cand = gt.cells.map((c, i) => {
    const t = norm(c.text);
    const pool = blocks.filter(b => !used.has(b.key) && (!c.box || inside(b, c.box)));
    const b = pool.find(b => norm(b.text) === t) || pool.find(b => norm(b.text).includes(t));
    if (b) used.add(b.key);
    return { c, i, b };
  }).filter(x => x.b && norm(x.c.text).length > 0);
  const step = Math.max(1, Math.floor(cand.length / maxEdits));
  const chosen = [];
  for (let i = 0; i < cand.length && chosen.length < maxEdits; i += step) if (!chosen.some(x => x.b.key === cand[i].b.key)) chosen.push(cand[i]);
  const edits = [];
  for (const [n, x] of chosen.entries()) {
    const newText = n % 3 === 2 ? norm(x.c.text).slice(0, 2) : norm(x.c.text) + ' modifié 2026';
    const mode = props ? n % 5 : -1;
    await page.evaluate(({ key, newText, mode }) => {
      selectBlock(key); propText.value = newText;
      const sz = parseFloat(propSize.value);
      if (mode === 0) propSize.value = (sz * 2.5).toFixed(1);
      if (mode === 1) { propFont.value = 'Times-Bold'; propSize.value = (sz * 1.6).toFixed(1); }
      if (mode === 2) { propColor.value = '#d01010'; propBgColor.value = '#ffe000'; propBgOpacity.value = '1'; }
      if (mode === 3) { propCoverAuto.checked = false; propCoverColor.value = '#40a0ff'; propSize.value = (sz * 3).toFixed(1); }
      if (mode === 4) { propFont.value = 'Courier-Bold'; propColor.value = '#00aa00'; propBgColor.value = '#ff00ff'; propBgOpacity.value = '0.5'; }
      propText.dispatchEvent(new Event('input'));
    }, { key: x.b.key, newText, mode });
    await page.click('#applyProps');
    await page.waitForFunction(k => textEdits.has(k), x.b.key, { timeout: 15000 });
    const grew = await page.evaluate(k => { const e = textEdits.get(k); return e.fontSize > e.origSize ? e.drawSize > e.origSize + 0.01 : null; }, x.b.key);
    edits.push({ key: x.b.key, newText, cell: x.c, bbox: x.b.bbox, grew });
  }
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#btnExport')]);
  const outPath = path.join(OUT, (props ? 'props_' : 'struct_') + path.basename(file));
  await dl.saveAs(outPath);
  await page.waitForFunction(() => document.getElementById('loadingOverlay').classList.contains('hidden'));
  const orig = fs.readFileSync(file).toString('base64'), exp = fs.readFileSync(outPath).toString('base64');
  const bigger = edits.filter(e => e.grew !== null);
  const res = await page.evaluate(async ({ orig, exp, edits, others, hasBoxes, otherCells }) => {
    const S = 2;
    async function render(b64) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, standardFontDataUrl: new URL('lib/pdfjs/standard_fonts/', location.href).href }).promise;
      const p = await doc.getPage(1); const vp = p.getViewport({ scale: S });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const text = (await p.getTextContent()).items.map(i => i.str).join(' ');
      return { w: c.width, h: c.height, d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, text };
    }
    const A = await render(orig), B = await render(exp);
    const W = A.w, H = A.h;
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // rule mask: long dark runs in the original
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = lum(A.d, i * 4) < 150 ? 1 : 0;
    const rule = new Uint8Array(W * H), RUN = 30;
    for (let y = 0; y < H; y++) { let s = -1; for (let x = 0; x <= W; x++) { const v = x < W && dark[y * W + x]; if (v && s < 0) s = x; if (!v && s >= 0) { if (x - s >= RUN) for (let k = s; k < x; k++) rule[y * W + k] = 1; s = -1; } } }
    for (let x = 0; x < W; x++) { let s = -1; for (let y = 0; y <= H; y++) { const v = y < H && dark[y * W + x]; if (v && s < 0) s = y; if (!v && s >= 0) { if (y - s >= RUN) for (let k = s; k < y; k++) rule[k * W + x] = 1; s = -1; } } }
    let rulePx = 0, ruleDamaged = 0;
    const diffAt = i => Math.abs(lum(A.d, i * 4) - lum(B.d, i * 4));
    // keep only thin lines (borders), not large dark areas (dark header cells)
    const thin = i => { const x = i % W, y = (i / W) | 0; let v = 0, h = 0; for (let k = -4; k <= 4; k++) { if (y + k >= 0 && y + k < H && dark[(y + k) * W + x]) v++; if (x + k >= 0 && x + k < W && dark[y * W + x + k]) h++; } return v <= 5 || h <= 5; };
    const ruleSmp = [];
    // the edited text area itself is legitimately repainted: only its surroundings count
    const own = new Uint8Array(W * H);
    for (const e of edits) { const r = e.bbox; const x0 = Math.max(0, Math.floor((r.x + 0.5) * S)), y0 = Math.max(0, Math.floor((r.y + 0.5) * S)), x1 = Math.min(W, Math.ceil((r.x + r.w - 0.5) * S)), y1 = Math.min(H, Math.ceil((r.y + r.h - 0.5) * S)); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) own[y * W + x] = 1; }
    for (let i = 0; i < W * H; i++) if (rule[i] && thin(i) && !own[i]) { rulePx++; if (diffAt(i) > 60) { ruleDamaged++; if (ruleSmp.length < 4) ruleSmp.push([(i % W) / S, Math.floor(i / W) / S].map(v => v.toFixed(1)).join(',') + ':' + Math.round(lum(A.d, i * 4)) + '→' + Math.round(lum(B.d, i * 4))); } }
    // 1. other text untouched: pixels inside unedited blocks (shrunk 0.5 pu)
    const zone = (rects, shrink) => { const m = new Uint8Array(W * H); for (const r of rects) { const x0 = Math.max(0, Math.floor((r[0] + shrink) * S)), y0 = Math.max(0, Math.floor((r[1] + shrink) * S)), x1 = Math.min(W, Math.ceil((r[0] + r[2] - shrink) * S)), y1 = Math.min(H, Math.ceil((r[1] + r[3] - shrink) * S)); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1; } return m; };
    const count = (mask) => { let n = 0; const smp = []; for (let i = 0; i < W * H; i++) if (mask[i] && diffAt(i) > 40) { n++; if (smp.length < 3) smp.push([(i % W) / S, Math.floor(i / W) / S].map(v => v.toFixed(0)).join(',')); } return [n, smp]; };
    const [textDamage, textSmp] = count(zone(others.map(b => [b.x, b.y, b.w, b.h]), 0.5));
    // 2. other cells untouched (ground truth boxes, 1.5 pu margin)
    let cellSpill = 0, cellSmp = [];
    if (hasBoxes) [cellSpill, cellSmp] = count(zone(otherCells, 1.5));
    const outside = textDamage + cellSpill, outsideSamples = [...textSmp, ...cellSmp];
    const n = s => s.replace(/\s+/g, ' ');
    const missing = edits.filter(e => !n(B.text).includes(e.newText.split(' ')[0])).map(e => e.newText);
    return { rulePx, ruleDamaged, ruleSmp, outside, outsideSamples, textDamage, cellSpill, missing, nEdits: edits.length };
  }, { orig, exp, edits, others: blocks.filter(b => !edits.some(e => e.key === b.key)).map(b => b.bbox), hasBoxes: gt.cells.some(c => c.box) && !gt.noVerticalBorders, otherCells: gt.cells.filter(c => c.box && !edits.some(e => e.cell === c || (e.cell.box && c.box && e.cell.box.join() === c.box.join()))).map(c => c.box) });
  return { ...res, bigger: bigger.length, grew: bigger.filter(e => e.grew).length };
}

const edBad = ed => ed && (ed.error || ed.ruleDamaged > 12 || ed.outside > 8 || ed.missing.length);
const edStr = ed => !ed ? '' : ed.error ? `EDIT-ERROR ${ed.error}` : `rules ${ed.ruleDamaged}/${ed.rulePx} damaged${ed.ruleSmp?.length ? ' @' + ed.ruleSmp.join(' ') : ''} · text ${ed.textDamage}px · cells ${ed.cellSpill}px${ed.outsideSamples.length ? ' @' + ed.outsideSamples.join(' ') : ''}${ed.missing.length ? ' · missing ' + ed.missing.join('|') : ''}`;

(async () => {
  const only = process.argv[2];
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.pdf') && (!only || f.includes(only))).sort();
  const rows = [];
  for (const f of files) {
    const { browser, page, logs } = await setup({ credits: 100 });
    await page.goto(ORIGIN + '/web-editor.html');
    await page.waitForTimeout(200);
    await openFile(page, path.join(DIR, f));
    await page.waitForFunction(() => getPageInfo(1)?.blocks, null, { timeout: 30000 });
    const { gt, blocks, res } = await analyse(page, path.join(DIR, f));
    let ed = null, edp = null;
    if (gt.cells.length) {
      try { ed = await editAndCheck(page, path.join(DIR, f), gt, blocks); } catch (e) { ed = { error: e.message.slice(0, 120) }; }
      // same cells again, from the original, with size / font / colour / background changes
      await page.evaluate(() => { textEdits.clear(); draftEdit = null; composite(); });
      try { edp = await editAndCheck(page, path.join(DIR, f), gt, blocks, true); } catch (e) { edp = { error: e.message.slice(0, 120) }; }
    }
    const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
    rows.push({ f, res, ed, edp, errs });
    const bad = res.merged.length || res.split.length || errs.length || edBad(ed) || edBad(edp);
    console.log(`${bad ? '  ✘' : '  ✔'} ${f.padEnd(30)} blocks ${String(res.ok).padStart(3)}/${String(res.total).padEnd(3)} merged ${String(res.merged.length).padStart(3)} split ${String(res.split.length).padStart(3)} | ${edStr(ed)}${edp ? ' | props: ' + edStr(edp) : ''}${errs.length ? ' | ERRORS ' + errs.length : ''}`);
    if (process.env.V) { res.merged.slice(0, 3).forEach(m => console.log('     merged', m)); res.split.slice(0, 3).forEach(m => console.log('     split', m)); errs.slice(0, 2).forEach(m => console.log('     ', m.slice(0, 160))); }
    await browser.close();
  }
  const hit = (r, k) => (r.ed?.[k] ?? 0) + (r.edp?.[k] ?? 0);
  const tot = rows.reduce((a, r) => ({ ok: a.ok + r.res.ok, total: a.total + r.res.total, merged: a.merged + r.res.merged.length, split: a.split + r.res.split.length,
    dmg: a.dmg + (r.ed?.ruleDamaged > 12 || r.edp?.ruleDamaged > 12 ? 1 : 0), out: a.out + (r.ed?.outside > 8 || r.edp?.outside > 8 ? 1 : 0),
    bigger: a.bigger + hit(r, 'bigger'), grew: a.grew + hit(r, 'grew') }), { ok: 0, total: 0, merged: 0, split: 0, dmg: 0, out: 0, bigger: 0, grew: 0 });
  const failed = rows.filter(r => r.res.merged.length || r.res.split.length || r.errs.length || edBad(r.ed) || edBad(r.edp));
  if (failed.length) { process.exitCode = 1; console.log('\n  ✘ ' + failed.length + ' file(s) failed: ' + failed.map(r => r.f).join(', ')); }
  else console.log('\n  ✔ all ' + rows.length + ' files: structure detected and preserved by edits (text, then size / font / colours / background)');
  // a bigger font is really applied wherever the cell leaves room (not always shrunk back)
  if (!only) {
    const grown = tot.grew >= tot.bigger * 0.25;
    if (!grown) process.exitCode = 1;
    console.log(`  ${grown ? '✔' : '✘'} bigger font requested ${tot.bigger}×, drawn bigger ${tot.grew}× (the rest shrunk to fit its cell)`);
  }
  console.log(`TOTAL cells exact ${tot.ok}/${tot.total} (${(100 * tot.ok / tot.total).toFixed(1)}%) · merged ${tot.merged} · split ${tot.split} · files with damaged rules ${tot.dmg} · files with changes outside edited cells ${tot.out}`);
})();
