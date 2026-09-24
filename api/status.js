// api/status.js
// GET /api/status?uid=USER_ID
// Returns: { uid, credits, free_used, freeRemaining, lifetime_free }
import {
  FREE_SESSIONS, isValidUID, getUserRow, insertUser, registerNewUid,
  normalizeCredits, normalizeFreeUsed, createRateLimiter, clientIp,
} from '../lib/folio-api.js';

// Anti-rafale (en mémoire) sur la création de nouveaux UID. La limite durable
// (sessions gratuites par IP et par jour) est tenue en base : registerNewUid().
const isCreationLimited = createRateLimiter(20, 10 * 60_000);
const isReadLimited     = createRateLimiter(120, 60_000);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const uid = typeof req.query.uid === 'string' ? req.query.uid : '';
  if (!isValidUID(uid)) return res.status(400).json({ error: 'Invalid uid' });

  const ip = clientIp(req);
  if (isReadLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

  try {
    const row = await getUserRow(uid);

    if (!row) {
      if (isCreationLimited(ip)) return res.status(429).json({ error: 'rate_limited' });
      // Au-delà du quota de l'IP pour la journée (effacer les données du navigateur
      // pour obtenir un nouvel UID), le nouvel UID n'a pas de session gratuite.
      const allowFree = await registerNewUid(ip);
      const freeUsed  = allowFree ? 0 : FREE_SESSIONS;
      const created   = await insertUser({ uid, credits: 0, free_used: freeUsed });
      if (!created) {
        const existing = await getUserRow(uid);   // créé par une requête concurrente
        if (existing) return res.status(200).json(format(existing));
      }
      return res.status(200).json(format({ uid, credits: 0, free_used: freeUsed, lifetime_free: false }));
    }

    return res.status(200).json(format(row));
  } catch (e) {
    console.error('[status]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

function format(row) {
  const freeUsed = normalizeFreeUsed(row.free_used);
  return {
    uid:           row.uid,
    credits:       normalizeCredits(row.credits),
    free_used:     freeUsed,
    freeRemaining: Math.max(0, FREE_SESSIONS - freeUsed),
    lifetime_free: row.lifetime_free === true,
  };
}
