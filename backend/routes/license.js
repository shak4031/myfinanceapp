import { Router } from 'express';
import { getEntitlement, startTrial } from '../utils/license.js';
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

export default router;
