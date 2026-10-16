import { Router } from 'express';
import { recordAudit } from '../utils/audit.js';

const router = Router();
const reportTimes = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REPORTS = 10;

function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|token|secret|cookie|authorization|amount|balance|description)\s*[:=]\s*[^,;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:[$€£]\s*)-?\d[\d,]*(?:\.\d{1,2})?/g, '[amount]')
    .replace(/\b\d{8,}\b/g, '[number]')
    .slice(0, limit);
}

function sourceFile(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const path = new URL(value, 'http://localhost').pathname;
    return path.split('/').pop().slice(0, 120);
  } catch {
    return '';
  }
}

router.post('/', async (req, res) => {
  const now = Date.now();
  if (reportTimes.size > 1000) {
    for (const [userId, times] of reportTimes) {
      if (!times.length || now - times[times.length - 1] > WINDOW_MS) reportTimes.delete(userId);
    }
  }
  const recent = (reportTimes.get(req.user.id) || []).filter(time => now - time < WINDOW_MS);
  if (recent.length >= MAX_REPORTS) return res.status(429).json({ error: 'Too many error reports. Try again later.' });

  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'Invalid error report' });
  }
  const name = cleanText(input.name, 80);
  const message = cleanText(input.message, 500);
  if (!name || !message) return res.status(400).json({ error: 'Error name and message are required' });

  recent.push(now);
  reportTimes.set(req.user.id, recent);
  const line = Number.isSafeInteger(input.line) && input.line > 0 ? input.line : null;
  const column = Number.isSafeInteger(input.column) && input.column > 0 ? input.column : null;
  await recordAudit(req, 'client.error', 'error', {
    detail: { source: 'browser', name, message, file: sourceFile(input.file), line, column }
  });
  res.status(202).json({ accepted: true });
});

export default router;
