import express from 'express';
import Database from '../db.js';
import { failure } from '../utils/categorization.js';
import {
  importReviewedTransaction, loadImportCategorization, refreshImportReviewCandidates, findTransactionCandidates
} from '../utils/transactionImport.js';
import { currentUserId } from '../utils/tenant.js';
import { listTransactionDuplicates, mergeTransactionDuplicate, mergeTransactionDuplicates, mergeReviewedDuplicate } from '../utils/transactionDuplicates.js';
import { recordAudit } from '../utils/audit.js';

const router = express.Router();
const db = new Database();

router.get('/duplicates', async (req, res, next) => {
  try {
    res.json(await db.transaction(client => listTransactionDuplicates(client, req.query)));
  } catch (error) { next(error); }
});

router.post('/duplicates/merge', async (req, res, next) => {
  try {
    const result = await db.transaction(client => mergeTransactionDuplicate(client, req.body));
    await recordAudit(req, 'transaction.duplicate_merged', 'success', { detail: {
      keptTransactionId: result.keptTransactionId, removedTransactionId: result.removedTransactionId
    } });
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/duplicates/merge-bulk', async (req, res, next) => {
  try {
    const result = await db.transaction(client => mergeTransactionDuplicates(client, req.body));
    await recordAudit(req, 'transaction.duplicates_bulk_merged', 'success', { detail: {
      merged: result.merged, pairs: result.results.map(item => ({
        keptTransactionId: item.keptTransactionId, removedTransactionId: item.removedTransactionId
      }))
    } });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/reviews', async (req, res, next) => {
  try {
    const offset = Number(req.query.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw failure(400, 'Invalid review page');
    const search = String(req.query.search || '').trim().slice(0, 100);
    const mode = req.query.mode || 'all';
    if (!['all', 'flagged', 'held'].includes(mode)) throw failure(400, 'Invalid review filter');
    const filter = `r.user_id=current_setting('app.user_id')::integer AND r.status='pending'
      AND ($1='' OR POSITION(LOWER($1) IN LOWER(r.description || ' ' || r.amount::text || ' ' || r.date))>0)
      AND ($2='all' OR ($2='flagged' AND r.resolution_transaction_id IS NOT NULL)
        OR ($2='held' AND r.resolution_transaction_id IS NULL))`;
    const count = await db.get(`SELECT COUNT(*)::integer AS total,
      COUNT(*) FILTER(WHERE r.resolution_transaction_id IS NULL)::integer AS held
      FROM transaction_import_reviews r WHERE ${filter}`, [search, mode]);
    const rows = await db.all(`SELECT r.id, r.source, r.date, r.description, r.amount, r.direction,
        r.balance, r.category, r.plaid_transaction_id, r.is_pending, r.created_at,r.resolution_transaction_id,
        pa.name AS account_name,pa.mask AS account_mask,pc.institution_name AS institution,
        COALESCE((SELECT json_agg(json_build_object(
          'id', t.id, 'date', t.date, 'description', t.description,
          'amount', t.amount, 'direction', t.direction,'category',t.category,
          'accountName',a.name,'accountMask',a.last4,'institution',a.institution
        ) ORDER BY t.date DESC, t.id DESC)
        FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
        WHERE t.id = ANY(r.candidate_transaction_ids) AND t.user_id = r.user_id
          AND t.id IS DISTINCT FROM r.resolution_transaction_id), '[]'::json) AS candidates
      FROM transaction_import_reviews r
      LEFT JOIN plaid_accounts pa ON pa.account_id=r.plaid_account_id AND pa.user_id=r.user_id
      LEFT JOIN plaid_connections pc ON pc.id=pa.connection_id AND pc.user_id=r.user_id
      WHERE ${filter} ORDER BY r.created_at,r.id LIMIT 25 OFFSET $3`, [search, mode, offset]);
    res.json({ reviews: rows, total: count.total, held: count.held, offset, limit: 25 });
  } catch (error) { next(error); }
});

router.post('/reviews/:id/resolve', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid review ID');
    const action = req.body?.action;
    if (!['duplicate', 'import'].includes(action)) throw failure(400, 'Action must be duplicate or import');
    const result = await db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::integer, 193647)', [currentUserId()]);
      const review = (await client.query(`SELECT * FROM transaction_import_reviews
        WHERE id = $1 AND user_id = current_setting('app.user_id')::integer
        FOR UPDATE`, [id])).rows[0];
      if (!review) throw failure(404, 'Import review not found');
      if (review.status !== 'pending') {
        if ((action === 'duplicate' && review.status === 'duplicate' && review.matched_transaction_id === Number(req.body?.matchTransactionId))
          || (action === 'import' && ['imported', 'separate'].includes(review.status))) return { status: review.status, alreadyResolved: true };
        throw failure(409, 'This review was already resolved. Refresh the list.');
      }
      if (action === 'duplicate') {
        const candidates = await findTransactionCandidates(client, review);
        const candidateId = Number(req.body?.matchTransactionId);
        if (!Number.isSafeInteger(candidateId) || !(review.candidate_transaction_ids || []).includes(candidateId)) {
          throw failure(400, 'Choose one of the listed matching transactions before keeping only the existing record');
        }
        if (!candidates.some(row => row.id === candidateId)) {
          await refreshImportReviewCandidates(client, review);
          return { staleCandidates: true };
        }
        if (review.resolution_transaction_id) {
          await mergeReviewedDuplicate(client, review, candidateId);
          await client.query(`UPDATE transaction_import_reviews SET status='duplicate',matched_transaction_id=$2,
            resolved_at=NOW() WHERE id=$1 AND user_id=current_setting('app.user_id')::integer`, [id, candidateId]);
          return { status: 'duplicate', matchedTransactionId: candidateId };
        }
        const candidate = (await client.query(`SELECT id,plaid_transaction_id FROM transactions
          WHERE id=$1 AND user_id=current_setting('app.user_id')::integer FOR UPDATE`, [candidateId])).rows[0];
        if (!candidate) throw failure(409, 'The selected matching transaction no longer exists; refresh the review');
        if (review.plaid_transaction_id) {
          const linked = await client.query(`UPDATE transactions SET plaid_transaction_id=$1,plaid_account_id=$2
            WHERE id=$3 AND user_id=current_setting('app.user_id')::integer
              AND (plaid_transaction_id IS NULL OR plaid_transaction_id=$1)`,
          [review.plaid_transaction_id, review.plaid_account_id, candidateId]);
          if (!linked.rowCount) throw failure(409, 'The selected transaction is already linked to a different Plaid transaction');
        }
        await client.query(`UPDATE transaction_import_reviews
          SET status='duplicate',matched_transaction_id=$2,resolved_at=NOW() WHERE id=$1`,
        [id, candidateId]);
        return { status: 'duplicate', matchedTransactionId: candidateId };
      }
      if (review.resolution_transaction_id) {
        await client.query(`UPDATE transaction_import_reviews SET status='separate',resolved_at=NOW()
          WHERE id=$1 AND user_id=current_setting('app.user_id')::integer`, [id]);
        return { status: 'separate', transactionId: review.resolution_transaction_id };
      }
      const config = await loadImportCategorization(client);
      const transactionId = await importReviewedTransaction(client, review, config);
      await client.query(`UPDATE transaction_import_reviews
        SET status='separate', resolution_transaction_id=$2, resolved_at=NOW() WHERE id=$1`,
      [id, transactionId]);
      return { status: 'separate', transactionId };
    });
    if (result.staleCandidates) {
      return res.status(409).json({
        success: false,
        error: 'Possible transaction matches have changed. Review the updated matches before deciding.'
      });
    }
    if (!result.alreadyResolved) await recordAudit(req, 'transaction.import_review_resolved', 'success', {
      detail: { reviewId: id, action, transactionId: result.transactionId ?? result.matchedTransactionId }
    });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

export default router;
