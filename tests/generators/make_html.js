const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, '..', 'fixtures', 'tables');
const rnd = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const pick = a => a[Math.floor(rnd() * a.length)];
const FIRST = ['Jean', 'Marie', 'Paul', 'Lucie', 'Hugo', 'Emma', 'Louis', 'Chloé'], LAST = ['Dupont', 'Martin', 'Bernard', 'Petit', 'Durand', 'Leroy'];
const CITY = ['Paris', 'Lyon', 'Nantes', 'Lille', 'Brest', 'Nice'];
function rows(n) {
  const r = [['Réf.', 'Client', 'Ville', 'Qté', 'Montant']];
  for (let i = 0; i < n; i++) r.push([`B${200 + i}`, `${pick(FIRST)} ${pick(LAST)}`, pick(CITY), String(1 + Math.floor(rnd() * 98)), `${(10 + rnd() * 9000).toFixed(2).replace('.', ',')} €`]);
  return r;
}
const tableHtml = (data, { rightCols = [3, 4], th = true } = {}) =>
  '<table>' + data.map((r, i) => '<tr>' + r.map((c, j) => `<${i === 0 && th ? 'th' : 'td'}${rightCols.includes(j) ? ' class="r"' : ''}>${c}</${i === 0 && th ? 'th' : 'td'}>`).join('') + '</tr>').join('') + '</table>';
const base = 'body{margin:40px;font-family:Arial,Helvetica,sans-serif;color:#000} td,th{white-space:nowrap;text-align:left} .r{text-align:right}';
const variants = {
  b01_html_grid: [base + 'table{border-collapse:collapse;font-size:13px} td,th{border:1px solid #000;padding:3px 6px}', tableHtml(rows(18))],
  b02_html_grid_tight: [base + 'table{border-collapse:collapse;font-size:11px} td,th{border:1px solid #444;padding:1px 2px}', tableHtml(rows(28))],
  b03_html_zebra: [base + 'table{border-collapse:collapse;font-size:12px} td,th{padding:4px 8px} tr:nth-child(even){background:#e9eef6} th{background:#2c4a70;color:#fff}', tableHtml(rows(18))],
  b04_html_invoice: [base + 'table{border-collapse:collapse;font-size:12px;width:520px} td,th{padding:5px 6px;border-bottom:1px solid #bbb} th{background:#111;color:#fff}',
    tableHtml(rows(10)).replace('</table>', '<tr><td colspan="4" class="r"><b>Total TTC</b></td><td class="r"><b>12 345,67 €</b></td></tr></table>')],
  b05_html_cell_colors: [base + 'table{border-collapse:collapse;font-size:12px} td,th{padding:2px 3px} td:nth-child(1){background:#dde7f5} td:nth-child(2){background:#f5e3dd} td:nth-child(3){background:#e2f5dd} td:nth-child(4){background:#f5f1dd} td:nth-child(5){background:#e9ddf5}', tableHtml(rows(18), { th: false })],
  b06_html_serif_grid: ['body{margin:40px;font-family:"Times New Roman",Times,serif} td,th{white-space:nowrap;text-align:left} .r{text-align:right} table{border-collapse:collapse;font-size:15px} td,th{border:1.5px solid #000;padding:4px 7px}', tableHtml(rows(12))],
  b07_html_mixed_styles: [base + 'table{border-collapse:collapse;font-size:12px} td,th{border:1px solid #000;padding:3px 5px}',
    '<table>' + rows(12).map((r, i) => '<tr>' + r.map((c, j) => j === 1 && i > 0 ? `<td><b>${c.split(' ')[0]}</b> ${c.split(' ')[1]}</td>` : `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>'],
  b08_html_side_by_side: [base + 'table{border-collapse:collapse;font-size:12px;display:inline-table;margin-right:8px;vertical-align:top} td,th{border:1px solid #000;padding:2px 4px}', tableHtml(rows(10).map(r => r.slice(0, 3))) + tableHtml(rows(10).map(r => r.slice(2)))],
  b09_html_no_borders_tight: [base + 'table{font-size:12px;border-spacing:0} td,th{padding:0 6px}', tableHtml(rows(20))],
};
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  for (const [name, [css, body]] of Object.entries(variants)) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>@page{size:794px 1123px;margin:0} ${css}</style></head><body>${body}</body></html>`);
    const cells = await page.evaluate(() => [...document.querySelectorAll('td,th')].map(td => {
      const r = td.getBoundingClientRect();
      return { text: td.innerText.replace(/\s+/g, ' ').trim(), box: [r.left * 0.75, r.top * 0.75, r.width * 0.75, r.height * 0.75] };
    }));
    await page.pdf({ path: path.join(OUT, name + '.pdf'), width: '794px', height: '1123px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({ pages: [{ cells, rules: [], lines: [] }] }));
    console.log(name, cells.length, 'cells');
  }
  await browser.close();
})();
