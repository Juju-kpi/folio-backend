// api/checkout.js
// POST /api/checkout  { uid: string, pack: '1' | '5' | '20' | 'lifetime' }
// Returns: { url: string }  — Stripe Checkout hosted URL
//       or { error: 'already_lifetime' } (409) si l'utilisateur a déjà l'accès illimité

import Stripe from 'stripe';
import {
  PACKS, isValidUID, getUserRow, createRateLimiter, clientIp, parseJsonBody, publicBaseUrl,
} from '../lib/folio-api.js';

const isRateLimited = createRateLimiter(10, 60_000);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  if (isRateLimited(clientIp(req))) return res.status(429).json({ error: 'rate_limited' });

  let body;
  try { body = parseJsonBody(req); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { uid, pack } = body || {};
  // Un UID invalide ne pourrait jamais consommer ses crédits (/api/consume le refuse) :
  // on refuse le paiement plutôt que d'encaisser pour rien.
  if (!isValidUID(uid)) return res.status(400).json({ error: 'Invalid uid' });
  if (typeof pack !== 'string' || !Object.hasOwn(PACKS, pack)) {
    return res.status(400).json({ error: 'Invalid pack' });
  }

  const selected = PACKS[pack];

  // Évite de faire payer un utilisateur qui a déjà l'accès illimité.
  try {
    const row = await getUserRow(uid, 'uid,lifetime_free');
    if (row?.lifetime_free === true) return res.status(409).json({ error: 'already_lifetime' });
  } catch (e) {
    console.warn('[checkout] lifetime check skipped:', e.message);
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const base   = publicBaseUrl(req);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      client_reference_id: uid,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Folio PDF Studio — ${selected.label}`,
            description: selected.description,
          },
          unit_amount: selected.price_cts, // cents
        },
        quantity: 1,
      }],
      metadata: {
        uid,
        credits: String(selected.credits),
        pack,
        lifetime: selected.lifetime ? 'true' : 'false',
      },
      // La page s'appelait "payment-sucess.html" alors que Stripe redirigeait vers
      // "payment-success.html" (404 après paiement). Les deux existent désormais.
      success_url: `${base}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${base}/payment-cancel.html`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('[checkout]', e);
    // Ne pas renvoyer le message Stripe brut au client.
    return res.status(500).json({ error: 'checkout_failed' });
  }
}
