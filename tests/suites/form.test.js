const { start, waitIdle, exportPdf, sampleExport, colorDist, check } = require('../lib/helpers');
const { readFields } = require('../lib/fields');
async function fieldByName(page, name, extra = '') {
  return page.evaluate(([n, extra]) => (getPageInfo(currentPage).fields || []).filter(f => f.name === n && (!extra || String(f.exportValue) === extra)).map(f => ({ key: f.key, kind: f.kind, rect: f.rect, options: f.options, exportValue: f.exportValue }))[0], [name, extra]);
}
async function run(file, outName) {
  console.log('── ' + file);
  const { browser, page, logs, state } = await start(file);
  await waitIdle(page);
  await page.click('.mode-tab[data-mode="form"]');
  await waitIdle(page, 500);
  const fields = await page.evaluate(() => (getPageInfo(1).fields || []).map(f => `${f.kind}:${f.name}${f.exportValue ? '=' + f.exportValue : ''}`));
  console.log('  fields:', fields.join(', '));
  check(fields.length >= 6, 'AcroForm fields detected (text, checkbox, radio x2, choice, multiline)');
  // text field
  const fn = await fieldByName(page, 'first_name');
  await page.click(`.form-field-overlay[data-key="${fn.key}"]`);
  await page.fill('#formPropText', 'Zoë Łukasz');
  await page.press('#formPropText', 'Enter');
  await waitIdle(page, 300);
  // multiline comments
  const cm = await fieldByName(page, 'comments');
  await page.click(`.form-field-overlay[data-key="${cm.key}"]`);
  await page.fill('#formPropText', 'Line one of a fairly long comment that must wrap inside the box\nSecond line');
  await page.click('#formApplyProps');
  await waitIdle(page, 300);
  // checkbox → click toggles
  const cb = await fieldByName(page, 'agree');
  await page.click(`.form-field-overlay[data-key="${cb.key}"]`);
  await waitIdle(page, 300);
  // radio blue
  const rb = await fieldByName(page, 'color', 'blue');
  await page.click(`.form-field-overlay[data-key="${rb.key}"]`);
  await waitIdle(page, 300);
  // choice
  const ch = await fieldByName(page, 'country');
  await page.click(`.form-field-overlay[data-key="${ch.key}"]`);
  await page.selectOption('#formPropChoice', 'Canada');
  await waitIdle(page, 300);
  const vals = await page.evaluate(() => (getPageInfo(1).fields || []).map(f => `${f.name}${f.exportValue ? '(' + f.exportValue + ')' : ''}=${JSON.stringify(f.value)}${f.dirty ? '*' : ''}`));
  console.log('  values:', vals.join(' | '));
  // free text in click mode on a dark... (page is white) — add free field
  await page.click('#btnFormClickToggle');
  const box = await page.locator('#pdfCanvas').boundingBox();
  await page.mouse.click(box.x + 380 * 1.5 * await page.evaluate(() => zoom), box.y + 150 * 1.5 * await page.evaluate(() => zoom));
  await page.waitForTimeout(200);
  await page.fill('#formPropText', 'Free text ✓ here');
  await page.press('#formPropText', 'Enter');
  await waitIdle(page, 300);
  check(state.consumeCalls === 1, `single consumption for the whole session (calls=${state.consumeCalls})`);
  // zoom then check the free field didn't move (in pu)
  const before = await page.evaluate(() => JSON.stringify(allFields().filter(f => f.source === 'free').map(f => f.rect)));
  await page.click('#zoomOut'); await waitIdle(page, 300);
  const after = await page.evaluate(() => JSON.stringify(allFields().filter(f => f.source === 'free').map(f => f.rect)));
  check(before === after, 'free field position independent of zoom');
  const out = await exportPdf(page, outName);
  const F = await readFields(out);
  const py = JSON.stringify(F);
  const smp = await sampleExport(page, out, 1, [], undefined, [[fn.rect, '#000000', 200]]);
  const txt = smp.text;
  console.log('    ink fraction in first_name rect:', smp.stats[0].toFixed(3));
  console.log('    fields:', py.trim(), '\n    text:', txt.slice(0, 250));
  check(F.first_name === 'Zoë Łukasz', 'text field value set natively');
  check(F.agree === true, 'checkbox checked natively');
  check(F.color === 'blue', 'radio set to blue natively');
  check(JSON.stringify(F.country) === '["Canada"]', 'dropdown set natively');
  check(/Second line/.test(F.comments || ''), 'multiline value kept');
  check(smp.stats[0] > 0.02, 'text field appearance rendered (ink inside the widget)');
  check(/Free text/.test(txt) && /here/.test(txt), 'free text drawn on page (✓ drawn with ZapfDingbats)');
  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check(errs.length === 0, 'no page errors ' + errs.join(' ; ').slice(0, 300));
  await browser.close();
  return out;
}
(async () => {
  await run('12_form.pdf', 'form.pdf');
  await run('13_form_no_DA.pdf', 'form_no_da.pdf');
})();
