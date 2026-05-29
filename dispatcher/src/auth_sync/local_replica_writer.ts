import pkg from 'pg';
const { Pool } = pkg;
import { logger } from '../utils/logger.js';
import { SnapshotUser } from './snapshot_client.js';

export class LocalReplicaWriter {
  private pool: pkg.Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.AUTH_SYNC_DB_HOST || 'oracle-db',
      port: Number(process.env.AUTH_SYNC_DB_PORT || 5432),
      database: process.env.AUTH_SYNC_DB_NAME || 'oracle',
      user: process.env.AUTH_SYNC_DB_USER || 'oracle',
      password: process.env.AUTH_SYNC_DB_PASSWORD,
    });

    this.pool.on('error', (err) => {
      logger.error(err, 'Unexpected error on AuthSync DB pool');
    });
  }

  async upsertInTransaction(users: SnapshotUser[]): Promise<void> {
    if (users.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const query = `
        INSERT INTO local_user_replica (operator_id, password_hash, role, active, updated_at, synced_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (operator_id) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          role          = EXCLUDED.role,
          active        = EXCLUDED.active,
          updated_at    = EXCLUDED.updated_at,
          synced_at     = NOW();
      `;

      for (const user of users) {
        await client.query(query, [
          user.operatorId,
          user.passwordHash,
          user.role,
          user.active,
          user.updatedAt,
        ]);
      }

      await client.query('COMMIT');
      logger.info({ count: users.length }, 'Successfully upserted users to local_user_replica');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err }, 'Failed to upsert users to local_user_replica, rolled back');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
