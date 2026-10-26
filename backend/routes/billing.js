import { Router } from 'express';
import { getEntitlement } from '../utils/license.js';
import { billingConfigured, checkout, billingPortal, billingSubscription, scheduleDowngrade, cancelDowngrade, stripeClient, handleStripeEvent } from '../utils/billing.js';
import { ownerOnly } from '../utils/households.js';
import { recordAudit, structuredLog } from '../utils/audit.js';

const router = Router();
router.get('/', async (req, res, next) => {
  try {
    const subscription = await billingSubscription(req.household);
    res.json({ owner: req.household.role === 'owner', configured: billingConfigured(),
      entitlement: await getEntitlement(req.user.id), subscription });
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ error: error.message });
    next(error);
  }
});
router.post('/downgrade', async (req, res, next) => {
  try {
    ownerOnly(req);
    const result = await scheduleDowngrade(req.household, req.body?.consent, req.body?.effectiveAt);
    await recordAudit(req, 'billing.downgrade_scheduled', 'success', { detail: result.pending_change });
    res.json(result);
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ error: error.message });
    next(error);
  }
});
router.post('/downgrade/cancel', async (req, res, next) => {
  try {
    ownerOnly(req);
    const result = await cancelDowngrade(req.household);
    await recordAudit(req, 'billing.downgrade_removed', 'success');
    res.json(result);
  } catch (error) { next(error); }
});
router.post('/checkout', async (req, res, next) => {
  try {
    ownerOnly(req);
    if (!req.user.emailVerified) return res.status(403).json({ code: 'EMAIL_VERIFICATION_REQUIRED', error: 'Verify your email before starting checkout.' });
    const result = await checkout(req.household, req.user, req.body?.plan, req.body?.consent);
    await recordAudit(req, 'billing.checkout_started', 'success', { detail: { plan: req.body.plan } });
    res.json(result);
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ error: error.message });
    next(error);
  }
});
router.post('/portal', async (req, res, next) => {
  try {
    ownerOnly(req);
    const result = await billingPortal(req.household, req.body?.plan);
    if (req.body?.plan) await recordAudit(req, 'billing.upgrade_started', 'success', { detail: { plan: req.body.plan } });
    res.json(result);
  } catch (error) {
    if (error.status === 503) return res.status(503).json({ error: error.message });
    next(error);
  }
});

export async function stripeWebhook(req, res) {
  let event;
  try {
    if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('Webhook secret missing');
    event = stripeClient().webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    structuredLog('warn', { event: 'billing.webhook_rejected', requestId: req.id });
    return res.status(400).json({ error: 'Invalid Stripe webhook signature.' });
  }
  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (error) {
    structuredLog('error', { event: 'billing.webhook_failed', requestId: req.id, message: error.message });
    return res.status(500).json({ error: 'Stripe event could not be processed.' });
  }
}

export async function requireSubscription(req, res, next) {
  try {
    const entitlement = await getEntitlement(req.user.id);
    if (entitlement.active) return next();
    return res.status(402).json({ code: 'SUBSCRIPTION_REQUIRED', error: 'Choose Basic or Pro to access your household finances.', entitlement });
  } catch (error) { next(error); }
}
export default router;
