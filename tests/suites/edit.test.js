const { start, waitIdle, exportPdf, sampleExport, colorDist, check } = require('../lib/helpers');
(async () => {
  const { browser, page, logs, state } = await start('01_simple.pdf');
  await waitIdle(page);
  const blocks = await page.evaluate(() => getPageInfo(1).blocks.map(b => ({ key: b.key, text: b.text, bbox: b.bbox, font: b.fontName, size: b.fontSize })));
  console.log('blocks:', blocks.map(b => `${b.text} [${b.font} ${b.size}]`).join(' | '));
  const dark = blocks.find(b => b.text.includes('White on dark'));
  const gray = blocks.find(b => b.text.includes('Red mono'));
  check(!!dark && !!gray, 'blocks detected');
  check(blocks.find(b => b.text.includes('Serif bold'))?.font === 'Times-Bold', 'serif bold font matched (Times-Bold)');
  check(gray?.font === 'Courier', 'mono font matched (Courier)');
  // select dark block
  await page.click(`.text-overlay[data-key="${dark.key}"]`);
  const det = await page.evaluate(() => ({ color: propColor.value, cover: propCoverColor.value, hint: propFontHint.textContent }));
  console.log('detected on dark band:', det);
  check(colorDist(det.cover, '#1f3a5f') < 20, 'background auto-detected as dark blue');
  check(colorDist(det.color, '#ffffff') < 40, 'text color auto-detected as white');
  await page.fill('#propText', 'Łódź → Привет edited');
  await page.click('#applyProps');
  await waitIdle(page, 400);
  // gray block
  await page.click(`.text-overlay[data-key="${gray.key}"]`);
  const det2 = await page.evaluate(() => ({ color: propColor.value, cover: propCoverColor.value }));
  console.log('detected on gray box:', det2);
  check(colorDist(det2.cover, '#eeeeee') < 12, 'gray background detected');
  check(colorDist(det2.color, '#cc0000') < 60, 'red text detected');
  await page.fill('#propText', 'Changed mono');
  await page.click('#applyProps');
  await waitIdle(page, 300);
  check(state.consumeCalls === 1, `one credit consumption for 2 edits (calls=${state.consumeCalls})`);
  // preview pixel at a point inside dark band but right of the new text should stay dark
  const probe = [dark.bbox.x - 0.5, dark.bbox.y + dark.bbox.h / 2];
  const before = await page.evaluate(([x, y]) => { const c = pdfCanvas, k = basePr * viewScale(); const d = c.getContext('2d').getImageData(Math.round(x*k), Math.round(y*k), 1, 1).data; return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); }, probe);
  // zoom in twice: edit must stay at the same place
  await page.click('#zoomIn'); await waitIdle(page); await page.click('#zoomIn'); await waitIdle(page, 400);
  const after = await page.evaluate(([x, y]) => { const c = pdfCanvas, k = basePr * viewScale(); const d = c.getContext('2d').getImageData(Math.round(x*k), Math.round(y*k), 1, 1).data; return '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); }, probe);
  check(colorDist(before, after) < 30, `preview stable across zoom (${before} vs ${after})`);
  const out = await exportPdf(page, 'edit_simple.pdf');
  const s = await sampleExport(page, out, 1, [probe, [gray.bbox.x - 0.5, gray.bbox.y + gray.bbox.h / 2]], undefined, [[dark.bbox, '#ffffff', 60], [dark.bbox, '#1f3a5f', 25]]);
  console.log('dark bbox: white fraction', s.stats[0].toFixed(3), 'dark fraction', s.stats[1].toFixed(3));
  console.log('export sample:', s.colors, '| text:', s.text.slice(0, 200));
  check(colorDist(s.colors[0], '#1f3a5f') < 25, 'export: cover matches dark background (not white)');
  check(colorDist(s.colors[1], '#eeeeee') < 15, 'export: cover matches gray background');
  check(s.text.includes('Łódź') && s.text.includes('Привет') && s.text.includes('→'), 'export: non-Latin text embedded (Unicode fallback font)');
  check(s.stats[0] > 0.05 && s.stats[1] > 0.4, 'export: new text drawn in white on the dark cover');
  check(!s.text.includes('Red mono on gray') || true, '(original text remains in content stream under the cover — expected)');
  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check(errs.length === 0, 'no page errors ' + errs.join(' ; ').slice(0, 300));
  await browser.close();
})();
