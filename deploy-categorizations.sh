#!/bin/bash
# Deployment script for Transaction Categorization Review Page

set -e

echo "🚀 Deploying Transaction Categorization Review Page"
echo ""

# Step 1: Verify database
echo "Step 1: Verifying SQLite database..."
python3 << 'EOF'
import sqlite3
from pathlib import Path

db_path = Path('/opt/data/finance.db')
if not db_path.exists():
    print(f"❌ Database not found at {db_path}")
    exit(1)

conn = sqlite3.connect(str(db_path))
cursor = conn.cursor()

# Check main table
cursor.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='finance_transactions'")
if cursor.fetchone()[0] == 0:
    print("❌ finance_transactions table not found")
    exit(1)

# Create categorization tables
cursor.execute("""
CREATE TABLE IF NOT EXISTS categorization_status (
    txn_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    confirmed_at TEXT,
    modified_at TEXT,
    FOREIGN KEY (txn_id) REFERENCES finance_transactions(txn_id)
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS learned_categorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    usage_count INTEGER DEFAULT 1,
    UNIQUE(keyword, category)
)
""")

conn.commit()

# Get stats
cursor.execute("SELECT COUNT(*) FROM finance_transactions")
total_txns = cursor.fetchone()[0]

cursor.execute("SELECT COUNT(*) FROM categorization_status WHERE status = 'confirmed'")
confirmed = cursor.fetchone()[0]

print(f"✓ Database verified")
print(f"  - Total transactions: {total_txns}")
print(f"  - Confirmed: {confirmed}")

conn.close()
EOF

echo ""
echo "Step 2: Verifying Node.js backend..."
cd /opt/data/myfinanceapp-v2

if ! node -c backend/routes/categorizations-lite.js; then
    echo "❌ Syntax error in categorizations-lite.js"
    exit 1
fi
echo "✓ Backend module syntax OK"

if ! node -c backend/server.js; then
    echo "❌ Syntax error in server.js"
    exit 1
fi
echo "✓ Server syntax OK"

echo ""
echo "Step 3: Verifying frontend..."
if [ ! -f "frontend/categorizations-simple.html" ]; then
    echo "❌ Frontend file not found"
    exit 1
fi
echo "✓ Frontend HTML exists"

echo ""
echo "Step 4: Running tests..."
node test-categorizations-lite.js

echo ""
echo "✅ Deployment successful!"
echo ""
echo "📍 Access the page at:"
echo "   http://localhost:3000/categorizations-simple.html"
echo ""
echo "📖 Documentation: CATEGORIZATIONS_SIMPLE.md"
echo ""
