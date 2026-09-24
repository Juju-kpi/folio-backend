// Every PDF of the corpus must open (damaged, protected, huge, rotated…)
const fs = require('fs');
const path = require('path');
const { start, check, PDFS, bigPdf, pageErrors } = require('../lib/helpers');

(async () => {
  const files = [...fs.readdirSync(PDFS).filter(f => /\.pdf$/i.test(f)).sort().map(f => path.join(PDFS, f)), await bigPdf()];
  for (const file of files) {
    const name = path.basename(file);
    const ctx = await start(file, { password: name.includes("user_pw") ? "test" : undefined });
    const { browser, page, logs } = ctx;
    page.toast = ctx.toast;
    const info = await page.evaluate(() => {
      const c = document.getElementById('pdfCanvas');
      let ink = 0;
      if (c && c.width) {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4 * 97) if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) ink++;
      }
      return { shown: !document.getElementById('pdfPageWrap').classList.contains('hidden'), ink, pages: typeof totalPages === 'number' ? totalPages : 0, mode: typeof exportMode === 'string' ? exportMode : '?' };
    });
    const errs = pageErrors(logs).filter(l => !/Warning/.test(l));
    check(info.shown && info.pages > 0 && info.ink > 0 && /^✓/.test(page.toast || '') && errs.length === 0,
      `${name.padEnd(26)} ${info.pages} page(s), export ${info.mode} — ${page.toast || ''}${errs.length ? ' | ' + errs[0].slice(0, 120) : ''}`);
    await browser.close();
  }
})();
