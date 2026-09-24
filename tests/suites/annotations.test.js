const { start, waitIdle, exportPdf, sampleExport, colorDist, check } = require('../lib/helpers');
async function pu2client(page, x, y) {
  return page.evaluate(([x, y]) => { const r = pdfCanvas.getBoundingClientRect(); return [r.left + x * viewScale(), r.top + y * viewScale()]; }, [x, y]);
}
async function drag(page, a, b, steps = 8) {
  const A = await pu2client(page, ...a), B = await pu2client(page, ...b);
  await page.mouse.move(...A); await page.mouse.down(); await page.mouse.move(...B, { steps }); await page.mouse.up();
  await page.waitForTimeout(150);
}
(async () => {
  const { browser, page, logs, state } = await start('01_simple.pdf', { query: '?mode=annotate' });
  await waitIdle(page);
  await page.evaluate(() => { zoom = 0.7; updateZoom(); }); await waitIdle(page, 300);
  // dark band is y=182..242 (pu), gray box y=312..362 x=60..360
  await drag(page, [300, 190], [500, 230]);                          // highlight on dark band
  await drag(page, [380, 100], [520, 130]);                          // highlight on white
  const hl = await page.evaluate(() => annotations.map(a => a.blend));
  console.log('  highlight blends:', hl);
  check(hl[0] === 'screen' && hl[1] === 'multiply', 'highlight adapts: screen on dark, multiply on light');
  await page.click('.tool-btn[data-tool="cover"]');
  await drag(page, [65, 320], [250, 355]);                            // cover "Red mono on gray"
  const cov = await page.evaluate(() => annotations[2]?.color);
  check(cov && colorDist(cov, '#eeeeee') < 12, `cover uses page background (${cov})`);
  // text note on dark band with red picked color → adapted to white
  await page.click('.tool-btn[data-tool="text"]');
  const P = await pu2client(page, 80, 250); await page.mouse.click(...P);
  await page.keyboard.type('Note 1');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const P2 = await pu2client(page, 360, 190); await page.mouse.click(...P2);
  await page.keyboard.type('On dark');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const notes = await page.evaluate(() => annotations.filter(a => a.type === 'text').map(a => a.text + ':' + a.color));
  console.log('  notes:', notes);
  check(notes.length === 2 && /On dark:#ffffff/.test(notes[1]), 'text note color adapted to dark background');
  // erase the first highlight, undo last
  await page.click('.tool-btn[data-tool="erase"]');
  const E = await pu2client(page, 450, 115); await page.mouse.click(...E);
  await page.keyboard.press('Control+z');
  const remaining = await page.evaluate(() => annotations.map(a => a.type));
  console.log('  remaining:', remaining);
  check(JSON.stringify(remaining) === JSON.stringify(['highlight', 'cover', 'text']), 'erase + undo work');
  check(state.consumeCalls === 0, 'annotations stay free (no credit consumed)');
  const out = await exportPdf(page, 'annot.pdf');
  const s = await sampleExport(page, out, 1, [[150, 340], [480, 238], [310, 195]], undefined, [[{ x: 80, y: 250, w: 40, h: 12 }, '#d62828', 90]]);
  console.log('  export colors:', s.colors, 'note ink', s.stats[0].toFixed(3), '| text:', s.text.slice(-80));
  check(colorDist(s.colors[0], '#eeeeee') < 12, 'export: cover hides content with gray');
  check(colorDist(s.colors[2], '#1f3a5f') > 30, 'export: screen highlight visible on dark band (' + s.colors[2] + ')');
  check(s.text.includes('Note 1') && !s.text.includes('On dark') && s.stats[0] > 0.02, 'export: text notes (red ink found)');
  check(logs.filter(l => /pageerror|\[error\]/.test(l)).length === 0, 'no page errors');
  await browser.close();
})();
