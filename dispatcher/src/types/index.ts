/**
 * Dispatcher Server Type Definitions
 */

/**
 * RawLotRecord: DB에서 읽어온 원본 LOT 레코드 (비식별화 전)
 */
export interface RawLotRecord {
  id: number;
  equipment_id: string;
  operator_id?: string;
  lot_id: string;
  strip_id: string;
  unit_id: string;
  inspection_result?: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * AnonymizedLotRecord: 비식별화 완료된 전송용 페이로드 (operator_id 필드 없음)
 */
export interface AnonymizedLotRecord {
  lotHash: string;
  equipmentHash: string;
  // operator_id is removed
  [key: string]: unknown;
}

/**
 * AnonymizedInspectionRecord: 비식별화 완료된 INSPECTION_RESULT 단건
 */
export interface AnonymizedInspectionRecord {
  id: number;
  lotHash: string;
  equipmentHash: string;
  strip_id: number; // Replaced with sequence
  unit_id: number;  // Replaced with sequence
  inspection_result?: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * AI 서버로 전송하는 배치 단위
 */
export interface DispatchBatch {
  batchId: string;          // UUID v4
  dispatchedAt: string;     // ISO 8601 UTC
  lotHash: string;          // lot_id HMAC 해시
  equipmentHash: string;    // equipment_id HMAC 해시
  totalRecords: number;
  records: AnonymizedInspectionRecord[];
  lotSummary: AnonymizedLotRecord;
}

/**
 * Push 결과
 */
export interface PushResult {
  success: boolean;
  attempt: number;
  statusCode?: number;
  error?: string;
}

/**
 * Dead letter 레코드
 */
export interface DeadLetterEntry {
  failedAt: string;
  batchId: string;
  lotHash: string;
  attempts: number;
  lastError: string;
  payload: DispatchBatch;
}
