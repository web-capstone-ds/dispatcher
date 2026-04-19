import fs from 'node:fs/promises';
import { DispatchBatch, DeadLetterEntry } from '../types/index.js';
import { logger } from '../utils/logger.js';

const DEAD_LETTER_PATH = process.env.DEAD_LETTER_PATH ?? './dead_letter.jsonl';
const MAX_ATTEMPTS = Number(process.env.BACKOFF_MAX_ATTEMPTS ?? 6);

/**
 * Record failed LOT batch to local JSONL file
 */
export async function writeDeadLetter(
  batch: DispatchBatch,
  lastError: string
): Promise<void> {
  const entry: DeadLetterEntry = {
    failedAt: new Date().toISOString(),
    batchId: batch.batchId,
    lotHash: batch.lotHash, // Using lotHash, not original lot_id
    attempts: MAX_ATTEMPTS,
    lastError,
    payload: batch,
  };

  try {
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(DEAD_LETTER_PATH, line, 'utf-8');
    
    logger.error(
      { batchId: batch.batchId, lotHash: batch.lotHash, error: lastError },
      'Dead letter recorded after max attempts'
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { batchId: batch.batchId, lotHash: batch.lotHash, message },
      'Failed to write to dead_letter.jsonl'
    );
    throw err;
  }
}
