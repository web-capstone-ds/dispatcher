import crypto from 'node:crypto';
import {
  RawLotRecord,
  RawLotSummary,
  RawOracleAnalysis,
  RawStatusHistory,
  RawAlarmHistory,
  AnonymizedLotRecord,
  AnonymizedInspectionRecord,
  AnonymizedOracleAnalysis,
  AnonymizedStatusHistory,
  AnonymizedAlarmHistory,
  DispatchBatch,
} from '../types/index.js';

const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
  throw new Error('HMAC_SECRET environment variable is not set');
}

// Explicit narrowing for TypeScript
const secret: string = HMAC_SECRET;

// equipment_id 비식별화 모드. plaintext면 원본+해시 병행, hmac이면 해시만.
type EquipmentIdMode = 'plaintext' | 'hmac';
const RAW_MODE = (process.env.EQUIPMENT_ID_MODE ?? 'hmac').toLowerCase();
if (RAW_MODE !== 'plaintext' && RAW_MODE !== 'hmac') {
  throw new Error(
    `Invalid EQUIPMENT_ID_MODE: "${process.env.EQUIPMENT_ID_MODE}". Must be 'plaintext' or 'hmac'`
  );
}
const EQUIPMENT_ID_MODE: EquipmentIdMode = RAW_MODE;
const isPlaintext = EQUIPMENT_ID_MODE === 'plaintext';

/**
 * Generate consistent HMAC-SHA256 hash
 */
export function hmacSha256(value: string): string {
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
  if (raw.equipment_id) {
    anonymized.equipmentHash = hmacSha256(raw.equipment_id);
    if (isPlaintext) anonymized.equipmentId = raw.equipment_id;
  }

  // 2. Remove fields (security requirement)
  delete anonymized.operator_id;
  delete anonymized.lot_id;
  delete anonymized.equipment_id;

  // 3. Replace sequence IDs with numeric sequences
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
 * Anonymize Oracle 2차 검증 분석 결과
 * - lot_id, equipment_id → HMAC 해시
 * - operator_id → 제거 (혹시 컬럼이 추가되더라도 안전하게 차단)
 */
export function anonymizeOracleAnalysis(raw: RawOracleAnalysis): AnonymizedOracleAnalysis {
  const anonymized = { ...raw } as Record<string, unknown>;

  if (raw.lot_id) anonymized.lotHash = hmacSha256(raw.lot_id);
  if (raw.equipment_id) {
    anonymized.equipmentHash = hmacSha256(raw.equipment_id);
    if (isPlaintext) anonymized.equipmentId = raw.equipment_id;
  }

  delete anonymized.operator_id;
  delete anonymized.lot_id;
  delete anonymized.equipment_id;

  return anonymized as AnonymizedOracleAnalysis;
}

/**
 * Anonymize 장비 상태 변경 이력 (status_updates)
 * - equipment_id → HMAC 해시
 * - operator_id → 제거
 * - equipment_status: 그대로 통과 (식별자 아님)
 */
export function anonymizeStatusHistory(raw: RawStatusHistory): AnonymizedStatusHistory {
  const anonymized = { ...raw } as Record<string, unknown>;

  if (raw.equipment_id) {
    anonymized.equipmentHash = hmacSha256(raw.equipment_id);
    if (isPlaintext) anonymized.equipmentId = raw.equipment_id;
  }

  delete anonymized.operator_id;
  delete anonymized.equipment_id;

  return anonymized as AnonymizedStatusHistory;
}

/**
 * Anonymize 알람/에러 이력 (hw_alarms)
 * - equipment_id → HMAC 해시
 * - operator_id → 제거 (스키마에 없더라도 방어적으로 차단)
 * - hw_error_code, alarm_level, auto_recovery_attempted, burst_count: 그대로 통과
 * - burst_id: 알람 버스트 그룹 식별자. 장비/작업자 식별자 아니므로 그대로 통과
 *
 * TODO(보안 검토 필요): hw_error_detail 필드는 자유 텍스트 형태로 작업자 메시지나
 * 시리얼 번호 등 PII가 포함될 가능성이 있다. 운영팀과 샘플 데이터 분석 후
 * 정규식 필터링 또는 마스킹 정책을 추가 적용해야 한다.
 */
export function anonymizeAlarmHistory(raw: RawAlarmHistory): AnonymizedAlarmHistory {
  const anonymized = { ...raw } as Record<string, unknown>;

  if (raw.equipment_id) {
    anonymized.equipmentHash = hmacSha256(raw.equipment_id);
    if (isPlaintext) anonymized.equipmentId = raw.equipment_id;
  }

  delete anonymized.operator_id;
  delete anonymized.equipment_id;

  return anonymized as AnonymizedAlarmHistory;
}

/**
 * Anonymize entire batch
 */
export function anonymizeBatch(
  lotId: string,
  equipmentId: string,
  records: RawLotRecord[],
  summary: RawLotSummary,
  oracleAnalysis: RawOracleAnalysis[],
  statusHistory: RawStatusHistory[],
  alarmHistory: RawAlarmHistory[]
): DispatchBatch {
  const lotHash = hmacSha256(lotId);
  const equipmentHash = hmacSha256(equipmentId);

  const sequenceMaps = {
    strip: new Map<string, number>(),
    unit: new Map<string, number>(),
  };

  const anonymizedRecords = records.map(rec => anonymizeRecord(rec, sequenceMaps));

  // Anonymize LOT summary
  const anonymizedSummary = { ...summary } as Record<string, unknown>;
  anonymizedSummary.lotHash = lotHash;
  anonymizedSummary.equipmentHash = equipmentHash;
  if (isPlaintext) anonymizedSummary.equipmentId = equipmentId;
  delete anonymizedSummary.operator_id;
  delete anonymizedSummary.lot_id;
  delete anonymizedSummary.equipment_id;

  const lotSummary: AnonymizedLotRecord = anonymizedSummary as AnonymizedLotRecord;

  const batch: DispatchBatch = {
    batchId: crypto.randomUUID(),
    dispatchedAt: new Date().toISOString(),
    lotHash,
    equipmentHash,
    totalRecords: anonymizedRecords.length,
    records: anonymizedRecords,
    lotSummary,
    oracleAnalysis: oracleAnalysis.map(anonymizeOracleAnalysis),
    statusHistory: statusHistory.map(anonymizeStatusHistory),
    alarmHistory: alarmHistory.map(anonymizeAlarmHistory),
  };

  if (isPlaintext) batch.equipmentId = equipmentId;

  return batch;
}
