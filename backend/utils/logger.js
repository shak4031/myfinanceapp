const timestamp = () => new Date().toISOString().split('T')[1].split('.')[0];

export function log(category, message) {
  console.log(`[${timestamp()}] [${category.padEnd(10)}] ${message}`);
}

export function logError(category, message, error) {
  console.error(`[${timestamp()}] [${category.padEnd(10)}] ❌ ${message}`);
  if (error?.stack) console.error(error.stack);
}
