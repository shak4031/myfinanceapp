import express from 'express';
import Database from '../db.js';
import { failure } from '../utils/categorization.js';
import {
  importReviewedTransaction, loadImportCategorization, refreshImportReviewCandidates
} from '../utils/transactionImport.js';
import { currentUserId } from '../utils/tenant.js';

const router = express.Router();
const db = new Database();

router.get('/reviews', async (req, res, next) => {
  try {
    const rows = await db.all(`SELECT r.id, r.source, r.date, r.description, r.amount, r.direction,
        r.balance, r.category, r.plaid_transaction_id, r.is_pending, r.created_at,
        COALESCE((SELECT json_agg(json_build_object(
          'id', t.id, 'date', t.date, 'description', t.description,
          'amount', t.amount, 'direction', t.direction
        ) ORDER BY t.date DESC, t.id DESC)
        FROM transactions t WHERE t.id = ANY(r.candidate_transaction_ids) AND t.user_id = r.user_id), '[]'::json) AS candidates
      FROM transaction_import_reviews r
      WHERE r.user_id = current_setting('app.user_id')::integer AND r.status = 'pending'
      ORDER BY r.created_at, r.id`);
    res.json({ reviews: rows });
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
      if (!review || review.status !== 'pending') throw failure(404, 'Pending import review not found');
      if (await refreshImportReviewCandidates(client, review)) return { staleCandidates: true };
      if (action === 'duplicate') {
        const candidateId = Number(req.body?.matchTransactionId);
        if (!Number.isSafeInteger(candidateId) || !review.candidate_transaction_ids.includes(candidateId)) {
          throw failure(400, 'Choose one of the listed matching transactions before keeping only the existing record');
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
      const config = await loadImportCategorization(client);
      const transactionId = await importReviewedTransaction(client, review, config);
      await client.query(`UPDATE transaction_import_reviews
        SET status='imported', resolution_transaction_id=$2, resolved_at=NOW() WHERE id=$1`,
      [id, transactionId]);
      return { status: 'imported', transactionId };
    });
    if (result.staleCandidates) {
      return res.status(409).json({
        success: false,
        error: 'Possible transaction matches have changed. Review the updated matches before deciding.'
      });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, error: error.message });
    next(error);
  }
});

export default router;
