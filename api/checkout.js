// api/checkout.js
// POST /api/checkout  { uid: string, pack: '1' | '5' | '20' }
// Returns: { url: string }  — Stripe Checkout hosted URL

import Stripe from 'stripe';

const PACKS = {
  '1':        { credits: 1,  price_cts: 50,   label: '1 session d\'édition'            },
  '5':        { credits: 5,  price_cts: 100,  label: '5 sessions d\'édition'           },
  '20':       { credits: 20, price_cts: 300,  label: '20 sessions d\'édition'          },
  'lifetime': { credits: 0,  price_cts: 1499, label: 'Accès illimité à vie'            }
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { uid, pack } = body || {};
  if (!uid || uid.length < 8)  return res.status(400).json({ error: 'Missing uid' });
  if (!PACKS[pack])            return res.status(400).json({ error: 'Invalid pack' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const selected = PACKS[pack];

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Folio PDF Studio — ${selected.label}`,
            description: `${selected.credits} session(s) d'édition de PDF`
          },
          unit_amount: selected.price_cts // cents
        },
        quantity: 1
      }],
      metadata: {
        uid,
        credits: String(selected.credits),
        pack,
        lifetime: pack === 'lifetime' ? 'true' : 'false'
      },
      // After payment, redirect back to the extension's payment-success page
      success_url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/payment-cancel.html`
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e);
    return res.status(500).json({ error: e.message });
  }
}