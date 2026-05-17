// ── Folio PDF Studio — web-payment.js ────────────────────────────────────────
// Web version of payment.js — no chrome.* APIs.
// Uses localStorage for UID persistence.
// Importé par web-editor.html : appeler `await WebPayment.canEdit()` avant chaque édition.

const WebPayment = (() => {

  const API_BASE = 'https://folio-backend-ebon.vercel.app';

  // ── UID unique par navigateur (localStorage) ──────────────────────────────
  let _uid = null;

  function getUID() {
    if (_uid) return _uid;
    let id = localStorage.getItem('folioUID');
    if (!id) {
      id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('folioUID', id);
    }
    _uid = id;
    return _uid;
  }

  // ── Récupérer le statut (crédits, free_used) ─────────────────────────────
  async function getStatus() {
    const uid = getUID();
    try {
      const r = await fetch(`${API_BASE}/api/status?uid=${encodeURIComponent(uid)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.error('[Folio/web-payment] getStatus error:', e);
      return null;
    }
  }

  // ── Tenter de consommer un crédit ─────────────────────────────────────────
  async function consume() {
    const uid = getUID();
    try {
      const r = await fetch(`${API_BASE}/api/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      console.error('[Folio/web-payment] consume error:', e);
      return null;
    }
  }

  // ── Ouvrir la page Stripe Checkout ────────────────────────────────────────
  async function openCheckout(pack = '1') {
    const uid = getUID();
    try {
      const r = await fetch(`${API_BASE}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pack })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const { url } = await r.json();
      if (url) window.open(url, '_blank');
      return !!url;
    } catch (e) {
      console.error('[Folio/web-payment] openCheckout error:', e);
      return false;
    }
  }

  // ── Point d'entrée principal ──────────────────────────────────────────────
  async function canEdit() {
    const result = await consume();

    if (result === null) {
      _showToast('❌ Server connection required to edit', 'error');
      return false;
    }

    if (result.ok) {
      if (result.usedFree) {
        _showToast('✨ First session free — enjoy!', 'success');
      }
      return true;
    }

    _showPaymentModal();
    return false;
  }

  // ── UI : Toast ────────────────────────────────────────────────────────────
  function _showToast(msg, type = '') {
    if (typeof webEditorToast === 'function') {
      webEditorToast(msg, type);
    } else {
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
      if (type === 'success') t.style.borderColor = 'rgba(46,213,115,0.3)';
      if (type === 'error')   t.style.borderColor = 'rgba(255,71,87,0.3)';
      t.style.transform = 'translateX(-50%) translateY(0)';
      t.style.opacity = '1';
      clearTimeout(t._timer);
      t._timer = setTimeout(() => {
        t.style.transform = 'translateX(-50%) translateY(60px)';
        t.style.opacity = '0';
      }, 3000);
    }
  }

  // ── UI : Modal de paiement ────────────────────────────────────────────────
  function _showPaymentModal() {
    document.getElementById('folio-payment-modal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'folio-payment-modal';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'DM Sans', system-ui, sans-serif;
    `;

    overlay.innerHTML = `
      <div style="
        background: #13131a;
        border: 1px solid rgba(232,255,71,0.25); border-radius: 20px;
        padding: 40px 36px; max-width: 420px; width: calc(100% - 32px);
        box-shadow: 0 0 80px rgba(0,0,0,0.8); position: relative;
      ">
        <button id="fpay-close" style="
          position: absolute; top: 14px; right: 14px;
          background: none; border: none; color: #555565;
          font-size: 22px; cursor: pointer; line-height: 1; padding: 4px 8px;
        ">×</button>

        <div style="text-align:center; margin-bottom: 28px;">
          <div style="
            width: 52px; height: 52px; background: #e8ff47; border-radius: 14px;
            margin: 0 auto 16px; display:flex; align-items:center; justify-content:center;
            font-size:22px; font-weight:800; color:#0c0c0f; font-family:'Syne',sans-serif;
          ">F</div>
          <h2 style="font-family:'Syne',sans-serif; font-weight:800; font-size:22px; color:#f0f0f0; margin:0 0 10px;">
            Editing credit needed
          </h2>
          <p style="color:#888899; font-size:14px; margin:0; line-height:1.6;">
            Your free session has been used.<br>
            Choose a credit pack to continue editing.
          </p>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:24px;">

          <button class="fpay-pack" data-pack="1" style="
            background: #1e1e2a; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
            padding: 14px 18px; display:flex; align-items:center; justify-content:space-between;
            cursor:pointer; transition:all 0.15s; width:100%;
          ">
            <div style="text-align:left;">
              <div style="color:#f0f0f0; font-weight:600; font-size:15px; font-family:'Syne',sans-serif;">1 session</div>
              <div style="color:#888899; font-size:12px; margin-top:3px;">Perfect for a one-off need</div>
            </div>
            <div style="background:#e8ff47; color:#0c0c0f; font-family:'Syne',sans-serif; font-weight:800; font-size:16px; padding:6px 16px; border-radius:8px; flex-shrink:0;">€0.50</div>
          </button>

          <button class="fpay-pack" data-pack="5" style="
            background: #1a2010; border: 2px solid rgba(232,255,71,0.4); border-radius: 12px;
            padding: 14px 18px; display:flex; align-items:center; justify-content:space-between;
            cursor:pointer; position:relative; transition:all 0.15s; width:100%;
          ">
            <div style="
              position:absolute; top:-11px; left:50%; transform:translateX(-50%);
              background:#e8ff47; color:#0c0c0f; font-family:'Syne',sans-serif;
              font-weight:800; font-size:10px; padding:2px 12px; border-radius:20px;
              white-space:nowrap; text-transform:uppercase; letter-spacing:0.5px;
            ">Best value</div>
            <div style="text-align:left;">
              <div style="color:#f0f0f0; font-weight:600; font-size:15px; font-family:'Syne',sans-serif;">5 sessions</div>
              <div style="color:#a0c070; font-size:12px; margin-top:3px;">€0.20 per session — save 60%</div>
            </div>
            <div style="background:#e8ff47; color:#0c0c0f; font-family:'Syne',sans-serif; font-weight:800; font-size:16px; padding:6px 16px; border-radius:8px; flex-shrink:0;">€1</div>
          </button>

          <button class="fpay-pack" data-pack="20" style="
            background: #1e1e2a; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
            padding: 14px 18px; display:flex; align-items:center; justify-content:space-between;
            cursor:pointer; transition:all 0.15s; width:100%;
          ">
            <div style="text-align:left;">
              <div style="color:#f0f0f0; font-weight:600; font-size:15px; font-family:'Syne',sans-serif;">20 sessions</div>
              <div style="color:#888899; font-size:12px; margin-top:3px;">€0.15 per session — save 80%</div>
            </div>
            <div style="background:#e8ff47; color:#0c0c0f; font-family:'Syne',sans-serif; font-weight:800; font-size:16px; padding:6px 16px; border-radius:8px; flex-shrink:0;">€3</div>
          </button>

        </div>

        <div id="fpay-loading" style="display:none; text-align:center; padding:12px; color:#888899; font-size:14px;"></div>

        <p style="text-align:center; color:#555565; font-size:11px; margin:0;">
          🔒 Secure payment via Stripe · Credits never expire, no subscription
        </p>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('fpay-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelectorAll('.fpay-pack').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = btn.dataset.pack === '5' ? 'rgba(232,255,71,0.7)' : 'rgba(232,255,71,0.4)';
        btn.style.background = btn.dataset.pack === '5' ? '#1f2a14' : '#252535';
      });
      btn.addEventListener('mouseleave', () => {
        if (btn.dataset.pack === '5') {
          btn.style.borderColor = 'rgba(232,255,71,0.4)';
          btn.style.background = '#1a2010';
        } else {
          btn.style.borderColor = 'rgba(255,255,255,0.1)';
          btn.style.background = '#1e1e2a';
        }
      });

      btn.addEventListener('click', async () => {
        overlay.querySelectorAll('.fpay-pack').forEach(b => b.disabled = true);
        const loading = document.getElementById('fpay-loading');
        loading.style.display = 'block';
        loading.textContent = 'Redirecting to payment…';

        const success = await openCheckout(btn.dataset.pack);
        if (!success) {
          loading.textContent = '❌ Error — please try again later';
          setTimeout(() => overlay.remove(), 2500);
        } else {
          loading.textContent = '✓ Payment page opened in a new tab';
          setTimeout(() => overlay.remove(), 1800);
        }
      });
    });
  }

  // ── Injection sécurisée de canEdit ───────────────────────────────────────
  const _editKey = Symbol('folioCanEdit');
  window[_editKey] = canEdit;
  WebPayment._editKey = _editKey;

  // ── API publique (canEdit intentionnellement absent) ──────────────────────
  return { getStatus, openCheckout, getUID, _editKey };

})();