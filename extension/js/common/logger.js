/**
 * Sovereign Logger
 */
export const logger = {
  info: () => {},
  debug: () => {},
  warn: (msg, data) => console.warn(`[WARN] ${msg}`, data || ''),
  error: (msg, data) => console.error(`[ERROR] ${msg}`, data || '')
};
