/**
 * Sovereign Logger - Debug Configuration
 * Set DEBUG = true to enable detailed execution logs in the console.
 */
export const DEBUG = false;

export const logger = {
  info: (msg, data) => {
    if (DEBUG) console.log(`[INFO] ${msg}`, data || '');
  },
  debug: (msg, data) => {
    if (DEBUG) console.debug(`[DEBUG] ${msg}`, data || '');
  },
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data || '')
};
