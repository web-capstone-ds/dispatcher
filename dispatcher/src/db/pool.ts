import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../utils/logger.js';

const poolConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER, // historian_read
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX ?? 5),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000),
  // Enforce read-only at the DB level
  options: '--default_transaction_read_only=on',
};

export const pool = new Pool(poolConfig);

// Register error handler to avoid unhandled exceptions
pool.on('error', (err) => {
  logger.error(err, 'Unexpected error on idle client');
});

/**
 * Validates DB connection by executing SELECT 1
 */
export async function validateConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    logger.info('Database connection validated successfully (read-only)');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ message }, 'Database connection validation failed');
    throw err;
  } finally {
    client.release();
  }
}
