import * as crypto from 'node:crypto';
import * as cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { SnapshotClient, AuthSnapshot } from './snapshot_client.js';
import { LocalReplicaWriter } from './local_replica_writer.js';

const BACKOFF_DELAYS = [1000, 2000, 5000, 15000, 30000, 60000];

export class AccountSyncWorker {
  private lastVersion: number = 0;
  private attempt: number = 0;
  private snapshotClient: SnapshotClient;
  private writer: LocalReplicaWriter;

  constructor() {
    this.snapshotClient = new SnapshotClient();
    this.writer = new LocalReplicaWriter();
  }

  private validateChecksum(snapshot: AuthSnapshot): boolean {
    const calculated = crypto
      .createHash('sha256')
      .update(JSON.stringify(snapshot.users))
      .digest('hex');
    return calculated === snapshot.checksum;
  }

  private getBackoffDelay(): number {
    const base = BACKOFF_DELAYS[Math.min(this.attempt - 1, BACKOFF_DELAYS.length - 1)];
    const jitter = base * (0.8 + Math.random() * 0.4);
    return Math.round(jitter);
  }

  async runOnce(): Promise<void> {
    if (this.attempt > 8) {
      logger.error('Auth Sync Circuit Breaker: Max attempts exceeded. Skipping sync.');
      return;
    }

    try {
      const snapshot = await this.snapshotClient.fetchSnapshot(this.lastVersion);

      if (!this.validateChecksum(snapshot)) {
        throw new Error('Snapshot checksum mismatch');
      }

      await this.writer.upsertInTransaction(snapshot.users);
      
      this.lastVersion = snapshot.version;
      this.attempt = 0; // Reset on success
      logger.info({ version: this.lastVersion }, 'Auth Sync completed successfully');
    } catch (err: any) {
      this.attempt++;
      const delay = this.getBackoffDelay();
      logger.warn({ attempt: this.attempt, delay, err: err.message }, 'Auth Sync failed, retrying with backoff');
      
      if (this.attempt <= 8) {
        setTimeout(() => this.runOnce(), delay);
      }
    }
  }

  startScheduler(): void {
    const schedule = process.env.AUTH_SYNC_CRON || '*/5 * * * *';
    cron.schedule(schedule, () => {
      logger.info('Starting scheduled Auth Sync');
      this.runOnce().catch(err => logger.error({ err }, 'Auth Sync unhandled error'));
    });
    logger.info({ schedule }, 'Auth Sync Scheduler started');
  }
}

export function startAuthSyncScheduler() {
  try {
    const worker = new AccountSyncWorker();
    worker.startScheduler();
  } catch (err: any) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Auth Sync disabled after initialization failure'
    );
  }
}
