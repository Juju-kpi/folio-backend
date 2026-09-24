// lib/folio-api.js
// Code partagé par les fonctions /api (hors du dossier api/ pour ne pas être
// déployé comme une fonction Vercel).
//
// - Validation stricte des UID : l'UID est concaténé dans les URLs PostgREST,
//   un UID non validé permettait d'injecter des filtres (ex. `x&lifetime_free=eq.true`)
//   et de lire l'UID d'un autre utilisateur.
// - Accès Supabase avec vérification systématique des réponses.
// - Mises à jour atomiques (verrouillage optimiste) pour éviter les doubles
//   dépenses / pertes de crédits lors de requêtes concurrentes.

import crypto from 'crypto';

// Nombre de sessions gratuites offertes à chaque nouvel utilisateur.
// Source unique : utilisée par /api/status ET /api/consume (elles divergeaient : 4 vs 5).
export const FREE_SESSIONS = 2;

// Nouveaux UID pouvant recevoir des sessions gratuites, par IP et par jour
// (au-delà, l'UID est créé sans session gratuite : l'utilisateur peut acheter).
export const NEW_UIDS_PER_IP_PER_DAY = (() => {
  const n = parseInt(process.env.NEW_UIDS_PER_IP_PER_DAY, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

// Format généré par payment.js (extension) et web-payment.js :
//   'u_' + Date.now().toString(36) + '_' + caractères aléatoires base36
export const UID_RE = /^u_[0-9a-z]{6,12}_[0-9a-z]{6,12}$/;

export function isValidUID(uid) {
  return typeof uid === 'string' && UID_RE.test(uid);
}

// ── Jetons de session d'édition ───────────────────────────────────────────────
// Une session payée (1 crédit) couvre un document pendant 12 h. Le client garde
// un jeton signé par le serveur (HMAC) : modifier le stockage local du navigateur
// ne permet plus de s'octroyer une session. Clé : SESSION_SECRET, ou dérivée de
// SUPABASE_KEY (déjà secrète, rien à configurer).
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DOC_KEY_RE = /^[0-9a-z-]{8,64}$/;

export function isValidDocKey(docKey) {
  return typeof docKey === 'string' && DOC_KEY_RE.test(docKey);
}

function sessionKey() {
  const secret = process.env.SESSION_SECRET || process.env.SUPABASE_KEY;
  if (!secret) return null;
  return crypto.createHmac('sha256', 'folio-session-v1').update(secret).digest();
}

function sessionMac(key, uid, docKey, exp) {
  return crypto.createHmac('sha256', key).update(`${uid}|${docKey}|${exp}`).digest('base64url');
}

export function signSession(uid, docKey, exp = Date.now() + SESSION_TTL_MS) {
  const key = sessionKey();
  if (!key || !isValidUID(uid) || !isValidDocKey(docKey)) return null;
  exp = Math.floor(exp);
  return { token: `${exp}.${sessionMac(key, uid, docKey, exp)}`, expires: exp };
}

export function verifySession(uid, docKey, token) {
  const key = sessionKey();
  if (!key || !isValidUID(uid) || !isValidDocKey(docKey)) return false;
  if (typeof token !== 'string' || token.length > 128) return false;
  const [expStr, mac] = token.split('.');
  if (!/^\d{10,16}$/.test(expStr || '') || !mac) return false;
  const exp = Number(expStr);
  const now = Date.now();
  if (exp < now || exp > now + SESSION_TTL_MS + 60_000) return false;
  const a = Buffer.from(mac);
  const b = Buffer.from(sessionMac(key, uid, docKey, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Packs Stripe (source unique pour checkout.js et webhook.js) ───────────────
export const PACKS = {
  '1':        { credits: 1,  price_cts: 50,   label: '1 session d\'édition',   description: '1 session d\'édition de PDF' },
  '5':        { credits: 5,  price_cts: 100,  label: '5 sessions d\'édition',  description: '5 sessions d\'édition de PDF' },
  '20':       { credits: 20, price_cts: 300,  label: '20 sessions d\'édition', description: '20 sessions d\'édition de PDF' },
  'lifetime': { credits: 0,  price_cts: 1499, label: 'Accès illimité à vie',  description: 'Sessions d\'édition illimitées, à vie', lifetime: true },
};

// ── Normalisation du compteur free_used ───────────────────────────────────────
// Compatibilité ascendante : l'ancien champ était un booléen.
export function normalizeFreeUsed(raw) {
  if (raw === true)  return 1;
  if (raw === false) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeCredits(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── Rate limiter en mémoire (par instance, réinitialisé au cold start) ───────
export function createRateLimiter(maxPerWindow, windowMs) {
  const hits = new Map();
  return function isLimited(key) {
    if (!key) return false;
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (v.every(t => now - t >= windowMs)) hits.delete(k);
      }
    }
    return list.length > maxPerWindow;
  };
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const first = typeof fwd === 'string' ? fwd.split(',')[0].trim() : '';
  return first || req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
}

export function parseJsonBody(req) {
  const b = req.body;
  if (b == null || b === '') return {};
  if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b);
}

// ── Supabase (PostgREST) ──────────────────────────────────────────────────────
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

function usersUrl(query) {
  return `${process.env.SUPABASE_URL}/rest/v1/users?${query}`;
}

// Filtre PostgREST qui correspond exactement à la valeur brute lue en base
// (utilisé pour le verrouillage optimiste).
function eqFilter(column, raw) {
  if (raw === null || raw === undefined) return `${column}=is.null`;
  if (raw === true)  return `${column}=is.true`;
  if (raw === false) return `${column}=is.false`;
  return `${column}=eq.${encodeURIComponent(String(raw))}`;
}

export async function getUserRow(uid, columns = 'uid,credits,free_used,lifetime_free') {
  if (!isValidUID(uid)) throw new Error('Invalid uid');
  const r = await fetch(usersUrl(`uid=eq.${encodeURIComponent(uid)}&select=${columns}&limit=1`), {
    headers: sbHeaders(),
  });
  if (!r.ok) throw new Error('Supabase fetch error: ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function insertUser(row) {
  if (!isValidUID(row.uid)) throw new Error('Invalid uid');
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/users`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  // 409 = UID déjà créé par une requête concurrente : pas une erreur.
  if (!r.ok && r.status !== 409) throw new Error('Supabase insert error: ' + r.status);
  return r.ok;
}

// ── Limite des nouveaux UID par IP et par jour ────────────────────────────────
// L'IP n'est jamais stockée : seulement une empreinte HMAC (clé secrète + jour),
// impossible à relier d'un jour à l'autre, supprimée par la base après 48 h.
export function hashIp(ip, day = new Date().toISOString().slice(0, 10)) {
  const secret = process.env.SESSION_SECRET || process.env.SUPABASE_KEY || '';
  return crypto.createHmac('sha256', `folio-ip-v1|${secret}`).update(`${day}|${ip}`).digest('base64url').slice(0, 32);
}

let registerWarned = false;

// Enregistre la création d'un UID pour cette IP aujourd'hui.
// → true si ce nouvel UID peut encore recevoir des sessions gratuites.
// Si la fonction SQL n'est pas (encore) installée, on ne bloque rien.
export async function registerNewUid(ip) {
  if (!ip) return true;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/folio_register_uid`, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_ip_hash: hashIp(ip), p_limit: NEW_UIDS_PER_IP_PER_DAY }),
    });
    if (!r.ok) {
      if (!registerWarned) {
        registerWarned = true;
        console.warn(`[folio] folio_register_uid unavailable (HTTP ${r.status}) — run supabase/migrations/20260924_uid_creation_limit.sql; free sessions are not limited per IP`);
      }
      return true;
    }
    return (await r.json()) === true;
  } catch (e) {
    console.warn('[folio] registerNewUid failed:', e.message);
    return true;
  }
}

// PATCH conditionnel : n'applique `patch` que si les colonnes de `expected`
// ont toujours la valeur lue. Retourne true si une ligne a été modifiée.
export async function patchUserIf(uid, expected, patch) {
  if (!isValidUID(uid)) throw new Error('Invalid uid');
  const filters = [`uid=eq.${encodeURIComponent(uid)}`];
  for (const [col, raw] of Object.entries(expected)) filters.push(eqFilter(col, raw));
  const r = await fetch(usersUrl(filters.join('&')), {
    method: 'PATCH',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error('Supabase patch error: ' + r.status);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

// Applique `compute(row)` → { expected, patch, result } avec quelques tentatives
// en cas de modification concurrente. `compute` peut retourner { result } seul
// (aucune écriture nécessaire).
export async function updateUserAtomically(uid, columns, compute, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const row = await getUserRow(uid, columns);
    const step = await compute(row);
    if (!step.patch) return step.result;
    if (await patchUserIf(uid, step.expected, step.patch)) return step.result;
    await new Promise(r => setTimeout(r, 40 + Math.random() * 80));
  }
  const err = new Error('Concurrent update conflict');
  err.code = 'CONFLICT';
  throw err;
}

// ── URL publique du site (pour les redirections Stripe) ──────────────────────
// VERCEL_URL est l'URL propre au déploiement (protégée par défaut par la
// "Deployment Protection" de Vercel) : on préfère le domaine de production.
export function publicBaseUrl(req) {
  const explicit = process.env.PUBLIC_SITE_URL || process.env.SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_URL) return 'https://' + process.env.VERCEL_URL;
  const host = req?.headers?.host;
  if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) {
    return (host.startsWith('localhost') || host.startsWith('127.') ? 'http://' : 'https://') + host;
  }
  return 'http://localhost:3000';
}
