import cron from 'node-cron';
import { 
  fetchPendingLots, 
  fetchLotRecordsCursor, 
  fetchLotSummary, 
  markLotDispatched 
} from '../db/queries.js';
import { anonymizeBatch, hmacSha256 } from '../anonymizer/anonymizer.js';
import { pushBatch } from '../push/aiClient.js';
import { writeDeadLetter } from '../push/deadLetter.js';
import { RawLotRecord } from '../types/index.js';
import { logger } from '../utils/logger.js';

/**
 * Process unsent LOTs in a 6-step pipeline
 */
export async function processUnsentLots(): Promise<void> {
  // 1. Fetch pending lots (filtered by local file sent_lots.jsonl)
  const pendingLots = await fetchPendingLots();
  
  if (pendingLots.length === 0) {
    return;
  }

  logger.info({ count: pendingLots.length }, 'Found pending lots to process');

  for (const lot of pendingLots) {
    const lotHash = hmacSha256(lot.lotId);
    const equipmentHash = hmacSha256(lot.equipmentId);

    try {
      // 2. Fetch all inspection records with cursor pagination
      const allRecords: RawLotRecord[] = [];
      for await (const page of fetchLotRecordsCursor(lot.lotId)) {
        allRecords.push(...page);
      }

      // 3. Fetch lot summary
      const summary = await fetchLotSummary(lot.lotId);
      if (!summary) {
        logger.warn({ lotHash }, 'Lot summary not found, skipping pipeline');
        continue;
      }

      // 4. Anonymize batch (HMAC hashes, remove operator_id, sequence mapping)
      // Now including the summary object for the batch payload
      const batch = anonymizeBatch(lot.lotId, lot.equipmentId, allRecords, summary);

      // 5. Push batch to AI server with retry logic
      const result = await pushBatch(batch);

      // 6. Record result (mark as dispatched locally or write to dead letter)
      if (result.success) {
        await markLotDispatched(lot.lotId);
        logger.info({ batchId: batch.batchId, lotHash, equipmentHash }, 'Batch dispatched successfully');
      } else {
        await writeDeadLetter(batch, result.error ?? 'Unknown push error');
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ lotHash, message }, 'Pipeline error processing LOT');
    }
  }
}

/**
 * Start node-cron scheduler (runs every minute)
 */
export function startScheduler(): void {
  cron.schedule('* * * * *', () => {
    processUnsentLots().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ message }, 'Scheduler encountered an error');
    });
  });
  logger.info('LOT Batch Scheduler started (1-min interval)');
}
