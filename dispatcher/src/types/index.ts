/**
 * Dispatcher Server Type Definitions
 */

/**
 * RawLotRecord: DB(inspection_results)에서 읽어온 원본 레코드 (비식별화 전)
 */
export interface RawLotRecord {
  time: string;
  message_id: string;
  equipment_id: string;
  lot_id: string;
  unit_id: string;
  strip_id: string;
  recipe_id: string;
  recipe_version: string;
  operator_id?: string;
  overall_result: string;
  fail_reason_code: string;
  fail_count: number;
  total_inspected_count: number;
  inspection_duration_ms: number;
  takt_time_ms: number;
  algorithm_version: string;
  inspection_detail: unknown;
  geometric: unknown;
  bga: unknown;
  surface: unknown;
  singulation: unknown;
}

/**
 * RawLotSummary: DB(lot_ends)에서 읽어온 원본 LOT 요약 레코드
 */
export interface RawLotSummary {
  time: string;
  message_id: string;
  equipment_id: string;
  lot_id: string;
  lot_status: string;
  recipe_id: string;
  operator_id?: string;
  total_units: number;
  pass_count: number;
  fail_count: number;
  yield_pct: number;
  lot_duration_sec: number;
}

/**
 * RawOracleAnalysis: DB(oracle_analysis)에서 읽어온 Oracle 2차 검증 결과
 */
export interface RawOracleAnalysis {
  time: string;
  message_id: string;
  equipment_id: string;
  lot_id: string;
  analysis_result: string;
  confidence: number;
  reviewer_comment?: string;
  [key: string]: unknown;
}

/**
 * RawStatusHistory: DB(status_history)에서 읽어온 장비 상태 변경 이력
 */
export interface RawStatusHistory {
  time: string;
  message_id: string;
  equipment_id: string;
  operator_id?: string;
  status: string;
  prev_status?: string;
  reason_code?: string;
  [key: string]: unknown;
}

/**
 * RawAlarmHistory: DB(alarm_history)에서 읽어온 알람/에러 이력
 */
export interface RawAlarmHistory {
  time: string;
  message_id: string;
  equipment_id: string;
  alarm_code: string;
  alarm_level: string;
  hw_error_detail?: string;
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
  message_id: string;
  lotHash: string;
  equipmentHash: string;
  strip_id: number; // Replaced with sequence
  unit_id: number;  // Replaced with sequence
  overall_result: string;
  time: string;
  [key: string]: unknown;
}

/**
 * AnonymizedOracleAnalysis: 비식별화 완료된 Oracle 분석 결과
 */
export interface AnonymizedOracleAnalysis {
  message_id: string;
  lotHash: string;
  equipmentHash: string;
  time: string;
  [key: string]: unknown;
}

/**
 * AnonymizedStatusHistory: 비식별화 완료된 장비 상태 이력
 */
export interface AnonymizedStatusHistory {
  message_id: string;
  equipmentHash: string;
  time: string;
  [key: string]: unknown;
}

/**
 * AnonymizedAlarmHistory: 비식별화 완료된 알람 이력
 */
export interface AnonymizedAlarmHistory {
  message_id: string;
  equipmentHash: string;
  time: string;
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
  oracleAnalysis: AnonymizedOracleAnalysis[];
  statusHistory: AnonymizedStatusHistory[];
  alarmHistory: AnonymizedAlarmHistory[];
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
