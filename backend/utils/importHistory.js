import { currentUserId } from './tenant.js';
import { failure } from './categorization.js';
import { reconcileTransfers } from './transfers.js';

const json = value => value == null ? null : JSON.stringify(value);

// Serialise imports and recovery for a user before taking any account/transaction locks.
export async function lockImports(client) {
  await client.query('SELECT pg_advisory_xact_lock(74938122,$1::integer)', [currentUserId()]);
}

export async function beginImport(client, source, account) {
  return (await client.query(`INSERT INTO import_batches (source,account_id,statement_before)
    VALUES ($1,$2,$3::jsonb) RETURNING id`, [source, account.id, json(account.statement)])).rows[0].id;
}

export async function finishImport(client, id, result) {
  await client.query(`UPDATE import_batches b SET imported=$1,duplicates=$2,statement_after=a.statement,
    statement_changed=(b.statement_before IS DISTINCT FROM a.statement)
    FROM accounts a WHERE b.id=$3 AND a.id=b.account_id AND a.user_id=b.user_id`,
  [result.imported, result.duplicates, id]);
}

export async function importHistory(client) {
  const batches = (await client.query(`SELECT b.id,b.source,b.account_id,a.name AS account_name,b.created_at,b.status,
    b.legacy,b.imported,b.duplicates,b.statement_changed,b.undone_at,
    (SELECT COUNT(*)::int FROM transactions t WHERE t.import_batch_id=b.id AND t.user_id=b.user_id) AS active_rows,
    jsonb_array_length(b.backup) AS backup_rows
    FROM import_batches b LEFT JOIN accounts a ON a.id=b.account_id AND a.user_id=b.user_id
    ORDER BY b.created_at DESC,b.id DESC`)).rows;
  const untracked = (await client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE import_batch_id IS NULL')).rows[0].count;
  return { batches, untracked };
}

export async function changeImports(client, ids, action) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
    ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw failure(400, 'Select between 1 and 100 distinct imports.');
  }
  if (!['undo', 'restore'].includes(action)) throw failure(400, 'Choose undo or restore.');
  await lockImports(client);
  const batches = (await client.query(`SELECT * FROM import_batches WHERE id=ANY($1::int[])
    ORDER BY created_at,id FOR UPDATE`, [ids])).rows;
  if (batches.length !== ids.length) throw failure(404, 'One or more imports were not found.');
  if (action === 'undo') batches.reverse();
  let affected = 0;
  for (const batch of batches) {
    if (batch.status !== (action === 'undo' ? 'active' : 'undone')) {
      throw failure(409, 'An import has already changed. Refresh the history and try again.');
    }
    if (batch.statement_changed) {
      const expected = action === 'undo' ? batch.statement_after : batch.statement_before;
      const replacement = action === 'undo' ? batch.statement_before : batch.statement_after;
      const account = (await client.query(`SELECT id FROM accounts WHERE id=$1
        AND statement IS NOT DISTINCT FROM $2::jsonb FOR UPDATE`, [batch.account_id, json(expected)])).rows[0];
      if (!account) throw failure(409, 'The account statement has changed. Undo newer imports first, or restore older imports first.');
      await client.query('UPDATE accounts SET statement=$1::jsonb,updated_at=NOW() WHERE id=$2',
        [json(replacement), batch.account_id]);
    }
    if (action === 'undo') {
      const rows = (await client.query(`SELECT * FROM transactions WHERE import_batch_id=$1 ORDER BY id FOR UPDATE`, [batch.id])).rows;
      // Legitimate repeated purchases can span imports. Remember matching rows that already existed,
      // so restore rejects replacement imports without rejecting those original occurrences.
      await client.query(`UPDATE import_batches SET backup=$1::jsonb,status='undone',undone_at=NOW(),
        restore_guard=COALESCE((SELECT jsonb_agg(DISTINCT t.id) FROM transactions t,
          jsonb_populate_recordset(NULL::transactions,$1::jsonb) r
          WHERE t.import_batch_id IS DISTINCT FROM $2
            AND t.account_id IS NOT DISTINCT FROM r.account_id AND t.date::date=r.date::date
            AND t.amount=r.amount AND t.direction=r.direction
            AND UPPER(BTRIM(regexp_replace(t.description,'[[:space:]]+',' ','g')))=
              UPPER(BTRIM(regexp_replace(r.description,'[[:space:]]+',' ','g')))), '[]'::jsonb)
        WHERE id=$2`,
        [JSON.stringify(rows), batch.id]);
      await client.query('DELETE FROM transactions WHERE import_batch_id=$1', [batch.id]);
      affected += rows.length;
    } else {
      const missingReference = (await client.query(`SELECT 1 FROM jsonb_populate_recordset(NULL::transactions,$1::jsonb) r
        LEFT JOIN accounts a ON a.id=r.account_id
        LEFT JOIN transaction_labels l ON l.id=r.label_id
        WHERE (r.account_id IS NOT NULL AND a.id IS NULL) OR (r.label_id IS NOT NULL AND l.id IS NULL) LIMIT 1`,
      [JSON.stringify(batch.backup)])).rows[0];
      if (missingReference) throw failure(409, 'An account or saved label used by this backup was deleted. Reimport the original file into an existing account instead.');
      // A reimport while this batch was undone must not make restore double-count the same transactions.
      const conflict = (await client.query(`SELECT 1 FROM transactions t,
        jsonb_populate_recordset(NULL::transactions,$1::jsonb) r
        WHERE t.id=r.id OR (NOT ($2::jsonb @> jsonb_build_array(t.id))
          AND t.account_id IS NOT DISTINCT FROM r.account_id AND t.date::date=r.date::date
          AND t.amount=r.amount AND t.direction=r.direction
          AND UPPER(BTRIM(regexp_replace(t.description,'[[:space:]]+',' ','g')))=
            UPPER(BTRIM(regexp_replace(r.description,'[[:space:]]+',' ','g')))) LIMIT 1`,
      [JSON.stringify(batch.backup), JSON.stringify(batch.restore_guard)])).rows[0];
      if (conflict) throw failure(409, 'These transactions were reimported or conflict with existing history. Undo the replacement import before restoring this one.');
      await client.query('INSERT INTO transactions SELECT * FROM jsonb_populate_recordset(NULL::transactions,$1::jsonb)',
        [JSON.stringify(batch.backup)]);
      await client.query("UPDATE import_batches SET status='active',backup='[]'::jsonb,restore_guard='[]'::jsonb,undone_at=NULL WHERE id=$1", [batch.id]);
      affected += batch.backup.length;
    }
  }
  const transfers = await reconcileTransfers(client, currentUserId());
  return { success: true, action, batches: batches.length, affected, transfersChecked: transfers.changed };
}
