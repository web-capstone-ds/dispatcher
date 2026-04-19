import 'dotenv/config';
import { validateConnection, pool } from './db/pool.js';
import { startScheduler } from './scheduler/lotScheduler.js';
import { logger } from './utils/logger.js';

/**
 * Validate required environment variables
 */
function validateEnv(): void {
  const REQUIRED_ENV = [
    'HMAC_SECRET',
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'AI_SERVER_URL'
  ];

  const missing = REQUIRED_ENV.filter(key => !process.env[key]);
  if (missing.length > 0) {
    logger.error({ missing }, 'Missing required environment variables');
    process.exit(1);
  }
}

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  try {
    // 1. Validate environment variables
    validateEnv();

    // 2. Validate database connection (read-only)
    await validateConnection();

    // 3. Start batch scheduler
    startScheduler();

    logger.info('Dispatcher server initialized and running');

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.fatal({ message }, 'Failed to start dispatcher server');
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal. Closing resources...');
  try {
    // Close DB connection pool
    await pool.end();
    logger.info('Resources closed successfully. Exiting.');
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ message }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// Register shutdown signals
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start app
main();
