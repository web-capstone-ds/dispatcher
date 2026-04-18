import crypto from 'node:crypto';
import { 
  RawLotRecord, 
  AnonymizedLotRecord, 
  AnonymizedInspectionRecord, 
  DispatchBatch 
} from '../types/index.js';
import { ANONYMIZE_RULES } from './config.js';

/**
 * Read HMAC key from environment
 */
const getHmacSecret = (): string => {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    throw new Error('HMAC_SECRET environment variable is not set');
  }
  return secret;
};

/**
 * Generate consistent HMAC-SHA256 hash
 */
export function hmacSha256(value: string): string {
  const secret = getHmacSecret();
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Anonymize single record
 */
export function anonymizeRecord(
  raw: RawLotRecord,
  sequenceMaps: { strip: Map<string, number>; unit: Map<string, number> }
): AnonymizedInspectionRecord {
  // Create shallow copy to avoid mutating original
  const anonymized = { ...raw } as Record<string, unknown>;

  // 1. HMAC hash fields
  if (raw.lot_id) anonymized.lotHash = hmacSha256(raw.lot_id);
  if (raw.equipment_id) anonymized.equipmentHash = hmacSha256(raw.equipment_id);

  // 2. Remove fields
  delete anonymized.operator_id;
  delete anonymized.lot_id;
  delete anonymized.equipment_id;

  // 3. Replace sequence IDs
  if (raw.strip_id) {
    if (!sequenceMaps.strip.has(raw.strip_id)) {
      sequenceMaps.strip.set(raw.strip_id, sequenceMaps.strip.size + 1);
    }
    anonymized.strip_id = sequenceMaps.strip.get(raw.strip_id);
  }

  if (raw.unit_id) {
    if (!sequenceMaps.unit.has(raw.unit_id)) {
      sequenceMaps.unit.set(raw.unit_id, sequenceMaps.unit.size + 1);
    }
    anonymized.unit_id = sequenceMaps.unit.get(raw.unit_id);
  }

  return anonymized as AnonymizedInspectionRecord;
}

/**
 * Anonymize entire batch
 */
export function anonymizeBatch(
  lotId: string,
  equipmentId: string,
  records: RawLotRecord[]
): DispatchBatch {
  const lotHash = hmacSha256(lotId);
  const equipmentHash = hmacSha256(equipmentId);
  
  const sequenceMaps = {
    strip: new Map<string, number>(),
    unit: new Map<string, number>(),
  };

  const anonymizedRecords = records.map(rec => anonymizeRecord(rec, sequenceMaps));

  const lotSummary: AnonymizedLotRecord = {
    lotHash,
    equipmentHash,
    // Add other summary fields if needed, ensuring no operator_id
  };

  return {
    batchId: crypto.randomUUID(),
    dispatchedAt: new Date().toISOString(),
    lotHash,
    equipmentHash,
    totalRecords: anonymizedRecords.length,
    records: anonymizedRecords,
    lotSummary,
  };
}
