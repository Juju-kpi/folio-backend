const { start, waitIdle, exportPdf, sampleExport, colorDist, check, PDFS: CORPUS, OUT, bigPdf } = require('../lib/helpers');
const path = require('path'), fs = require('fs');
async function editFirst(page, text) {
  await page.click('.mode-tab[data-mode="edit"]'); await waitIdle(page, 200);
  const key = await page.evaluate(() => getPageInfo(currentPage).blocks[0].key);
  await page.click(`.text-overlay[data-key="${key}"]`);
  await page.fill('#propText', text);
  await page.click('#applyProps'); await waitIdle(page, 300);
}
async function downloadFrom(page, click, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(click)]);
  const p = path.join(OUT, name || dl.suggestedFilename());
  await dl.saveAs(p); await waitIdle(page);
  return { p, name: dl.suggestedFilename() };
}
(async () => {
  // ── Encrypted (owner password) → export is decrypted and edited
  for (const [f, pw] of [['03_enc_owner_aes256.pdf'], ['06_enc_user_pw.pdf', 'test']]) {
    console.log('── ' + f);
    const { browser, page, logs } = await start(f, { password: pw });
    await waitIdle(page);
    await editFirst(page, 'Decrypted and edited');
    const out = await exportPdf(page, 'enc_' + f);
    const s = await sampleExport(page, out, 1, []);   // no password given
    check(s.text.includes('Decrypted and edited'), 'export opens without password and contains the edit');
    check(logs.filter(l => /pageerror|\[error\]/.test(l)).length === 0, 'no page errors');
    await browser.close();
  }
  // ── Raster fallback (pdf-lib unusable) → export still works
  {
    console.log('── raster fallback');
    const { browser, page, logs } = await start('01_simple.pdf');
    await waitIdle(page);
    await page.evaluate(() => { exportMode = 'raster'; pdfLibDoc = null; });
    await editFirst(page, 'Raster mode edit');
    const out = await exportPdf(page, 'raster.pdf');
    const s = await sampleExport(page, out, 1, [[100, 200]]);
    check(s.pages === 2 && Math.abs(s.size[0] - 595.3) < 1, `raster export has all pages at the right size (${s.pages}, ${s.size})`);
    check(s.text.includes('Raster mode edit'), 'edit drawn as real text over the rebuilt page');
    check(colorDist(s.colors[0], '#1f3a5f') < 30, 'page content preserved in raster export');
    // extract without pdf-lib → raster pages
    await page.click('.mode-tab[data-mode="extract"]'); await waitIdle(page, 800);
    await page.click('.thumb-item[data-page="2"]');
    const ex = await downloadFrom(page, '#btnExtractDo', 'extract_raster.pdf');
    const se = await sampleExport(page, ex.p, 1, []);
    check(se.pages === 1, 'extract works without pdf-lib (' + ex.name + ')');
    check(logs.filter(l => /pageerror|\[error\]/.test(l)).length === 0, 'no page errors');
    await browser.close();
  }
  // ── Extract / merge / convert
  {
    console.log('── extract / merge / convert');
    const { browser, page, logs, state } = await start('01_simple.pdf');
    await waitIdle(page);
    await editFirst(page, 'Edited before extract');
    await page.click('.mode-tab[data-mode="extract"]'); await waitIdle(page, 800);
    await page.click('.thumb-item[data-page="1"]');
    const ex = await downloadFrom(page, '#btnExtractDo');
    const se = await sampleExport(page, ex.p, 1, []);
    check(se.pages === 1 && se.text.includes('Edited before extract'), `extract includes edits (${ex.name})`);
    await page.click('.mode-tab[data-mode="merge"]'); await waitIdle(page, 800);
    page.on('dialog', d => d.dismiss());
    await page.setInputFiles('#mergeInput', [path.join(CORPUS, '06_enc_user_pw.pdf'), path.join(CORPUS, '09_truncated.pdf'), path.join(CORPUS, '15_UPPER.PDF')]);
    const names = await page.$$eval('#mergeList .merge-item-name', els => els.map(e => e.textContent));
    console.log('  merge list:', names);
    const mergeP = downloadFrom(page, '#btnMergeDo', 'merged.pdf');
    // password prompt for the protected file
    await page.waitForSelector('#folioPwInput', { timeout: 20000 });
    await page.fill('#folioPwInput', 'test'); await page.click('#folioPwOk');
    const mg = await mergeP;
    const sm = await sampleExport(page, mg.p, 1, []);
    check(sm.pages === 8, `merged 2 + 2 (protected) + 2 (damaged) + 2 = ${sm.pages} pages`);
    check(sm.text.includes('Edited before extract'), 'merge includes current edits');
    await page.click('.mode-tab[data-mode="convert"]'); await waitIdle(page, 300);
    for (const fmt of ['txt', 'csv', 'html', 'docx', 'png', 'jpg']) {
      await page.click(`.fmt-card[data-fmt="${fmt}"]`);
      await page.selectOption('#convertPages', 'current');
      const c = await downloadFrom(page, '#btnConvertDo', 'conv.' + fmt);
      const size = fs.statSync(c.p).size;
      const head = fs.readFileSync(c.p).subarray(0, 4).toString('hex');
      check(size > 100, `convert ${fmt}: ${c.name} (${size} bytes, ${head})`);
      if (fmt === 'txt') check(fs.readFileSync(c.p, 'utf8').includes('Edited before extract'), 'txt contains the edit');
    }
    check(state.consumeCalls === 1, `whole session consumed 1 credit (${state.consumeCalls})`);
    const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
    check(errs.length === 0, 'no page errors ' + errs.join(';').slice(0, 300));
    await browser.close();
  }
  // ── Reload restore (small → sessionStorage, big → IndexedDB)
  for (const f of ['01_simple.pdf', await bigPdf()]) {
    const { browser, page } = await start(f);
    await waitIdle(page);
    const store = await page.evaluate(() => ({ ss: !!sessionStorage.getItem('folioPDFData'), idb: sessionStorage.getItem('folioPDFStore') }));
    await page.reload();
    await page.waitForFunction(() => typeof pdfDoc !== 'undefined' && pdfDoc && totalPages > 0, null, { timeout: 30000 }).catch(() => {});
    const n = await page.evaluate(() => totalPages);
    check(n > 0, `${path.basename(f)}: restored after reload (${n} pages, store=${store.ss ? 'sessionStorage' : store.idb})`);
    await browser.close();
  }
})();
