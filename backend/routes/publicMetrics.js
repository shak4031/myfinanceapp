import { Router } from 'express';
import { createHash } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { recordTraffic } from '../utils/traffic.js';

const router = Router();
const limits = new Map();
let nextSweep = 0;

router.post('/', async (req, res, next) => {
  const input = req.body;
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).length !== 1 || !['homepage_view', 'signup_click'].includes(input.event)) {
    return res.status(400).json({ error: 'Provide only a supported traffic event.' });
  }
  const now = Date.now();
  if (now >= nextSweep) {
    for (const [key, entry] of limits) if (entry.expires <= now) limits.delete(key);
    nextSweep = now + 60000;
  }
  // Transient abuse control only; no IP, visitor ID, or cookie is stored with the counters.
  const key = createHash('sha256').update(req.ip || '').digest('hex');
  const entry = limits.get(key);
  if (entry && entry.expires > now && entry.count >= 60) {
    return res.status(429).json({ error: 'Too many traffic reports. Try again in a minute.' });
  }
  if (!entry && limits.size >= 10000) return res.status(429).json({ error: 'Traffic reporting is busy. Try again later.' });
  limits.set(key, entry && entry.expires > now
    ? { ...entry, count: entry.count + 1 } : { count: 1, expires: now + 60000 });
  try {
    await administrativeTransaction(client => recordTraffic(client, input.event));
    res.status(202).json({ accepted: true });
  } catch (error) { next(error); }
});

export default router;
