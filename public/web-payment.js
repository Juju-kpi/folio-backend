// ── Folio PDF Studio — web-payment.js ────────────────────────────────────────
// Web version of payment.js — no chrome.* APIs.
// Importé par web-editor.html : appeler `await canEdit()` (via WebPayment._editKey)
// avant chaque action payante.
//
// UID
//   - Généré avec crypto.getRandomValues (Math.random n'est pas cryptographique et
//     pouvait produire une partie aléatoire trop courte, refusée par /api/consume).
//   - Format inchangé (compatible extension + backend) : u_<temps base36>_<12 car. base36>
//   - Stocké dans localStorage ET dans un cookie : si l'un est effacé, l'autre le
//     restaure (l'UID porte les crédits achetés). Fonctionne même si le stockage
//     est bloqué (navigation privée) grâce à un repli en mémoire.
//   - Peut être affiché/copié et restauré sur un autre navigateur ("Restore purchases").
//
// Paywall
//   - Une "session d'édition" = un document ouvert : le crédit est consommé une
//     seule fois par document (et non plus à chaque clic sur "Apply"), pendant 12 h.
//   - Appels concurrents dédupliqués (double-clic = une seule consommation).
//   - Checkout Stripe ouvert sans être bloqué par les anti-popups, puis détection
//     automatique des crédits ajoutés.

const WebPayment = (() => {

  const API_BASE    = 'https://folio-backend-ebon.vercel.app';
  const UID_RE      = /^u_[0-9a-z]{6,12}_[0-9a-z]{6,12}$/;
  const UID_KEY     = 'folioUID';
  const SESSIONS_KEY = 'folioPaidSessions';
  const SESSION_TTL = 12 * 60 * 60 * 1000;

  // ── Stockage tolérant aux erreurs ─────────────────────────────────────────
  const memStore = new Map();
  function lsGet(k) {
    try { return window.localStorage.getItem(k); } catch { return memStore.get(k) ?? null; }
  }
  function lsSet(k, v) {
    memStore.set(k, v);
    try { window.localStorage.setItem(k, v); } catch { /* quota / stockage bloqué */ }
  }
  function cookieGet(k) {
    try {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }
  function cookieSet(k, v) {
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=315360000; Path=/; SameSite=Lax${secure}`;
    } catch { /* ignore */ }
  }

  // ── UID unique par navigateur ─────────────────────────────────────────────
  let _uid = null;

  function isValidUID(id) { return typeof id === 'string' && UID_RE.test(id); }

  function randomBase36(len) {
    const out = [];
    const buf = new Uint8Array(len * 2);
    while (out.length < len) {
      if (window.crypto?.getRandomValues) window.crypto.getRandomValues(buf);
      else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
      for (const b of buf) {
        if (b < 252 && out.length < len) out.push((b % 36).toString(36)); // pas de biais modulo
      }
    }
    return out.join('');
  }

  function generateUID() {
    return 'u_' + Date.now().toString(36) + '_' + randomBase36(12);
  }

  function persistUID(id) {
    lsSet(UID_KEY, id);
    cookieSet(UID_KEY, id);
  }

  function getUID() {
    if (_uid) return _uid;
    const fromLs     = lsGet(UID_KEY);
    const fromCookie = cookieGet(UID_KEY);
    let id = isValidUID(fromLs) ? fromLs : isValidUID(fromCookie) ? fromCookie : null;
    if (!id) id = generateUID();
    if (fromLs !== id || fromCookie !== id) persistUID(id);   // auto-réparation
    _uid = id;
    return _uid;
  }

  // Restaure un UID existant (achat fait sur un autre navigateur / données effacées)
  async function restoreUID(id) {
    id = String(id || '').trim().toLowerCase();
    if (!isValidUID(id)) return { ok: false, reason: 'invalid' };
    const previous = getUID();
    _uid = id;
    persistUID(id);
    const status = await getStatus();
    if (!status) {
      _uid = previous; persistUID(previous);
      return { ok: false, reason: 'network' };
    }
    return { ok: true, status };
  }

  // ── Sessions d'édition par document ───────────────────────────────────────
  let _docKey = null;

  function readSessions() {
    let data = {};
    try { data = JSON.parse(lsGet(SESSIONS_KEY) || '{}') || {}; } catch { data = {}; }
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(data)) {
      if (typeof data[k] !== 'number' || data[k] < now) { delete data[k]; changed = true; }
    }
    if (changed) lsSet(SESSIONS_KEY, JSON.stringify(data));
    return data;
  }

  function sessionId(docKey) { return getUID() + ':' + docKey; }

  function setDocument(docKey) { _docKey = docKey ? String(docKey) : null; }

  function hasActiveSession(docKey = _docKey) {
    if (!docKey) return false;
    return !!readSessions()[sessionId(docKey)];
  }

  function recordSession(docKey = _docKey) {
    if (!docKey) return;
    const data = readSessions();
    data[sessionId(docKey)] = Date.now() + SESSION_TTL;
    // Garder la liste courte
    const keys = Object.keys(data);
    if (keys.length > 50) keys.sort((a, b) => data[a] - data[b]).slice(0, keys.length - 50).forEach(k => delete data[k]);
    lsSet(SESSIONS_KEY, JSON.stringify(data));
  }

  // ── Statut ────────────────────────────────────────────────────────────────
  let _lastStatus = null;
  const _listeners = new Set();

  function onStatus(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
  function _emit() {
    for (const cb of _listeners) { try { cb(_lastStatus, hasActiveSession()); } catch (e) { console.error(e); } }
  }

  async function getStatus() {
    const uid = getUID();
    try {
      const r = await fetch(`${API_BASE}/api/status?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _lastStatus = await r.json();
      _emit();
      return _lastStatus;
    } catch (e) {
      console.error('[Folio/web-payment] getStatus error:', e);
      return null;
    }
  }

  function lastStatus() { return _lastStatus; }

  // ── Consommation ──────────────────────────────────────────────────────────
  async function consumeOnce() {
    const r = await fetch(`${API_BASE}/api/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: getUID() }),
    });
    if (r.status === 429) return { ok: false, reason: 'rate_limited' };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function consume() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await consumeOnce();
        if (res?.reason === 'busy' && attempt < 2) { await sleep(300 * (attempt + 1)); continue; }
        return res;
      } catch (e) {
        console.error('[Folio/web-payment] consume error:', e);
        if (attempt < 2) { await sleep(600 * (attempt + 1)); continue; }
        return null;
      }
    }
    return null;
  }

  // ── Point d'entrée principal ──────────────────────────────────────────────
  let _inflight = null;

  async function canEdit() {
    if (hasActiveSession()) return true;
    if (_inflight) return _inflight;           // double-clic : une seule consommation
    _inflight = (async () => {
      try {
        const result = await consume();

        if (result === null) {
          _showToast('❌ Server connection required to edit', 'error');
          return false;
        }

        if (result.ok) {
          recordSession();
          if (result.usedLifetimeFree) {
            // accès illimité : rien à signaler
          } else if (result.usedFree) {
            const left = Number.isFinite(result.freeRemaining) ? result.freeRemaining : null;
            _showToast(left === null ? '✨ Free editing session started'
              : `✨ Free editing session started — ${left} free left`, 'success');
          } else {
            _showToast(`✓ Editing session started — ${result.creditsLeft} credit(s) left`, 'success');
          }
          getStatus();   // rafraîchit l'affichage des crédits
          return true;
        }

        if (result.reason === 'rate_limited' || result.reason === 'busy') {
          _showToast('⏳ Too many requests — please retry in a few seconds', 'error');
          return false;
        }

        _showPaymentModal({ reason: 'no_credits' });
        return false;
      } finally {
        _inflight = null;
      }
    })();
    return _inflight;
  }

  // ── Checkout Stripe ───────────────────────────────────────────────────────
  // `win` : fenêtre ouverte de façon synchrone pendant le clic (sinon le
  // navigateur bloque le popup ouvert après un `await`).
  async function openCheckout(pack = '1', win = null) {
    const uid = getUID();
    try {
      const r = await fetch(`${API_BASE}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pack }),
      });
      if (r.status === 409) {
        if (win && !win.closed) win.close();
        _showToast('✓ You already have unlimited access', 'success');
        getStatus();
        return false;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { url } = await r.json();
      if (!url || !/^https:\/\//i.test(url)) throw new Error('Invalid checkout URL');

      const before = _lastStatus || await getStatus();
      if (win && !win.closed) {
        win.location.href = url;
      } else {
        // (pas de 'noopener' ici : window.open renverrait toujours null)
        const opened = window.open(url, '_blank');
        if (opened) { try { opened.opener = null; } catch { /* ignore */ } }
        // Popup bloqué : même onglet (le PDF est restauré au retour)
        else window.location.href = url;
      }
      watchForPayment(before);
      return true;
    } catch (e) {
      console.error('[Folio/web-payment] openCheckout error:', e);
      if (win && !win.closed) win.close();
      return false;
    }
  }

  // Après ouverture du checkout : détecte l'arrivée des crédits (webhook Stripe)
  let _watchTimer = null;
  function watchForPayment(before) {
    clearInterval(_watchTimer);
    const startCredits  = before ? Number(before.credits) || 0 : 0;
    const startLifetime = !!before?.lifetime_free;
    let ticks = 0;
    _watchTimer = setInterval(async () => {
      if (document.hidden) return;
      if (++ticks > 150) { clearInterval(_watchTimer); return; }   // ~10 min
      const s = await getStatus();
      if (!s) return;
      if ((s.lifetime_free && !startLifetime) || (Number(s.credits) || 0) > startCredits) {
        clearInterval(_watchTimer);
        _showToast(s.lifetime_free ? '🎉 Unlimited access activated!' : `🎉 Payment received — ${s.credits} credit(s) available`, 'success');
        document.getElementById('folio-payment-modal')?.remove();
      }
    }, 4000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _lastStatus) getStatus();
  });

  // ── UI : Toast ────────────────────────────────────────────────────────────
  function _showToast(msg, type = '') {
    if (typeof window.webEditorToast === 'function') {
      window.webEditorToast(msg, type);
      return;
    }
    // Fallback minimal toast
    let t = document.getElementById('folio-web-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'folio-web-toast';
      t.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(60px);
        background:#18181d; border:1px solid rgba(255,255,255,0.1); border-radius:10px;
        padding:12px 20px; font-family:'DM Sans',sans-serif; font-size:14px;
        color:#f0f0f0; z-index:99999; transition:transform 0.3s, opacity 0.3s; opacity:0;
        white-space: nowrap;
      `;
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.borderColor = type === 'success' ? 'rgba(46,213,115,0.3)'
                        : type === 'error'   ? 'rgba(255,71,87,0.3)' : 'rgba(255,255,255,0.1)';
    t.style.transform = 'translateX(-50%) translateY(0)';
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.style.transform = 'translateX(-50%) translateY(60px)';
      t.style.opacity = '0';
    }, 3000);
  }

  // ── UI : Modal de paiement ────────────────────────────────────────────────
  const PACK_UI = [
    { pack: '1',  title: '1 session',  sub: 'Perfect for a one-off need', price: '€0.50', style: 'plain' },
    { pack: '5',  title: '5 sessions', sub: '€0.20 per session — save 60%', price: '€1', style: 'best', badge: 'Best value' },
    { pack: '20', title: '20 sessions', sub: '€0.15 per session — save 80%', price: '€3', style: 'plain' },
    { pack: 'lifetime', title: 'Unlimited — forever', sub: 'All edits, for life — one-time payment', price: '€14.99', style: 'lifetime', badge: '✦ Lifetime' },
  ];

  const PACK_STYLE = {
    plain:    { bg: '#1e1e2a', hoverBg: '#252535', border: '1px solid rgba(255,255,255,0.1)', hoverBorder: 'rgba(232,255,71,0.4)', subColor: '#888899' },
    best:     { bg: '#1a2010', hoverBg: '#1f2a14', border: '2px solid rgba(232,255,71,0.4)', hoverBorder: 'rgba(232,255,71,0.7)', subColor: '#a0c070' },
    lifetime: { bg: 'linear-gradient(135deg,#1a1a2e,#16213e)', hoverBg: '#1e2040', border: '1px solid rgba(232,255,71,0.6)', hoverBorder: 'rgba(232,255,71,0.9)', subColor: '#a0c070' },
  };

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function _showPaymentModal({ reason = 'buy' } = {}) {
    document.getElementById('folio-payment-modal')?.remove();

    const overlay = el('div', `
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'DM Sans', system-ui, sans-serif; overflow-y: auto; padding: 16px 0;
    `);
    overlay.id = 'folio-payment-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const card = el('div', `
      background: #13131a; margin: auto;
      border: 1px solid rgba(232,255,71,0.25); border-radius: 20px;
      padding: 36px 32px 28px; max-width: 420px; width: calc(100% - 32px);
      box-shadow: 0 0 80px rgba(0,0,0,0.8); position: relative;
    `);
    overlay.appendChild(card);

    const close = el('button', `
      position: absolute; top: 14px; right: 14px;
      background: none; border: none; color: #555565;
      font-size: 22px; cursor: pointer; line-height: 1; padding: 4px 8px;
    `, '×');
    close.id = 'fpay-close';
    close.setAttribute('aria-label', 'Close');
    card.appendChild(close);

    const head = el('div', 'text-align:center; margin-bottom: 24px;');
    head.appendChild(el('div', `
      width: 52px; height: 52px; background: #e8ff47; border-radius: 14px;
      margin: 0 auto 16px; display:flex; align-items:center; justify-content:center;
      font-size:22px; font-weight:800; color:#0c0c0f; font-family:'Syne',sans-serif;
    `, 'F'));
    head.appendChild(el('h2', "font-family:'Syne',sans-serif; font-weight:800; font-size:22px; color:#f0f0f0; margin:0 0 10px;",
      reason === 'no_credits' ? 'Editing credit needed' : 'Editing credits'));
    const st = _lastStatus;
    const sub = reason === 'no_credits'
      ? 'Your free sessions have been used. Choose a credit pack to continue editing.'
      : st?.lifetime_free ? 'You have unlimited access. Thank you!'
      : st ? `Balance: ${Number(st.credits) || 0} credit(s) + ${Number(st.freeRemaining) || 0} free session(s). One session = one document, all tools included.`
      : 'One session = one document, all tools included.';
    head.appendChild(el('p', 'color:#888899; font-size:14px; margin:0; line-height:1.6;', sub));
    card.appendChild(head);

    const list = el('div', 'display:flex; flex-direction:column; gap:10px; margin-bottom:18px;');
    const buttons = [];
    for (const p of PACK_UI) {
      const s = PACK_STYLE[p.style];
      const btn = el('button', `
        background: ${s.bg}; border: ${s.border}; border-radius: 12px;
        padding: 14px 18px; display:flex; align-items:center; justify-content:space-between;
        cursor:pointer; transition:all 0.15s; width:100%; position:relative;
      `);
      btn.className = 'fpay-pack';
      btn.dataset.pack = p.pack;
      btn.type = 'button';
      if (p.badge) {
        btn.appendChild(el('div', `
          position:absolute; top:-11px; ${p.style === 'best' ? 'left:50%; transform:translateX(-50%);' : 'right:14px;'}
          background:${p.style === 'best' ? '#e8ff47' : 'linear-gradient(90deg,#e8ff47,#b8ff00)'}; color:#0c0c0f;
          font-family:'Syne',sans-serif; font-weight:800; font-size:10px; padding:2px 12px; border-radius:20px;
          white-space:nowrap; text-transform:uppercase; letter-spacing:0.5px;
        `, p.badge));
      }
      const txt = el('div', 'text-align:left;');
      txt.appendChild(el('div', "color:#f0f0f0; font-weight:600; font-size:15px; font-family:'Syne',sans-serif;", p.title));
      txt.appendChild(el('div', `color:${s.subColor}; font-size:12px; margin-top:3px;`, p.sub));
      btn.appendChild(txt);
      btn.appendChild(el('div', `
        background:${p.style === 'lifetime' ? 'linear-gradient(90deg,#e8ff47,#b8ff00)' : '#e8ff47'}; color:#0c0c0f;
        font-family:'Syne',sans-serif; font-weight:800; font-size:16px; padding:6px 16px; border-radius:8px; flex-shrink:0;
      `, p.price));
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = s.hoverBorder; btn.style.background = s.hoverBg; });
      btn.addEventListener('mouseleave', () => { btn.style.border = s.border; btn.style.background = s.bg; });
      if (st?.lifetime_free) { btn.disabled = true; btn.style.opacity = '0.4'; btn.style.cursor = 'default'; }
      list.appendChild(btn);
      buttons.push(btn);
    }
    card.appendChild(list);

    const loading = el('div', 'display:none; text-align:center; padding:4px 12px 12px; color:#888899; font-size:14px;');
    loading.id = 'fpay-loading';
    card.appendChild(loading);

    // ── Identifiant Folio + restauration ───────────────────────────────────
    const idBox = el('div', 'border-top:1px solid rgba(255,255,255,0.07); padding-top:14px; margin-bottom:12px; font-size:11px; color:#777788; line-height:1.6;');
    const idRow = el('div', 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;');
    idRow.appendChild(el('span', '', 'Your Folio ID:'));
    const idCode = el('code', 'color:#c8c8d8; background:#1e1e2a; padding:2px 6px; border-radius:5px; font-size:11px;', getUID());
    idRow.appendChild(idCode);
    const copyBtn = el('button', 'background:none; border:1px solid rgba(255,255,255,0.12); color:#a0a0b0; border-radius:6px; font-size:10px; padding:2px 8px; cursor:pointer;', 'Copy');
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getUID()); copyBtn.textContent = 'Copied ✓'; }
      catch { const range = document.createRange(); range.selectNodeContents(idCode); getSelection().removeAllRanges(); getSelection().addRange(range); }
    });
    idRow.appendChild(copyBtn);
    idBox.appendChild(idRow);
    idBox.appendChild(el('div', 'margin-top:4px;', 'Keep it to restore your purchases on another browser.'));

    const restoreLink = el('button', 'background:none; border:none; color:#a0a0b0; text-decoration:underline; cursor:pointer; font-size:11px; padding:0; margin-top:4px;', 'Already purchased? Restore with your Folio ID');
    restoreLink.type = 'button';
    const restoreRow = el('div', 'display:none; gap:6px; margin-top:8px;');
    const restoreInput = el('input', 'flex:1; min-width:0; background:#1e1e2a; border:1px solid rgba(255,255,255,0.12); border-radius:6px; color:#f0f0f0; padding:6px 8px; font-size:12px;');
    restoreInput.placeholder = 'u_xxxxxxxx_xxxxxxxxxxxx';
    restoreInput.autocomplete = 'off';
    restoreInput.spellcheck = false;
    const restoreBtn = el('button', "background:#e8ff47; color:#0c0c0f; border:none; border-radius:6px; padding:6px 12px; font-family:'Syne',sans-serif; font-weight:700; font-size:11px; cursor:pointer;", 'Restore');
    restoreBtn.type = 'button';
    restoreRow.append(restoreInput, restoreBtn);
    restoreLink.addEventListener('click', () => { restoreRow.style.display = 'flex'; restoreInput.focus(); });
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      const res = await restoreUID(restoreInput.value);
      restoreBtn.disabled = false;
      if (!res.ok) {
        _showToast(res.reason === 'invalid' ? '❌ Invalid Folio ID' : '❌ Could not reach the server', 'error');
        return;
      }
      const s = res.status;
      _showToast(s.lifetime_free ? '✓ Unlimited access restored' : `✓ ID restored — ${s.credits} credit(s)`, 'success');
      overlay.remove();
    });
    idBox.append(restoreLink, restoreRow);
    card.appendChild(idBox);

    card.appendChild(el('p', 'text-align:center; color:#555565; font-size:11px; margin:0;',
      '🔒 Secure payment via Stripe · Credits never expire, no subscription'));

    document.body.appendChild(overlay);

    const onKey = e => { if (e.key === 'Escape') closeModal(); };
    function closeModal() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    close.addEventListener('click', closeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    for (const btn of buttons) {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        // Ouverture synchrone pendant le clic → pas bloquée par l'anti-popup
        let win = null;
        try { win = window.open('about:blank', '_blank'); } catch { win = null; }
        if (win) {
          try { win.opener = null; } catch { /* ignore */ }
          try { win.document.title = 'Redirecting to Stripe…'; win.document.body.textContent = 'Redirecting to secure payment…'; } catch { /* ignore */ }
        }
        buttons.forEach(b => b.disabled = true);
        loading.style.display = 'block';
        loading.textContent = 'Redirecting to payment…';

        const success = await openCheckout(btn.dataset.pack, win);
        if (!success) {
          loading.textContent = '❌ Error — please try again later';
          buttons.forEach(b => b.disabled = !!_lastStatus?.lifetime_free);
          setTimeout(() => { loading.style.display = 'none'; }, 2500);
        } else {
          loading.textContent = '✓ Payment page opened — this page updates automatically after payment';
          setTimeout(closeModal, 2500);
        }
      });
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Injection sécurisée de canEdit ───────────────────────────────────────
  // _editKey est exposé via le return — WebPayment._editKey est donc accessible
  // dès que le IIFE termine.
  const _editKey = Symbol('folioCanEdit');
  window[_editKey] = canEdit;

  // ── API publique (canEdit intentionnellement absent) ──────────────────────
  return {
    getStatus, lastStatus, onStatus, openCheckout, getUID, restoreUID, isValidUID,
    setDocument, hasActiveSession,
    showPaymentModal: opts => _showPaymentModal(opts),
    _editKey,
  };

})();
