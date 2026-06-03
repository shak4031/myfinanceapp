import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from './db.js';
import auth from './routes/auth.js';
import dashboard from './routes/dashboard.js';
import transactions from './routes/transactions.js';
import debts from './routes/debts.js';
import goals from './routes/goals.js';
import importCsv from './routes/import.js';
import logsRoute from './routes/logs.js';
import { log } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Logging middleware
app.use((req, res, next) => {
  log('API', `[${req.method}] ${req.path}`);
  next();
});

// Session middleware (HTTP-only cookies)
app.use((req, res, next) => {
  const sessionId = req.cookies?.session_id;
  if (sessionId) {
    req.user = { id: 1, name: 'Shak' }; // For now, hardcoded
    log('AUTH', `User authenticated: ${req.user.name}`);
  }
  next();
});

// Routes BEFORE static files
app.use('/api/auth', auth);
app.use('/api/dashboard', dashboard);
app.use('/api/transactions', transactions);
app.use('/api/debts', debts);
app.use('/api/goals', goals);
app.use('/api/import', importCsv);
app.use('/api', logsRoute);

// Static files (after API routes)
app.use(express.static(join(__dirname, '../frontend')));

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../frontend/index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  log('ERROR', `${err.message}`);
  res.status(500).json({ error: err.message });
});

// Initialize database and start server
const db = new Database();

try {
  await db.init();
  log('SERVER', '✓ Database initialized successfully');
} catch (err) {
  log('SERVER', `❌ Database initialization failed: ${err.message}`);
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  log('SERVER', `🚀 MyFinanceApp running on port ${PORT}`);
  log('SERVER', `📊 Database: PostgreSQL (Railway)`);
  log('SERVER', `🔐 Authentication: Local (hooks for email/password ready)`);
});

export default app;
// Force redeploy 1780468671
