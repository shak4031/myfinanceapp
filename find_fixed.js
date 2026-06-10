
import Database from './backend/db.js';
const db = new Database();

async function find() {
    try {
        const sql = `
            SELECT description, category, amount, COUNT(*) as freq, 
                   EXTRACT(DAY FROM MAX(date::date)) as day_of_month,
                   MAX(date) as last_date
            FROM transactions
            WHERE direction = 'DEBIT' 
              AND date::date >= (CURRENT_DATE - INTERVAL '6 months')
            GROUP BY description, category, amount
            HAVING COUNT(*) >= 2
            ORDER BY amount DESC;
        `;
        const rows = await db.all(sql);
        console.log(JSON.stringify(rows));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
find();
