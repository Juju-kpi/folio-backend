// api/consume.js
// POST /api/consume  { uid: string }
// Returns: { ok: true, creditsLeft: number } or { ok: false, reason: 'no_credits' }
// Logic:
//   - UID must already exist (created by /api/status on first load) — no auto-create here
//   - If free_used < FREE_SESSIONS → allow, increment free_used
//   - Else if credits > 0          → allow, credits -= 1
//   - Else                         → deny

const FREE_SESSIONS = 4;  // ← nombre de sessions gratuites offertes à chaque nouvel utilisateur

// ── IP rate limiter (in-memory, resets on cold start) ────────────────────────
const MAX_PER_WINDOW = 5;
const WINDOW_MS      = 60_000;
const ipHits         = new Map();

function isRateLimited(ip) {
  if (!ip) return false;
  const now  = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every(t => now - t >= WINDOW_MS)) ipHits.delete(k);
    }
  }
  return hits.length > MAX_PER_WINDOW;
}

// ── UID format validation ─────────────────────────────────────────────────────
const UID_RE = /^u_[0-9a-z]{6,12}_[0-9a-z]{6,12}$/;
function isValidUIDFormat(uid) {
  return typeof uid === 'string' && UID_RE.test(uid);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { uid } = body || {};

  if (!uid || !isValidUIDFormat(uid)) {
    return res.status(200).json({ ok: false, reason: 'no_credits', creditsLeft: 0 });
  }

  try {
    const result = await tryConsume(uid);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[consume]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function tryConsume(uid) {
  const getUrl =
    `${process.env.SUPABASE_URL}/rest/v1/users` +
    `?uid=eq.${encodeURIComponent(uid)}` +
    `&select=uid,credits,free_used,lifetime_free,edit_count`;

  const r = await fetch(getUrl, {
    headers: {
      'apikey':        process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
    }
  });

  if (!r.ok) throw new Error('Supabase fetch error');
  const rows = await r.json();

  if (rows.length === 0) {
    return { ok: false, reason: 'no_credits', creditsLeft: 0 };
  }

  const user = rows[0];

  // ── Lifetime free users ───────────────────────────────────────────────────
  if (user.lifetime_free === true) {
    await patchUser(uid, { edit_count: (user.edit_count || 0) + 1 });
    return { ok: true, creditsLeft: user.credits, usedLifetimeFree: true };
  }

  // ── Sessions gratuites (free_used est un compteur, pas un booléen) ────────
  // Compatibilité ascendante : si free_used === true (ancien boolean), on le
  // traite comme 1 (déjà utilisé une fois) pour ne pas casser les anciens users.
  const freeUsed = user.free_used === true ? 1
                 : user.free_used === false ? 0
                 : (user.free_used || 0);

  if (freeUsed < FREE_SESSIONS) {
    await patchUser(uid, {
      free_used:  freeUsed + 1,
      edit_count: (user.edit_count || 0) + 1
    });
    return {
      ok:           true,
      creditsLeft:  user.credits,
      usedFree:     true,
      freeRemaining: FREE_SESSIONS - freeUsed - 1   // combien il en reste après celle-ci
    };
  }

  // ── Consume paid credit ───────────────────────────────────────────────────
  if (user.credits > 0) {
    await patchUser(uid, {
      credits:    user.credits - 1,
      edit_count: (user.edit_count || 0) + 1
    });
    return { ok: true, creditsLeft: user.credits - 1, usedFree: false };
  }

  return { ok: false, reason: 'no_credits', creditsLeft: 0 };
}

async function patchUser(uid, patch) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${encodeURIComponent(uid)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey':        process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(patch)
  });
}
