import { Router } from 'express';
import { administrativeTransaction } from '../db.js';
import { recordAudit } from '../utils/audit.js';
import { isDemoEmail } from '../utils/demo.js';
import { sendSupportTicketEmail } from '../utils/mailer.js';
import { log } from '../utils/logger.js';
import { rateLimit } from './auth.js';

const router = Router();
export const adminSupportTickets = Router();
const statuses = ['open', 'in_progress', 'resolved'];
const parseId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const view = row => ({
  id: row.id, number: `MFA-${row.id}`, description: row.description, category: row.category,
  status: row.status, emailStatus: row.email_status, createdAt: row.created_at,
  updatedAt: row.updated_at, resolvedAt: row.resolved_at,
  ...(row.email ? { userEmail: row.email, userName: row.name } : {})
});

router.use((req, res, next) => {
  if (req.support) return res.status(403).json({ error: 'End the support session to manage your own tickets.' });
  if (isDemoEmail(req.user.email)) return res.status(403).json({ error: 'Support tickets are unavailable in the public demo.' });
  next();
});

async function notify(req, id) {
  return administrativeTransaction(async client => {
    const ticket = (await client.query('SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (ticket.email_status === 'sent') return ticket;
    const user = (await client.query('SELECT name,email FROM users WHERE id=$1', [ticket.user_id])).rows[0];
    let emailStatus = 'sent';
    try {
      await sendSupportTicketEmail(req, user, ticket);
    } catch (error) {
      emailStatus = 'failed';
      log('SUPPORT', `Ticket MFA-${id} email notification failed; check SMTP configuration and delivery.`, 'error');
    }
    return (await client.query('UPDATE support_tickets SET email_status=$2 WHERE id=$1 RETURNING *', [id, emailStatus])).rows[0];
  });
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await administrativeTransaction(async client =>
      (await client.query('SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.user.id])).rows);
    res.json(rows.map(view));
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const rawCategory = req.body?.category;
    const category = typeof rawCategory === 'string' ? rawCategory.trim() || null : null;
    if (description.length < 10 || description.length > 5000) {
      return res.status(400).json({ error: 'Describe the problem in 10 to 5,000 characters.' });
    }
    if ((rawCategory != null && typeof rawCategory !== 'string') || (category && category.length > 80)) {
      return res.status(400).json({ error: 'Category must be text with at most 80 characters, or left blank.' });
    }
    if (!await rateLimit(req, req.user.email, 'support-ticket')) {
      return res.status(429).json({ error: 'Too many support requests. Please try again in 15 minutes.' });
    }
    const ticket = await administrativeTransaction(async client => (await client.query(
      'INSERT INTO support_tickets(user_id,description,category) VALUES($1,$2,$3) RETURNING *',
      [req.user.id, description, category])).rows[0]);
    await recordAudit(req, 'support.ticket_opened', 'success', { status: 201, detail: { ticketId: ticket.id } });
    const notified = await notify(req, ticket.id);
    res.status(201).json({
      ticket: view(notified),
      ...(notified.email_status !== 'sent' ? { warning: 'Your ticket was saved and is visible to support, but its email notification failed. Do not submit it again; support can retry the notification.' } : {})
    });
  } catch (error) { next(error); }
});

adminSupportTickets.get('/', async (req, res, next) => {
  try {
    const status = req.query.status || '';
    const beforeId = req.query.beforeId == null ? null : parseId(req.query.beforeId);
    if ((status && !statuses.includes(status)) || (req.query.beforeId != null && !beforeId)) {
      return res.status(400).json({ error: 'Choose a valid ticket status and page cursor.' });
    }
    const rows = await administrativeTransaction(async client => (await client.query(`
      SELECT t.*,u.email,u.name FROM support_tickets t JOIN users u ON u.id=t.user_id
      WHERE ($1::text='' OR t.status=$1) AND ($2::integer IS NULL OR t.id<$2)
      ORDER BY t.id DESC LIMIT 101`, [status, beforeId])).rows);
    res.json({ tickets: rows.slice(0, 100).map(view), nextBeforeId: rows.length > 100 ? rows[99].id : null });
  } catch (error) { next(error); }
});

adminSupportTickets.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const status = req.body?.status;
    if (!id) return res.status(404).json({ error: 'Ticket not found.' });
    if (!['in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'Choose In-Progress or Resolved.' });
    const ticket = await administrativeTransaction(async client => {
      const row = (await client.query('SELECT * FROM support_tickets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) return null;
      if (statuses.indexOf(status) !== statuses.indexOf(row.status) + 1) return false;
      return (await client.query(`UPDATE support_tickets SET status=$2,updated_at=NOW(),updated_by=$3,
        resolved_at=CASE WHEN $2='resolved' THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *`,
      [id, status, req.user.id])).rows[0];
    });
    if (ticket === null) return res.status(404).json({ error: 'Ticket not found.' });
    if (ticket === false) return res.status(409).json({ error: 'Ticket status changed or the transition is invalid. Refresh; tickets move from Open to In-Progress to Resolved.' });
    await recordAudit(req, 'support.ticket_status_changed', 'success', { subjectUserId: ticket.user_id, status: 200, detail: { ticketId: id, status } });
    res.json(view(ticket));
  } catch (error) { next(error); }
});

adminSupportTickets.post('/:id/retry-email', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const exists = id && await administrativeTransaction(async client =>
      (await client.query('SELECT id FROM support_tickets WHERE id=$1', [id])).rows[0]);
    if (!exists) return res.status(404).json({ error: 'Ticket not found.' });
    const ticket = await notify(req, id);
    await recordAudit(req, 'support.ticket_email_retried', ticket.email_status === 'sent' ? 'success' : 'failure',
      { subjectUserId: ticket.user_id, status: 200, detail: { ticketId: id, emailStatus: ticket.email_status } });
    res.json({ ticket: view(ticket), ...(ticket.email_status !== 'sent' ? { warning: 'Email notification failed again. Check SMTP configuration and delivery.' } : {}) });
  } catch (error) { next(error); }
});

export default router;
