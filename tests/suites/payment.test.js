const { start, waitIdle, check, PDFS: CORPUS, openFile } = require('../lib/helpers');
const path = require('path');
async function applyEdit(page) {
  const key = await page.evaluate(() => getPageInfo(currentPage).blocks[0].key);
  await page.click(`.text-overlay[data-key="${key}"]`);
  await page.fill('#propText', 'x' + Date.now());
  await page.click('#applyProps');
  await page.waitForTimeout(400);
}
(async () => {
  // ── UID
  {
    const { browser, page, context } = await start(null);
    const uid = await page.evaluate(() => WebPayment.getUID());
    check(/^u_[0-9a-z]{6,12}_[0-9a-z]{12}$/.test(uid), 'new UID matches backend format with 12 random chars: ' + uid);
    const stored = await page.evaluate(() => ({ ls: localStorage.getItem('folioUID'), ck: document.cookie }));
    check(stored.ls === uid && stored.ck.includes(uid), 'UID persisted in localStorage and cookie');
    // localStorage wiped → cookie restores the same UID
    await page.evaluate(() => localStorage.clear());
    await page.reload(); await page.waitForTimeout(300);
    check(await page.evaluate(() => WebPayment.getUID()) === uid, 'UID survives localStorage clearing (cookie backup)');
    // legacy UID (Math.random era) kept as-is
    await page.evaluate(() => { localStorage.setItem('folioUID', 'u_lzxw4khs_3f9ab2c1'); });
    await page.reload(); await page.waitForTimeout(300);
    check(await page.evaluate(() => WebPayment.getUID()) === 'u_lzxw4khs_3f9ab2c1', 'existing legacy UID preserved');
    // corrupted value → falls back to cookie copy
    await page.evaluate(() => { localStorage.setItem('folioUID', 'garbage<script>'); });
    await page.reload(); await page.waitForTimeout(300);
    check(await page.evaluate(() => WebPayment.getUID()) === 'u_lzxw4khs_3f9ab2c1', 'corrupted localStorage value repaired from cookie');
    await browser.close();
  }
  // ── Sessions: 1 credit per document, reused on reopen
  {
    const { browser, page, state } = await start('01_simple.pdf', { credits: 5 });
    page.on('dialog', d => d.accept());
    await waitIdle(page);
    for (let i = 0; i < 4; i++) await applyEdit(page);
    check(state.consumeCalls === 1, `4 edits on the same document → 1 consumption (${state.consumeCalls})`);
    await openFile(page, path.join(CORPUS, '12_form.pdf')); await waitIdle(page);
    await page.click('.mode-tab[data-mode="edit"]'); await waitIdle(page, 300);
    await applyEdit(page);
    check(state.consumeCalls === 2, `new document → new session (${state.consumeCalls})`);
    await openFile(page, path.join(CORPUS, '01_simple.pdf')); await waitIdle(page);
    await applyEdit(page);
    check(state.consumeCalls === 2, `reopening the first document within 12 h → no new consumption (${state.consumeCalls})`);
    // double click → single consumption
    await openFile(page, path.join(CORPUS, '11_objstreams.pdf')); await waitIdle(page);
    const key = await page.evaluate(() => getPageInfo(currentPage).blocks[0].key);
    await page.click(`.text-overlay[data-key="${key}"]`);
    await page.dblclick('#applyProps'); await page.waitForTimeout(600);
    check(state.consumeCalls === 3, `double-click on Apply → one consumption (${state.consumeCalls})`);
    check(state.charges === 3, `3 documents → 3 sessions charged (${state.charges})`);
    // Forging the local session store must not unlock a new document
    await openFile(page, path.join(CORPUS, '07_garbage_prefix.pdf')); await waitIdle(page);
    await page.evaluate(() => {
      const uid = WebPayment.getUID();
      const docs = JSON.parse(localStorage.getItem('folioPaidSessions') || '{}');
      // attacker copies a real token to another document and invents one
      const any = Object.values(docs)[0];
      for (const k of ['fake1', 'fake2']) docs[uid + ':' + k] = { token: any.token, exp: Date.now() + 3600e3 };
      localStorage.setItem('folioPaidSessions', JSON.stringify(docs));
      // and marks the current doc as paid with a stolen token
      const cur = Object.keys(docs).find(k => !k.endsWith('fake1') && !k.endsWith('fake2'));
      window.__forged = docs[cur].token;
    });
    await page.evaluate(async () => {
      const docs = JSON.parse(localStorage.getItem('folioPaidSessions'));
      const key = await sha256Hex(originalBytes);
      docs[WebPayment.getUID() + ':' + key] = { token: window.__forged, exp: Date.now() + 3600e3 };
      localStorage.setItem('folioPaidSessions', JSON.stringify(docs));
    });
    await applyEdit(page);
    check(state.charges === 4, `forged local session rejected by the server → charged normally (${state.charges})`);
    const pill = await page.textContent('#creditsCount');
    check(/^3 credits$/.test(pill.trim()), '2 free + 2 paid sessions used, pill shows the balance: ' + pill);
    await browser.close();
  }
  // ── No credits → modal → checkout popup → credits detected
  {
    const { browser, page, context, state } = await start('01_simple.pdf', { free_used: 5, credits: 0 });
    await waitIdle(page);
    await applyEdit(page);
    check(await page.$('#folio-payment-modal') !== null, 'payment modal shown when no credits');
    const title = await page.textContent('#folio-payment-modal h2');
    const uidShown = await page.textContent('#folio-payment-modal code');
    check(title.includes('credit needed') && uidShown === await page.evaluate(() => WebPayment.getUID()), 'modal shows Folio ID');
    const popupP = context.waitForEvent('page');
    const navs = [];
    context.on('request', r => navs.push(r.url()));
    await page.click('.fpay-pack[data-pack="5"]');
    const popup = await popupP;
    await popup.waitForTimeout(800);
    const navigated = navs.some(u => u.startsWith('https://checkout.stripe.test'));
    check(state.checkoutCalls === 1, 'checkout requested once');
    check(navigated && popup !== page, 'checkout opened in a new tab (not blocked by the popup blocker)');
    // webhook adds credits → editor detects it
    state.credits = 5;
    await page.bringToFront();
    await page.waitForFunction(() => /5 credits/.test(document.getElementById('creditsCount').textContent), null, { timeout: 15000 }).catch(() => {});
    const pill = await page.textContent('#creditsCount');
    check(/5 credits/.test(pill), 'credits detected automatically after payment: ' + pill);
    await page.waitForTimeout(300);
    await applyEdit(page);
    check(state.credits === 4, `paid credit consumed (${state.credits} left)`);
    await browser.close();
  }
  // ── Lifetime
  {
    const { browser, page, state } = await start('01_simple.pdf', { lifetime: true, free_used: 5 });
    await waitIdle(page);
    await page.waitForTimeout(500);
    check((await page.textContent('#creditsCount')).includes('Unlimited'), 'lifetime shown as unlimited');
    await applyEdit(page);
    check(await page.$('#folio-payment-modal') === null, 'lifetime user edits without modal');
    await page.click('#creditsPill');
    const disabled = await page.$$eval('.fpay-pack', b => b.every(x => x.disabled));
    check(disabled, 'packs disabled for lifetime users (no double purchase)');
    await browser.close();
  }
  // ── Restore purchases with a Folio ID
  {
    const { browser, page } = await start(null);
    await page.click('#creditsPill');
    await page.click('text=Already purchased? Restore with your Folio ID');
    await page.fill('#folio-payment-modal input', 'bad id');
    await page.click('#folio-payment-modal button:text-is("Restore")');
    await page.waitForTimeout(300);
    check((await page.textContent('#toast')).includes('Invalid'), 'invalid ID rejected');
    await page.fill('#folio-payment-modal input', 'u_lzxw4khs_aaaaaaaaaaaa');
    await page.click('#folio-payment-modal button:text-is("Restore")');
    await page.waitForTimeout(500);
    check(await page.evaluate(() => WebPayment.getUID()) === 'u_lzxw4khs_aaaaaaaaaaaa' && await page.evaluate(() => localStorage.getItem('folioUID')) === 'u_lzxw4khs_aaaaaaaaaaaa', 'valid ID restored and persisted');
    await browser.close();
  }
  // ── Rate limited → message, no modal
  {
    const { browser, page, state } = await start('01_simple.pdf');
    await waitIdle(page);
    state.rateLimit = true;
    await applyEdit(page);
    check(await page.$('#folio-payment-modal') === null && (await page.textContent('#toast')).includes('Too many'), 'rate limit shows a retry message (not the payment modal)');
    await browser.close();
  }
})();
