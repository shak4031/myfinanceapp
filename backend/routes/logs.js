import { Router } from 'express';
import { getRecentLogs, log } from '../utils/logger.js';

const router = Router();

// Get recent logs
router.get('/logs', (req, res) => {
  try {
    const lines = parseInt(req.query.lines) || 100;
    const logs = getRecentLogs(lines);
    
    res.json({
      success: true,
      logs,
      total: logs.length
    });
  } catch (err) {
    log('LOGS_API', `❌ Error fetching logs: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

export default router;
