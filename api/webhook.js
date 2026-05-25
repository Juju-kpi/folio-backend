// api/webhook.js
// POST /api/webhook  — called by Stripe after successful payment
// Stripe sends the raw body; we verify signature and add credits

import Stripe from 'stripe';

// Tell Vercel NOT to parse the body (Stripe needs the raw bytes for signature verification)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig    = req.headers['stripe-signature'];

  let event;
  try {
    // Read raw body
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[webhook] Signature verification failed:', e.message);
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only process paid sessions
    if (session.payment_status !== 'paid') {
      return res.status(200).json({ received: true });
    }

    const { uid, credits, lifetime } = session.metadata || {};
    if (!uid) {
      console.error('[webhook] Missing metadata:', session.metadata);
      return res.status(200).json({ received: true }); // Still return 200 to Stripe
    }

    try {
      if (lifetime === 'true') {
        await setLifetimeFree(uid);
        console.log(`[webhook] Set lifetime_free for ${uid}`);
      } else {
        if (!credits) {
          console.error('[webhook] Missing credits in metadata:', session.metadata);
          return res.status(200).json({ received: true });
        }
        await addCredits(uid, parseInt(credits));
        console.log(`[webhook] Added ${credits} credits to ${uid}`);
      }
    } catch (e) {
      console.error('[webhook] Failed to add credits:', e);
      // Return 500 so Stripe retries
      return res.status(500).json({ error: 'Failed to update credits' });
    }
  }

  return res.status(200).json({ received: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function setLifetimeFree(uid) {
  const getUrl = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}&select=uid`;
  const r = await fetch(getUrl, {
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
    }
  });
  if (!r.ok) throw new Error('Supabase fetch: ' + r.status);
  const rows = await r.json();

  if (rows.length === 0) {
    // Create user with lifetime_free
    const postUrl = `${process.env.SUPABASE_URL}/rest/v1/users`;
    await fetch(postUrl, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ uid, credits: 0, free_used: true, lifetime_free: true })
    });
  } else {
    const patchUrl = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ lifetime_free: true })
    });
  }
}

async function addCredits(uid, amount) {
  // First get current credits
  const getUrl = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}&select=uid,credits`;
  const r = await fetch(getUrl, {
    headers: {
      'apikey': process.env.SUPABASE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
    }
  });

  if (!r.ok) throw new Error('Supabase fetch: ' + r.status);
  const rows = await r.json();

  if (rows.length === 0) {
    // User not found — create them with credits
    const postUrl = `${process.env.SUPABASE_URL}/rest/v1/users`;
    await fetch(postUrl, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ uid, credits: amount, free_used: true }) // paid users skip free
    });
  } else {
    const current = rows[0].credits || 0;
    const patchUrl = `${process.env.SUPABASE_URL}/rest/v1/users?uid=eq.${uid}`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ credits: current + amount })
    });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}