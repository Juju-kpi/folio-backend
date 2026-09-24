const { start, waitIdle, exportPdf, sampleExport, colorDist, check } = require('../lib/helpers');
async function pu2client(page, x, y) {
  return page.evaluate(([x, y]) => { const r = pdfCanvas.getBoundingClientRect(); return [r.left + x * viewScale(), r.top + y * viewScale()]; }, [x, y]);
}
async function drag(page, a, b, steps = 8) {
  const A = await pu2client(page, ...a), B = await pu2client(page, ...b);
  await page.mouse.move(...A); await page.mouse.down(); await page.mouse.move(...B, { steps }); await page.mouse.up();
  await page.waitForTimeout(150);
}
async function previewGrid(page, pts) {
  return page.evaluate(pts => { const c = pdfCanvas, k = basePr * viewScale(), ctx = c.getContext('2d');
    return pts.map(([x, y]) => { const d = ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data; return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); }); }, pts);
}
async function runPage(file, pageNum, outName) {
  console.log(`── ${file} p${pageNum}`);
  const { browser, page, logs } = await start(file);
  await waitIdle(page);
  if (pageNum > 1) { await page.click('#nextPage'); await waitIdle(page, 300); }
  await page.evaluate(() => { zoom = 0.6; updateZoom(); }); await waitIdle(page, 300);
  const size = await page.evaluate(() => ({ w: pdfPageWrap.offsetWidth / viewScale(), h: pdfPageWrap.offsetHeight / viewScale() }));
  console.log('  page size (pu):', size.w.toFixed(1), 'x', size.h.toFixed(1));
  // 1. edit first block
  const blk = await page.evaluate(() => { const b = getPageInfo(currentPage).blocks[0]; return { key: b.key, bbox: b.bbox, text: b.text }; });
  await page.click(`.text-overlay[data-key="${blk.key}"]`);
  await page.fill('#propText', 'ROTATED EDIT OK');
  await page.click('#applyProps'); await waitIdle(page, 300);
  // 2. annotations: highlight + cover + pen + box
  await page.click('.mode-tab[data-mode="annotate"]'); await waitIdle(page, 200);
  await drag(page, [40, size.h * 0.55], [size.w * 0.5, size.h * 0.6]);                  // highlight
  await page.click('.tool-btn[data-tool="rect"]');
  await drag(page, [size.w * 0.6, size.h * 0.7], [size.w * 0.9, size.h * 0.8]);
  await page.click('.tool-btn[data-tool="pen"]');
  await drag(page, [size.w * 0.1, size.h * 0.85], [size.w * 0.5, size.h * 0.9], 20);
  const nAnn = await page.evaluate(() => annotations.length);
  check(nAnn === 3, `3 annotations created (${nAnn})`);
  // 3. signature
  await page.click('.mode-tab[data-mode="sign"]'); await waitIdle(page, 200);
  const sc = await page.locator('#sigCanvas').boundingBox();
  await page.mouse.move(sc.x + 20, sc.y + 60); await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(sc.x + 20 + i * 10, sc.y + 50 + (i % 2 ? -25 : 25));
  await page.mouse.up();
  await page.click('#sigApply'); await waitIdle(page, 300);
  const sig = await page.evaluate(() => { const s = signatures[0]; return s && { x: s.x, y: s.y, w: s.w, h: s.h }; });
  check(!!sig, 'signature placed');
  // zoom to be sure nothing moves, then export
  await page.click('#zoomIn'); await waitIdle(page, 300);
  const pts = [];
  for (let gx = 0.05; gx < 1; gx += 0.1) for (let gy = 0.03; gy < 1; gy += 0.047) pts.push([size.w * gx, size.h * gy]);
  const prev = await previewGrid(page, pts);
  const out = await exportPdf(page, outName);
  const exp = await sampleExport(page, out, pageNum, pts, undefined, [[sig, '#003380', 90]]);
  let same = 0; const diffs = [];
  prev.forEach((c, i) => { if (colorDist(c, exp.colors[i]) < 60) same++; else diffs.push(`${pts[i].map(v => v.toFixed(0))}:${c}/${exp.colors[i]}`); });
  console.log(`  export size ${exp.size.map(v => v.toFixed(1)).join('x')} · preview/export agreement ${same}/${pts.length}`, diffs.slice(0, 6).join(' '));
  check(Math.abs(exp.size[0] - size.w) < 1 && Math.abs(exp.size[1] - size.h) < 1, 'export page size = displayed page size');
  check(same / pts.length > 0.97, 'preview matches export (text edit + annotations positions)');
  check(exp.stats[0] > 0.01, `signature ink found at its position in export (${exp.stats[0].toFixed(3)})`);
  check(exp.text.includes('ROTATED EDIT OK'), 'edited text in export');
  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check(errs.length === 0, 'no page errors ' + errs.join(' ; ').slice(0, 300));
  await browser.close();
}
(async () => {
  await runPage('10_rotated_cropbox.pdf', 1, 'rot90.pdf');
  await runPage('10_rotated_cropbox.pdf', 2, 'cropbox.pdf');
  await runPage('01_simple.pdf', 1, 'plain_geom.pdf');
})();
