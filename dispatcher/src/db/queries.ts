import fs from 'node:fs/promises';
import { pool } from './pool.js';
import { RawLotRecord } from '../types/index.js';
import { hmacSha256 } from '../anonymizer/anonymizer.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = Number(process.env.BATCH_PAGE_SIZE ?? 500);

/**
 * Fetch LOT_END records with cursor pagination
 * Optimization: Moves connect/release outside the loop
 */
export async function* fetchLotRecordsCursor(
  lotId: string
): AsyncGenerator<RawLotRecord[], void, unknown> {
  const lotHash = hmacSha256(lotId);
  let lastId = 0;

  const client = await pool.connect();
  try {
    while (true) {
      const { rows } = await client.query<RawLotRecord>(
        'SELECT * FROM inspection_results WHERE lot_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3',
        [lotId, lastId, PAGE_SIZE]
      );

      if (rows.length === 0) break;
      
      yield rows;

      if (rows.length < PAGE_SIZE) break;
      lastId = rows[rows.length - 1].id;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ lotHash, message }, 'Error fetching lot records');
    throw err;
  } finally {
    client.release();
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
 * Fetch list of pending (unsent) LOTs
 * Uses local file sent_lots.jsonl to filter dispatched LOTs
 */
export async function fetchPendingLots(): Promise<{ lotId: string; equipmentId: string }[]> {
  const sentLotsPath = process.env.SENT_LOTS_PATH ?? './sent_lots.jsonl';
  const sentLotHashes = new Set<string>();

  // 1. Load already sent lot hashes from file
  try {
    const content = await fs.readFile(sentLotsPath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { lotHash } = JSON.parse(line);
        if (lotHash) sentLotHashes.add(lotHash);
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.error({ message: err.message }, 'Error reading sent_lots.jsonl');
    }
  }

  // 2. Fetch all lots from DB and filter
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ lot_id: string; equipment_id: string }>(
      'SELECT lot_id, equipment_id FROM lot_end ORDER BY created_at ASC'
    );
    
    return rows
      .filter(r => !sentLotHashes.has(hmacSha256(r.lot_id)))
      .map(r => ({
        lotId: r.lot_id,
        equipmentId: r.equipment_id
      }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ message }, 'Error fetching pending lots');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark LOT as dispatched using local file append
 * (Replaces DB UPDATE to maintain read-only DB compatibility)
 */
export async function markLotDispatched(lotId: string): Promise<void> {
  const sentLotsPath = process.env.SENT_LOTS_PATH ?? './sent_lots.jsonl';
  const lotHash = hmacSha256(lotId);
  
  const entry = JSON.stringify({
    lotHash,
    dispatchedAt: new Date().toISOString()
  }) + '\n';

  try {
    await fs.appendFile(sentLotsPath, entry, 'utf-8');
    logger.info({ lotHash }, 'Marked lot as dispatched (file-based)');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ lotHash, message }, 'Error marking lot as dispatched to file');
    throw err;
  }
}
