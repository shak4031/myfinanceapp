import fs from 'fs';
import Database from '../backend/db.js';
import { log } from '../backend/utils/logger.js';

const db = new Database();

async function runImport() {
    try {
        const filePath = process.argv[2];
        const csvData = fs.readFileSync(filePath, 'utf8');

        // Parse CSV
        const lines = csvData.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        
        const dateIdx = headers.indexOf('date');
        const descIdx = headers.indexOf('description');
        const withdrawalIdx = headers.indexOf('withdrawal');
        const depositIdx = headers.indexOf('deposit');
        const balanceIdx = headers.indexOf('balance');

        let imported = 0;
        let duplicates = 0;

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim());
            if (cols.length < 3) continue;

            const date = cols[dateIdx];
            const description = cols[descIdx];
            const amount = cols[withdrawalIdx] ? parseFloat(cols[withdrawalIdx]) : parseFloat(cols[depositIdx]);
            const direction = cols[withdrawalIdx] ? 'DEBIT' : 'CREDIT';
            const balance = cols[balanceIdx] ? parseFloat(cols[balanceIdx]) : null;

            // 1. Strict Deduplication
            const exist = await db.get(
                "SELECT id FROM transactions WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4 AND (balance = $5 OR $5 IS NULL)",
                [date, description, amount, direction, balance]
            );

            if (exist) {
                duplicates++;
                continue;
            }

            // 2. Automated Labeling & Categorization
            const labels = await db.all("SELECT * FROM transaction_labels");
            let labelId = null;
            let category = 'Other';

            for (const l of labels) {
                if (new RegExp(l.pattern, 'i').test(description)) {
                    labelId = l.id;
                    const catRow = await db.get("SELECT name FROM categories WHERE id = $1", [l.category_id]);
                    category = catRow?.name || 'Other';
                    break;
                }
            }

            // 3. Fallback: Auto-create Label
            if (!labelId) {
                const cleanLabel = description.replace(/\s+/g, ' ').replace(/\d{4,}/g, '').trim();
                const otherCat = await db.get("SELECT id FROM categories WHERE name = 'Other'");
                const insert = await db.pool.query(
                    "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, FALSE) RETURNING id",
                    [cleanLabel, cleanLabel, otherCat.id]
                );
                labelId = insert.rows[0].id;
            }

            // 4. Production Insert
            await db.run(
                "INSERT INTO transactions (date, description, amount, direction, balance, source, label_id, category, user_id) VALUES ($1, $2, $3, $4, $5, 'checking', $6, $7, 1)",
                [date, description, amount, direction, balance, labelId, category]
            );
            imported++;
        }

        console.log(`✅ Import Complete: ${imported} imported, ${duplicates} duplicates skipped.`);
        process.exit(0);

    } catch (err) {
        console.error('Import failed:', err);
        process.exit(1);
    }
}

runImport();
