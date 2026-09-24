// api/consume.js
// POST /api/consume  { uid: string, docKey?: string, session?: string }
// Returns: { ok: true, creditsLeft, usedFree?, freeRemaining?, usedLifetimeFree?, session?, sessionExpires? }
//       or { ok: true, sessionValid: true }        (jeton de session valide : rien n'est décompté)
//       or { ok: false, reason: 'no_credits' | 'rate_limited' | 'busy' }
// Logic:
//   - UID must already exist (created by /api/status on first load) — no auto-create here
//   - lifetime_free                → allow (no decrement)
//   - If free_used < FREE_SESSIONS → allow, increment free_used
//   - Else if credits > 0          → allow, credits -= 1
//   - Else                         → deny
// Les écritures sont conditionnelles (verrouillage optimiste) : deux appels
// simultanés ne peuvent plus consommer le même crédit / la même session gratuite.
// Session d'édition : avec `docKey` (empreinte du document), une consommation
// réussie renvoie un jeton signé valable 12 h ; le client le présente pour les
// actions suivantes sur ce document, sans nouveau décompte. Sans docKey
// (extension Chrome), comportement inchangé.
import {
  FREE_SESSIONS, isValidUID, isValidDocKey, updateUserAtomically, signSession, verifySession,
  normalizeCredits, normalizeFreeUsed, createRateLimiter, clientIp, parseJsonBody,
} from '../lib/folio-api.js';

// Décompte réel : 15/min laisse de la marge (plusieurs onglets, extension) tout en bloquant les scripts.
const isRateLimited = createRateLimiter(15, 60_000);
// Vérification d'un jeton (aucun décompte) : plus permissif.
const isSessionRateLimited = createRateLimiter(240, 60_000);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  let body;
  try { body = parseJsonBody(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const ip     = clientIp(req);
  const uid    = body?.uid;
  const docKey = isValidDocKey(body?.docKey) ? body.docKey : null;

  // Jeton de session valide pour ce document : autorisé sans décompte
  if (docKey && body?.session && verifySession(uid, docKey, body.session)) {
    if (isSessionRateLimited(ip)) return res.status(429).json({ ok: false, reason: 'rate_limited' });
    return res.status(200).json({ ok: true, sessionValid: true });
  }

  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  // Ne jamais révéler pourquoi l'UID est refusé : le client affiche la modale de paiement.
  if (!isValidUID(uid)) {
    return res.status(200).json({ ok: false, reason: 'no_credits', creditsLeft: 0 });
  }

  try {
    const result = await tryConsume(uid);
    if (result.ok && docKey) {
      const s = signSession(uid, docKey);
      if (s) { result.session = s.token; result.sessionExpires = s.expires; }
    }
    return res.status(200).json(result);
  } catch (e) {
    if (e.code === 'CONFLICT') return res.status(200).json({ ok: false, reason: 'busy' });
    console.error('[consume]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function tryConsume(uid) {
  return updateUserAtomically(uid, 'uid,credits,free_used,lifetime_free,edit_count', row => {
    if (!row) return { result: { ok: false, reason: 'no_credits', creditsLeft: 0 } };

    const credits   = normalizeCredits(row.credits);
    const editCount = Number(row.edit_count) || 0;

    // ── Lifetime ────────────────────────────────────────────────────────────
    if (row.lifetime_free === true) {
      return {
        expected: { edit_count: row.edit_count },
        patch:    { edit_count: editCount + 1 },
        result:   { ok: true, creditsLeft: credits, usedLifetimeFree: true },
      };
    }

    // ── Sessions gratuites (free_used est un compteur) ─────────────────────
    const freeUsed = normalizeFreeUsed(row.free_used);
    if (freeUsed < FREE_SESSIONS) {
      return {
        expected: { free_used: row.free_used, edit_count: row.edit_count },
        patch:    { free_used: freeUsed + 1, edit_count: editCount + 1 },
        result:   {
          ok: true, creditsLeft: credits, usedFree: true,
          freeRemaining: FREE_SESSIONS - freeUsed - 1,  // restantes après celle-ci
        },
      };
    }

    // ── Crédit payant ──────────────────────────────────────────────────────
    if (credits > 0) {
      return {
        expected: { credits: row.credits, edit_count: row.edit_count },
        patch:    { credits: credits - 1, edit_count: editCount + 1 },
        result:   { ok: true, creditsLeft: credits - 1, usedFree: false, freeRemaining: 0 },
      };
    }

    return { result: { ok: false, reason: 'no_credits', creditsLeft: 0 } };
  });
}
