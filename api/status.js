// api/status.js
// GET /api/status?uid=USER_ID
// Returns: { credits: number, freeUsed: boolean }

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { uid } = req.query;
  if (!uid || uid.length < 8) return res.status(400).json({ error: 'Missing uid' });

  try {
    const data = await getUser(uid);
    return res.status(200).json(data);
  } catch (e) {
    console.error('[status]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Supabase helpers (minimal fetch, no SDK needed) ──────────────────────────
async function getUser(uid) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}&select=uid,credits,free_used`;
  const r = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
    }
  });

  if (!r.ok) throw new Error('Supabase error: ' + r.status);
  const rows = await r.json();

  if (rows.length === 0) {
    // New user → create them
    await createUser(uid);
    return { credits: 0, free_used: false };
  }

  return rows[0];
}

async function createUser(uid) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/users`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ uid, credits: 0, free_used: false })
  });
}