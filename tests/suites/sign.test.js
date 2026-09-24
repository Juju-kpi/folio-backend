const { start, waitIdle, exportPdf, sampleExport, colorDist, check } = require('../lib/helpers');
(async () => {
  const { browser, page, logs, state } = await start('01_simple.pdf', { query: '?mode=sign' });
  await waitIdle(page);
  check(await page.evaluate(() => currentMode) === 'sign', '?mode=sign opens the signature tool');
  // empty drawing → refused
  await page.click('#sigApply'); await page.waitForTimeout(200);
  check((await page.textContent('#toast')).includes('Draw your signature'), 'empty signature refused');
  // image signature (WebP → PNG)
  await page.click('.sig-tab[data-sig="image"]');
  await page.setInputFiles('#sigImgInput', require('path').join(__dirname, '..', 'fixtures', 'signature.webp'));
  await page.waitForTimeout(500);
  const s1 = await page.evaluate(() => signatures.map(s => ({ png: s.dataURL.startsWith('data:image/png'), ratio: +(s.w / s.h).toFixed(2) })));
  check(s1.length === 1 && s1[0].png && Math.abs(s1[0].ratio - 400 / 150) < 0.05, 'WebP image converted to PNG, aspect ratio kept ' + JSON.stringify(s1));
  // typed signature
  await page.click('.sig-tab[data-sig="text"]');
  await page.fill('#sigTextInput', 'Jean Dupont');
  await page.click('#sigTextApply'); await page.waitForTimeout(300);
  check(await page.evaluate(() => signatures.length) === 2, 'typed signature placed');
  // move the first signature, delete the second with the keyboard
  const box = await page.locator('.sig-overlay').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 300, { steps: 8 }); await page.mouse.up();
  const moved = await page.evaluate(() => signatures[0].y);
  check(moved > 150, 'signature dragged (stored in page units: y=' + moved.toFixed(1) + ')');
  await page.locator('.sig-overlay').nth(1).click();
  await page.keyboard.press('Delete');
  check(await page.evaluate(() => signatures.length) === 1, 'Delete key removes the selected signature');
  // eyedropper: pick the dark band color into the edit text color
  await page.click('.mode-tab[data-mode="edit"]'); await waitIdle(page, 300);
  const key = await page.evaluate(() => getPageInfo(1).blocks[0].key);
  await page.click(`.text-overlay[data-key="${key}"]`);
  await page.click('.pick-btn[data-pick="propColor"]');
  const c = await page.evaluate(() => { const r = pdfCanvas.getBoundingClientRect(); return [r.left + 560 * viewScale(), r.top + 190 * viewScale()]; });
  await page.mouse.click(...c); await page.waitForTimeout(200);
  const picked = await page.inputValue('#propColor');
  check(colorDist(picked, '#1f3a5f') < 10, 'eyedropper picks the page color: ' + picked);
  const out = await exportPdf(page, 'sign.pdf');
  const s = await sampleExport(page, out, 1, []);
  check(s.pages === 2, 'export ok');
  check(state.consumeCalls === 1, 'sign session consumed once (' + state.consumeCalls + ')');
  check(logs.filter(l => /pageerror|\[error\]/.test(l)).length === 0, 'no page errors');
  await browser.close();
})();
