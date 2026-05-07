import fs from 'node:fs/promises';
import { pool } from './pool.js';
import {
  RawLotRecord,
  RawLotSummary,
  RawOracleAnalysis,
  RawStatusHistory,
  RawAlarmHistory,
} from '../types/index.js';
import { hmacSha256 } from '../anonymizer/anonymizer.js';
import { logger } from '../utils/logger.js';

const PAGE_SIZE = Number(process.env.BATCH_PAGE_SIZE ?? 500);

/**
 * Fetch LOT_END (inspection_results) records with cursor pagination
 * cursor 기준: message_id (TEXT)
 */
export async function* fetchLotRecordsCursor(
  lotId: string
): AsyncGenerator<RawLotRecord[], void, unknown> {
  const lotHash = hmacSha256(lotId);
  let lastTime = '1970-01-01T00:00:00.000Z';
  let lastMessageId = '';

  const client = await pool.connect();
  try {
    while (true) {
      const { rows } = await client.query<RawLotRecord>(
        'SELECT * FROM inspection_results WHERE lot_id = $1 AND (time > $2 OR (time = $2 AND message_id > $3)) ORDER BY time ASC, message_id ASC LIMIT $4',
        [lotId, lastTime, lastMessageId, PAGE_SIZE]
      );

      if (rows.length === 0) break;
      
      yield rows;

      if (rows.length < PAGE_SIZE) break;
      const lastRow = rows[rows.length - 1];
      lastTime = lastRow.time;
      lastMessageId = lastRow.message_id;
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
 * Fetch LOT summary (lot_ends table)
 */
export async function fetchLotSummary(lotId: string): Promise<RawLotSummary | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<RawLotSummary>(
      'SELECT * FROM lot_ends WHERE lot_id = $1 LIMIT 1',
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
 * Fetch Oracle 2차 검증 분석 결과 (oracle_analyses table)
 */
export async function fetchOracleAnalysis(lotId: string): Promise<RawOracleAnalysis[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<RawOracleAnalysis>(
      'SELECT * FROM oracle_analyses WHERE lot_id = $1 ORDER BY time ASC',
      [lotId]
    );
    return rows;
  } catch (err: unknown) {
    const lotHash = hmacSha256(lotId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ lotHash, message }, 'Error fetching oracle analysis');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch 장비 상태 변경 이력 (status_history table)
 * LOT 처리 기간 동안의 상태 변화를 조회한다.
 */
export async function fetchStatusHistory(
  equipmentId: string,
  startTime: string,
  endTime: string
): Promise<RawStatusHistory[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<RawStatusHistory>(
      'SELECT * FROM status_updates WHERE equipment_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time ASC',
      [equipmentId, startTime, endTime]
    );
    return rows;
  } catch (err: unknown) {
    const equipmentHash = hmacSha256(equipmentId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ equipmentHash, message }, 'Error fetching status history');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch 알람/에러 이력 (alarm_history table)
 * LOT 처리 기간 동안 발생한 알람을 조회한다.
 */
export async function fetchAlarmHistory(
  equipmentId: string,
  startTime: string,
  endTime: string
): Promise<RawAlarmHistory[]> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<RawAlarmHistory>(
      'SELECT * FROM hw_alarms WHERE equipment_id = $1 AND time BETWEEN $2 AND $3 ORDER BY time ASC',
      [equipmentId, startTime, endTime]
    );
    return rows;
  } catch (err: unknown) {
    const equipmentHash = hmacSha256(equipmentId);
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ equipmentHash, message }, 'Error fetching alarm history');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch list of pending (unsent) LOTs from lot_ends
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
      'SELECT lot_id, equipment_id FROM lot_ends ORDER BY time ASC'
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
