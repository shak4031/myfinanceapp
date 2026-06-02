/**
 * Simple logging utility
 * Usage: log('MODULE', 'message')
 */

export function log(module, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${module}] ${message}`);
}

export default { log };
