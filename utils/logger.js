export function logInfo(message) {
  console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
}

export function logError(message, error) {
  console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
  if (error) {
    console.error(error.stack || error);
  }
}