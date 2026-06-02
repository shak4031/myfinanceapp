import { Router } from 'express';
import { log } from '../utils/logger.js';

const router = Router();

// For now, hardcoded auth (hooks ready for email/password later)
router.post('/login', (req, res) => {
  log('AUTH', 'Login successful');
  res.json({ 
    success: true, 
    user: { id: 1, name: 'Shak', role: 'admin' },
    token: 'session_' + Date.now()
  });
});

router.post('/logout', (req, res) => {
  log('AUTH', 'Logout');
  res.json({ success: true });
});

export default router;
