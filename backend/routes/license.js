import { Router } from 'express';
import { getEntitlement, startTrial, requestPlan, cancelPlanRequest, PLAN_IDS } from '../utils/license.js';
import { recordAudit } from '../utils/audit.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try { res.json(await getEntitlement(req.user.id)); } catch (error) { next(error); }
});

router.post('/trial', async (req, res, next) => {
  try {
    // Support staff must not consume the customer's one-time trial.
    if (req.support) return res.status(403).json({ error: 'Only the account holder can start the free trial' });
    const result = await startTrial(req.user.id);
    await recordAudit(req, 'license.trial_started', result.ok ? 'success' : 'denied', { subjectUserId: req.user.id, status: result.ok ? 200 : result.status });
    if (!result.ok) return res.status(result.status).json({ error: result.error, entitlement: result.entitlement });
    res.json(result.entitlement);
  } catch (error) { next(error); }
});

// The customer's plan choice. Nothing is charged; an administrator approves it by granting the plan.
router.post('/request', async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'Only the account holder can choose a plan' });
    const plan = req.body?.plan;
    if (!PLAN_IDS.includes(plan)) return res.status(400).json({ error: 'plan must be pro or pro_plus' });
    const result = await requestPlan(req.user.id, plan);
    await recordAudit(req, 'license.plan_requested', result.ok ? 'success' : 'denied', { subjectUserId: req.user.id, status: result.ok ? 200 : result.status, detail: { plan } });
    if (!result.ok) return res.status(result.status).json({ error: result.error, entitlement: result.entitlement });
    res.json(result.entitlement);
  } catch (error) { next(error); }
});

router.delete('/request', async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'Only the account holder can change a plan request' });
    const entitlement = await cancelPlanRequest(req.user.id);
    await recordAudit(req, 'license.plan_request_cancelled', 'success', { subjectUserId: req.user.id, status: 200 });
    res.json(entitlement);
  } catch (error) { next(error); }
});

export default router;
