import { Router } from 'express';
import { getRecentLogs, log } from '../utils/logger.js';
import Database from '../db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

const router = Router();
const db = new Database();

/**
 * GET /api/logs?lines=N
 * Get recent log lines (default 100)
 */
router.get('/logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 100;
    const logs = getRecentLogs(lines);
    
    res.json({
      success: true,
      logs,
      total: logs.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error fetching logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/file?date=YYYY-MM-DD&lines=N
 * Get logs from a specific date file
 */
router.get('/logs/file', (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const lines = parseInt(req.query.lines) || 500;
    const logFile = path.join(logsDir, `app-${date}.log`);

    if (!fs.existsSync(logFile)) {
      return res.status(404).json({
        success: false,
        error: `No logs found for date: ${date}`
      });
    }

    const content = fs.readFileSync(logFile, 'utf-8');
    const logLines = content.split('\n').filter(line => line.trim());
    const recentLines = logLines.slice(-lines);

    res.json({
      success: true,
      date,
      file: `app-${date}.log`,
      logs: recentLines,
      total: recentLines.length,
      fileSize: `${(fs.statSync(logFile).size / 1024).toFixed(2)} KB`
    });
  } catch (err) {
    log('LOGS_API', `❌ Error fetching log file: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/filter?module=CSV_IMPORT&lines=N
 * Filter logs by module
 */
router.get('/logs/filter', (req, res) => {
  try {
    const module = req.query.module || '';
    const lines = parseInt(req.query.lines) || 200;
    const allLogs = getRecentLogs(500);

    const filtered = allLogs
      .filter(log => log.includes(`[${module}]`) || !module)
      .slice(-lines);

    res.json({
      success: true,
      module: module || 'all',
      logs: filtered,
      total: filtered.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error filtering logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/errors?lines=N
 * Get only error logs
 */
router.get('/logs/errors', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 100;
    const allLogs = getRecentLogs(1000);

    const errors = allLogs
      .filter(log => log.includes('❌') || log.includes('ERROR') || log.includes('error'))
      .slice(-lines);

    res.json({
      success: true,
      logs: errors,
      total: errors.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error fetching error logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/imports
 * Get all CSV import logs
 */
router.get('/logs/imports', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 500;
    const allLogs = getRecentLogs(2000);

    const imports = allLogs
      .filter(log => log.includes('[CSV_IMPORT]'))
      .slice(-lines);

    res.json({
      success: true,
      logs: imports,
      total: imports.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error fetching import logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/health
 * Health check endpoint with database and system info
 */
router.get('/health', async (req, res) => {
  try {
    const dbHealth = await db.get('SELECT COUNT(*) as count FROM transactions');
    const memory = process.memoryUsage();
    const uptime = process.uptime();

    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: `${Math.floor(uptime / 60)} minutes`,
      database: {
        connected: !!dbHealth,
        transactionCount: dbHealth?.count || 0
      },
      memory: {
        heapUsed: `${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`
      },
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });
  } catch (err) {
    log('HEALTH', `❌ Health check failed: ${err.message}`);
    res.status(500).json({ 
      success: false,
      status: 'unhealthy',
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/summary
 * Get a summary of recent activity
 */
router.get('/logs/summary', async (req, res) => {
  try {
    const allLogs = getRecentLogs(1000);
    
    // Count by module
    const modules = {};
    allLogs.forEach(log => {
      const match = log.match(/\[([A-Z_]+)\]/);
      if (match) {
        const module = match[1];
        modules[module] = (modules[module] || 0) + 1;
      }
    });

    // Count errors
    const errors = allLogs.filter(l => l.includes('❌')).length;
    const warnings = allLogs.filter(l => l.includes('⚠️')).length;
    const success = allLogs.filter(l => l.includes('✓')).length;

    // Database stats
    const dbStats = {
      transactions: await db.get('SELECT COUNT(*) as count FROM transactions'),
      users: await db.get('SELECT COUNT(*) as count FROM users')
    };

    res.json({
      success: true,
      summary: {
        totalLogs: allLogs.length,
        errors,
        warnings,
        success,
        modules
      },
      database: {
        transactions: dbStats.transactions?.count || 0,
        users: dbStats.users?.count || 0
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error generating summary: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/list
 * List all available log files
 */
router.get('/logs/list', (req, res) => {
  try {
    if (!fs.existsSync(logsDir)) {
      return res.json({
        success: true,
        files: [],
        message: 'No log files found'
      });
    }

    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('app-') && f.endsWith('.log'))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(logsDir, f));
        return {
          file: f,
          size: `${(stat.size / 1024).toFixed(2)} KB`,
          modified: new Date(stat.mtime).toISOString()
        };
      });

    res.json({
      success: true,
      files,
      total: files.length
    });
  } catch (err) {
    log('LOGS_API', `❌ Error listing log files: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/logs/search?q=query&lines=N
 * Search logs for a specific string
 */
router.get('/logs/search', (req, res) => {
  try {
    const query = req.query.q || '';
    const lines = parseInt(req.query.lines) || 200;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query parameter "q" is required'
      });
    }

    const allLogs = getRecentLogs(2000);
    const results = allLogs
      .filter(log => log.toLowerCase().includes(query.toLowerCase()))
      .slice(-lines);

    res.json({
      success: true,
      query,
      logs: results,
      total: results.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error searching logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * POST /api/logs/clear
 * Clear old log files (older than N days)
 */
router.post('/logs/clear', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    if (!fs.existsSync(logsDir)) {
      return res.json({
        success: true,
        cleared: 0,
        message: 'No log directory found'
      });
    }

    const files = fs.readdirSync(logsDir);
    let cleared = 0;

    files.forEach(f => {
      if (f.startsWith('app-') && f.endsWith('.log')) {
        const filePath = path.join(logsDir, f);
        const stat = fs.statSync(filePath);
        if (stat.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          cleared++;
          log('LOGS_API', `🗑️ Cleared old log file: ${f}`);
        }
      }
    });

    res.json({
      success: true,
      cleared,
      olderThanDays: days,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    log('LOGS_API', `❌ Error clearing logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

export default router;
