import { fetch } from 'undici';
import { DispatchBatch, PushResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

const BACKOFF_STEPS = (process.env.BACKOFF_STEPS_SEC ?? '1,2,5,15,30,60')
  .split(',')
  .map(Number);
const MAX_ATTEMPTS = Number(process.env.BACKOFF_MAX_ATTEMPTS ?? 6);
const AI_SERVER_URL = process.env.AI_SERVER_URL;
const AI_SERVER_API_KEY = process.env.AI_SERVER_API_KEY ?? '';
const REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 10000);

/**
 * Calculate backoff delay with ±20% jitter
 */
function getBackoffDelay(attempt: number): number {
  const baseSec = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)];
  const baseMs = baseSec * 1000;
  // jitter ±20%: range [0.8, 1.2]
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseMs * jitter);
}

/**
 * Push batch to AI server with retry logic
 */
export async function pushBatch(batch: DispatchBatch): Promise<PushResult> {
  if (!AI_SERVER_URL) {
    throw new Error('AI_SERVER_URL environment variable is not set');
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(AI_SERVER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': AI_SERVER_API_KEY,
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        return { success: true, attempt, statusCode: res.status };
      }

      // 4xx error: Client error, do not retry
      if (res.status >= 400 && res.status < 500) {
        logger.error(
          { lotHash: batch.lotHash, statusCode: res.status },
          `Push failed with client error: ${res.status}`
        );
        return { success: false, attempt, statusCode: res.status, error: `Client error: ${res.status}` };
      }

      // 5xx or other non-ok: log and retry
      logger.warn(
        { lotHash: batch.lotHash, statusCode: res.status, attempt: attempt + 1 },
        `Push attempt ${attempt + 1} failed with status ${res.status}`
      );

    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const message = err instanceof Error ? err.message : String(err);
      
      logger.warn(
        { lotHash: batch.lotHash, attempt: attempt + 1, error: message },
        `Push attempt ${attempt + 1} failed: ${message}`
      );
    }

    // Wait before next retry
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = getBackoffDelay(attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return { 
    success: false, 
    attempt: MAX_ATTEMPTS, 
    error: 'Max retry attempts exceeded' 
  };
}
