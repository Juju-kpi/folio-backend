// api/webhook.js
// POST /api/webhook  — called by Stripe after successful payment
// Stripe sends the raw body; we verify signature and add credits.
//
// Robustesse :
//   - Idempotence : Stripe peut livrer plusieurs fois le même événement. Une fois
//     les crédits ajoutés, le PaymentIntent est marqué (metadata folio_fulfilled)
//     et les livraisons suivantes sont ignorées (avant : crédits ajoutés en double).
//   - Ajout de crédits atomique (verrouillage optimiste) et réponses Supabase
//     vérifiées (avant : un échec d'écriture était ignoré → client payé sans crédits).
//   - Le nombre de crédits est dérivé du pack côté serveur.

import Stripe from 'stripe';
import {
  PACKS, isValidUID, getUserRow, insertUser, updateUserAtomically, normalizeCredits,
} from '../lib/folio-api.js';

// Tell Vercel NOT to parse the body (Stripe needs the raw bytes for signature verification)
export const config = { api: { bodyParser: false } };

const FULFILLED_KEY = 'folio_fulfilled';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig    = req.headers['stripe-signature'];

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[webhook] Signature verification failed:', e.message);
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }

  if (event.type !== 'checkout.session.completed' &&
      event.type !== 'checkout.session.async_payment_succeeded') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;

  // Only process paid sessions
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true });
  }

  const meta = session.metadata || {};
  const uid  = meta.uid || session.client_reference_id;
  if (!isValidUID(uid)) {
    console.error('[webhook] Missing/invalid uid in metadata:', meta);
    return res.status(200).json({ received: true }); // Still return 200 to Stripe
  }

  const pack     = Object.hasOwn(PACKS, meta.pack || '') ? PACKS[meta.pack] : null;
  const lifetime = pack ? !!pack.lifetime : meta.lifetime === 'true';
  const credits  = pack ? pack.credits : parseInt(meta.credits, 10);

  if (!lifetime && !(Number.isInteger(credits) && credits > 0)) {
    console.error('[webhook] Missing credits in metadata:', meta);
    return res.status(200).json({ received: true });
  }

  const piId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;

  // ── Idempotence : déjà traité ? ─────────────────────────────────────────────
  if (piId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi?.metadata?.[FULFILLED_KEY] === 'true') {
        console.log(`[webhook] ${session.id} already fulfilled — skipping`);
        return res.status(200).json({ received: true, duplicate: true });
      }
    } catch (e) {
      // En cas d'erreur Stripe on continue (comportement historique).
      console.warn('[webhook] Could not check fulfillment marker:', e.message);
    }
  }

  try {
    if (lifetime) {
      await setLifetimeFree(uid);
      console.log(`[webhook] Set lifetime_free for ${uid}`);
    } else {
      await addCredits(uid, credits);
      console.log(`[webhook] Added ${credits} credits to ${uid}`);
    }
  } catch (e) {
    console.error('[webhook] Failed to add credits:', e);
    // Return 500 so Stripe retries (rien n'a été crédité, pas de marqueur posé)
    return res.status(500).json({ error: 'Failed to update credits' });
  }

  // ── Marquer comme traité (best effort : ne jamais faire rejouer Stripe ici) ──
  if (piId) {
    try {
      await stripe.paymentIntents.update(piId, {
        metadata: { [FULFILLED_KEY]: 'true', folio_uid: uid, folio_session: session.id },
      });
    } catch (e) {
      console.warn('[webhook] Could not set fulfillment marker:', e.message);
    }
  }

  return res.status(200).json({ received: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function setLifetimeFree(uid) {
  const row = await getUserRow(uid, 'uid,lifetime_free');
  if (!row) {
    // Le PATCH ci-dessous gère le cas où une requête concurrente vient de créer la ligne.
    const created = await insertUser({ uid, credits: 0, free_used: 0, lifetime_free: true });
    if (created) return;
  }
  await updateUserAtomically(uid, 'uid,lifetime_free', r => {
    if (!r) throw new Error('User row missing after insert');
    if (r.lifetime_free === true) return { result: true };
    return { expected: { lifetime_free: r.lifetime_free }, patch: { lifetime_free: true }, result: true };
  });
}

async function addCredits(uid, amount) {
  const row = await getUserRow(uid, 'uid,credits');
  if (!row) {
    const created = await insertUser({ uid, credits: amount, free_used: 0 });
    if (created) return;
  }
  await updateUserAtomically(uid, 'uid,credits', r => {
    if (!r) throw new Error('User row missing after insert');
    return {
      expected: { credits: r.credits },
      patch:    { credits: normalizeCredits(r.credits) + amount },
      result:   true,
    };
  });
}

// Ne pas accéder à req.body ici : sur Vercel c'est un getter qui parse le JSON,
// ce qui ferait perdre les octets bruts nécessaires à la vérification de signature.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
