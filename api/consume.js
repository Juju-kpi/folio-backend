// api/consume.js
// POST /api/consume  { uid: string }
// Returns: { ok: true, creditsLeft: number } or { ok: false, reason: 'no_credits' | 'free_already_used' }
// Logic:
//   - If free_used = false → allow, set free_used = true
//   - Else if credits > 0  → allow, credits -= 1
//   - Else                 → deny

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;

  try {
    body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { uid } = body || {};

  if (!uid || uid.length < 8) {
    return res.status(400).json({ error: 'Missing uid' });
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

  // ── Fetch user ───────────────────────────────────────────
  const getUrl =
    `${process.env.SUPABASE_URL}/rest/v1/users` +
    `?uid=eq.${uid}` +
    `&select=uid,credits,free_used,lifetime_free`;

  const r = await fetch(getUrl, {
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
    }
  });

  if (!r.ok) {
    throw new Error('Supabase fetch error');
  }

  const rows = await r.json();

  let user;

  // ── Auto create user ────────────────────────────────────
  if (rows.length === 0) {

    user = {
      uid,
      credits: 0,
      free_used: false,
      lifetime_free: false
    };

    await patchUser(uid, {
      credits: 0,
      free_used: false,
      lifetime_free: false
    }, true);

  } else {
    user = rows[0];
  }

  // ── Lifetime free users ─────────────────────────────────
  if (user.lifetime_free === true) {

    await patchUser(uid, {
  edit_count: (user.edit_count || 0) + 1
});

return {
  ok: true,
  creditsLeft: user.credits,
  usedLifetimeFree: true
};

  // ── First free use ──────────────────────────────────────
  if (!user.free_used) {

    await patchUser(uid, {
  free_used: true,
  edit_count: (user.edit_count || 0) + 1
});

    return {
      ok: true,
      creditsLeft: user.credits,
      usedFree: true
    };
  }

  // ── Consume paid credit ─────────────────────────────────
  if (user.credits > 0) {

    await patchUser(uid, {
  credits: user.credits - 1,
  edit_count: (user.edit_count || 0) + 1
});

    return {
      ok: true,
      creditsLeft: user.credits - 1,
      usedFree: false
    };
  }

  // ── No credits left ─────────────────────────────────────
  return {
    ok: false,
    reason: 'no_credits',
    creditsLeft: 0
  };
}

async function patchUser(uid, patch, isInsert = false) {

  const url = isInsert
    ? `${process.env.SUPABASE_URL}/rest/v1/users`
    : `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}`;

  await fetch(url, {
    method: isInsert ? 'POST' : 'PATCH',

    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },

    body: JSON.stringify(
      isInsert
        ? { uid, ...patch }
        : patch
    )
  });
}