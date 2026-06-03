import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, `app-${new Date().toISOString().split('T')[0]}.log`);

/**
 * Enhanced logging utility with file persistence
 * Usage: log('MODULE', 'message')
 */
export function log(module, message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${module}] ${message}`;
  
  // Console output
  console.log(logLine);
  
  // File output (async, non-blocking)
  fs.appendFile(logFile, logLine + '\n', (err) => {
    if (err) {
      console.error('[LOGGER] Failed to write to log file:', err.message);
    }
  });
}

/**
 * Get recent log lines for display in UI
 */
export function getRecentLogs(lines = 100) {
  try {
    if (!fs.existsSync(logFile)) {
      return [];
    }
    
    const content = fs.readFileSync(logFile, 'utf-8');
    return content.split('\n').slice(-lines).filter(line => line.trim());
  } catch (err) {
    console.error('[LOGGER] Failed to read logs:', err.message);
    return [];
  }
}

export default { log, getRecentLogs };
