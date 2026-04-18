import { pool } from './pool.js';
import { RawLotRecord } from '../types/index.js';
import { hmacSha256 } from '../anonymizer/anonymizer.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = Number(process.env.BATCH_PAGE_SIZE ?? 500);

/**
 * Fetch LOT_END records with cursor pagination
 */
export async function* fetchLotRecordsCursor(
  lotId: string
): AsyncGenerator<RawLotRecord[], void, unknown> {
  const lotHash = hmacSha256(lotId);
  let lastId = 0;

  while (true) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<RawLotRecord>(
        'SELECT * FROM inspection_results WHERE lot_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3',
        [lotId, lastId, PAGE_SIZE]
      );

      if (rows.length === 0) break;
      
      yield rows;

      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ lotHash, message }, 'Error fetching lot records');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Fetch LOT summary (lot_end table)
 */
export async function fetchLotSummary(lotId: string): Promise<RawLotRecord | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<RawLotRecord>(
      'SELECT * FROM lot_end WHERE lot_id = $1 LIMIT 1',
      [lotId]
    );
    return rows[0] || null;
  } catch (err: unknown) {
    const lotHash = hmacSha256(lotId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ lotHash, message }, 'Error fetching lot summary');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch list of pending (unsent) LOTs from dispatch_log
 */
export async function fetchPendingLots(): Promise<{ lotId: string; equipmentId: string }[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ lot_id: string; equipment_id: string }>(
      'SELECT lot_id, equipment_id FROM dispatch_log WHERE is_dispatched = FALSE'
    );
    return rows.map(r => ({ lotId: r.lot_id, equipmentId: r.equipment_id }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ message }, 'Error fetching pending lots');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark LOT as dispatched in dispatch_log
 * NOTE: This will fail if DB_USER is historian_read and pool enforces read-only
 */
export async function markLotDispatched(lotId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE dispatch_log SET is_dispatched = TRUE, dispatched_at = NOW() WHERE lot_id = $1',
      [lotId]
    );
    logger.info({ lotHash: hmacSha256(lotId) }, 'Marked lot as dispatched');
  } catch (err: unknown) {
    const lotHash = hmacSha256(lotId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ lotHash, message }, 'Error marking lot as dispatched');
    throw err;
  } finally {
    client.release();
  }
}
