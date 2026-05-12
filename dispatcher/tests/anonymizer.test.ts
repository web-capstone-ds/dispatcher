import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.HMAC_SECRET = 'test_secret_key_at_least_32_chars_long';
});

import {
  anonymizeRecord,
  anonymizeOracleAnalysis,
  anonymizeStatusHistory,
  anonymizeAlarmHistory,
  anonymizeBatch,
  hmacSha256,
} from '../src/anonymizer/anonymizer.js';
import {
  RawLotRecord,
  RawLotSummary,
  RawOracleAnalysis,
  RawStatusHistory,
  RawAlarmHistory,
} from '../src/types/index.js';

describe('anonymizer', () => {
  const mockRecord: RawLotRecord = {
    time: new Date().toISOString(),
    message_id: 'MSG-001',
    equipment_id: 'EQUIP-001',
    lot_id: 'LOT-999',
    unit_id: 'UNIT-01',
    strip_id: 'STRIP-A',
    recipe_id: 'RECIPE-01',
    recipe_version: '1.0',
    operator_id: 'OP-123',
    overall_result: 'PASS',
    fail_reason_code: '0',
    fail_count: 0,
    total_inspected_count: 1,
    inspection_duration_ms: 120,
    takt_time_ms: 150,
    algorithm_version: '1.2.3',
    inspection_detail: {},
    geometric: {},
    bga: {},
    surface: {},
    singulation: {},
  };

  it('operator_id 필드가 결과 객체에 존재하지 않아야 한다', () => {
    const sequenceMaps = { strip: new Map(), unit: new Map() };
    const result = anonymizeRecord(mockRecord, sequenceMaps);
    expect(result).not.toHaveProperty('operator_id');
    expect('operator_id' in result).toBe(false);
  });

  it('동일 equipment_id는 동일 해시를 반환해야 한다', () => {
    const hash1 = hmacSha256('EQUIP-001');
    const hash2 = hmacSha256('EQUIP-001');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex length
  });

  it('동일 lot_id는 동일 해시를 반환해야 한다', () => {
    const hash1 = hmacSha256('LOT-999');
    const hash2 = hmacSha256('LOT-999');
    expect(hash1).toBe(hash2);
  });

  it('strip_id는 LOT 내 순번(1부터)으로 대체되어야 한다', () => {
    const sequenceMaps = { strip: new Map(), unit: new Map() };
    const rec1 = { ...mockRecord, strip_id: 'STRIP-A' };
    const rec2 = { ...mockRecord, strip_id: 'STRIP-B' };
    const rec3 = { ...mockRecord, strip_id: 'STRIP-A' };

    const res1 = anonymizeRecord(rec1, sequenceMaps);
    const res2 = anonymizeRecord(rec2, sequenceMaps);
    const res3 = anonymizeRecord(rec3, sequenceMaps);

    expect(res1.strip_id).toBe(1);
    expect(res2.strip_id).toBe(2);
    expect(res3.strip_id).toBe(1);
  });

  it('unit_id는 LOT 내 순번(1부터)으로 대체되어야 한다', () => {
    const sequenceMaps = { strip: new Map(), unit: new Map() };
    const rec1 = { ...mockRecord, unit_id: 'UNIT-01' };
    const rec2 = { ...mockRecord, unit_id: 'UNIT-02' };

    const res1 = anonymizeRecord(rec1, sequenceMaps);
    const res2 = anonymizeRecord(rec2, sequenceMaps);

    expect(res1.unit_id).toBe(1);
    expect(res2.unit_id).toBe(2);
  });

  it('HMAC_SECRET 미설정 시 즉시 에러를 던져야 한다', async () => {
    const original = process.env.HMAC_SECRET;
    delete process.env.HMAC_SECRET;
    vi.resetModules();
    try {
      await expect(import('../src/anonymizer/anonymizer.js')).rejects.toThrow(
        /HMAC_SECRET/
      );
    } finally {
      process.env.HMAC_SECRET = original;
      vi.resetModules();
    }
  });

  it('원본 lot_id와 해시된 lot_id가 다른지 확인', () => {
    const hash = hmacSha256(mockRecord.lot_id);
    expect(hash).not.toBe(mockRecord.lot_id);
  });
});

describe('anonymizeOracleAnalysis', () => {
  const rawOracle: RawOracleAnalysis = {
    time: '2026-05-01T00:00:00.000Z',
    message_id: 'ORA-001',
    equipment_id: 'EQUIP-001',
    lot_id: 'LOT-999',
    judgment: 'PASS',
    yield_actual: 99.5,
    ai_comment: 'No anomaly',
  };

  it('lot_id / equipment_id가 해시로 치환되고 원본 키는 제거되어야 한다', () => {
    const result = anonymizeOracleAnalysis(rawOracle);
    expect(result.lotHash).toBe(hmacSha256('LOT-999'));
    expect(result.equipmentHash).toBe(hmacSha256('EQUIP-001'));
    expect('lot_id' in result).toBe(false);
    expect('equipment_id' in result).toBe(false);
  });

  it('operator_id가 포함되어 있어도 결과에서 제거되어야 한다', () => {
    const withOperator = { ...rawOracle, operator_id: 'OP-XYZ' } as RawOracleAnalysis;
    const result = anonymizeOracleAnalysis(withOperator);
    expect('operator_id' in result).toBe(false);
  });

  it('judgment / yield_actual / ai_comment 등 분석 결과 필드는 보존되어야 한다', () => {
    const result = anonymizeOracleAnalysis(rawOracle);
    expect(result.judgment).toBe('PASS');
    expect(result.yield_actual).toBe(99.5);
    expect(result.ai_comment).toBe('No anomaly');
  });
});

describe('anonymizeStatusHistory', () => {
  const rawStatus: RawStatusHistory = {
    time: '2026-05-01T00:00:00.000Z',
    message_id: 'STS-001',
    equipment_id: 'EQUIP-001',
    operator_id: 'OP-123',
    equipment_status: 'RUNNING',
  };

  it('equipment_id가 해시로 치환되고 operator_id가 제거되어야 한다', () => {
    const result = anonymizeStatusHistory(rawStatus);
    expect(result.equipmentHash).toBe(hmacSha256('EQUIP-001'));
    expect('equipment_id' in result).toBe(false);
    expect('operator_id' in result).toBe(false);
  });

  it('equipment_status는 식별자가 아니므로 그대로 보존되어야 한다', () => {
    const result = anonymizeStatusHistory(rawStatus);
    expect(result.equipment_status).toBe('RUNNING');
  });
});

describe('anonymizeAlarmHistory', () => {
  const rawAlarm: RawAlarmHistory = {
    time: '2026-05-01T00:00:00.000Z',
    message_id: 'ALM-001',
    equipment_id: 'EQUIP-001',
    hw_error_code: 'E1234',
    alarm_level: 'CRITICAL',
    hw_error_detail: 'Sensor timeout',
    auto_recovery_attempted: true,
    burst_id: 'BURST-1',
    burst_count: 3,
  };

  it('equipment_id가 해시로 치환되고 원본 키가 제거되어야 한다', () => {
    const result = anonymizeAlarmHistory(rawAlarm);
    expect(result.equipmentHash).toBe(hmacSha256('EQUIP-001'));
    expect('equipment_id' in result).toBe(false);
  });

  it('하드웨어 알람 메타데이터는 그대로 통과해야 한다', () => {
    const result = anonymizeAlarmHistory(rawAlarm);
    expect(result.hw_error_code).toBe('E1234');
    expect(result.alarm_level).toBe('CRITICAL');
    expect(result.auto_recovery_attempted).toBe(true);
    expect(result.burst_id).toBe('BURST-1');
    expect(result.burst_count).toBe(3);
  });

  it('스키마에 없더라도 operator_id가 들어오면 방어적으로 제거되어야 한다', () => {
    const withOperator = { ...rawAlarm, operator_id: 'OP-XYZ' } as RawAlarmHistory;
    const result = anonymizeAlarmHistory(withOperator);
    expect('operator_id' in result).toBe(false);
  });
});

describe('anonymizeBatch', () => {
  const batchRecord: RawLotRecord = {
    time: '2026-05-01T00:10:00.000Z',
    message_id: 'MSG-001',
    equipment_id: 'EQUIP-001',
    lot_id: 'LOT-999',
    unit_id: 'UNIT-01',
    strip_id: 'STRIP-A',
    recipe_id: 'RECIPE-01',
    recipe_version: '1.0',
    operator_id: 'OP-123',
    overall_result: 'PASS',
    fail_reason_code: '0',
    fail_count: 0,
    total_inspected_count: 1,
    inspection_duration_ms: 120,
    takt_time_ms: 150,
    algorithm_version: '1.2.3',
    inspection_detail: {},
    geometric: {},
    bga: {},
    surface: {},
    singulation: {},
  };

  const summary: RawLotSummary = {
    time: '2026-05-01T01:00:00.000Z',
    message_id: 'LOT-END-1',
    equipment_id: 'EQUIP-001',
    lot_id: 'LOT-999',
    lot_status: 'COMPLETED',
    recipe_id: 'RECIPE-01',
    operator_id: 'OP-123',
    total_units: 100,
    pass_count: 99,
    fail_count: 1,
    yield_pct: 99.0,
    lot_duration_sec: 600,
  };

  it('배치 메타데이터와 컬렉션이 모두 비식별화되어 포함되어야 한다', () => {
    const batch = anonymizeBatch(
      'LOT-999',
      'EQUIP-001',
      [batchRecord],
      summary,
      [
        {
          time: '2026-05-01T00:30:00.000Z',
          message_id: 'ORA-001',
          equipment_id: 'EQUIP-001',
          lot_id: 'LOT-999',
          judgment: 'PASS',
          yield_actual: 99.0,
        },
      ],
      [
        {
          time: '2026-05-01T00:00:00.000Z',
          message_id: 'STS-001',
          equipment_id: 'EQUIP-001',
          equipment_status: 'RUNNING',
        },
      ],
      [
        {
          time: '2026-05-01T00:15:00.000Z',
          message_id: 'ALM-001',
          equipment_id: 'EQUIP-001',
          hw_error_code: 'E1234',
          alarm_level: 'WARNING',
        },
      ]
    );

    expect(batch.lotHash).toBe(hmacSha256('LOT-999'));
    expect(batch.equipmentHash).toBe(hmacSha256('EQUIP-001'));
    expect(batch.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.totalRecords).toBe(1);
    expect(batch.records).toHaveLength(1);
    expect(batch.oracleAnalysis).toHaveLength(1);
    expect(batch.statusHistory).toHaveLength(1);
    expect(batch.alarmHistory).toHaveLength(1);
  });

  it('lotSummary에서 operator_id / lot_id / equipment_id 원본 필드가 제거되어야 한다', () => {
    const batch = anonymizeBatch('LOT-999', 'EQUIP-001', [batchRecord], summary, [], [], []);
    expect('operator_id' in batch.lotSummary).toBe(false);
    expect('lot_id' in batch.lotSummary).toBe(false);
    expect('equipment_id' in batch.lotSummary).toBe(false);
    expect(batch.lotSummary.lotHash).toBe(hmacSha256('LOT-999'));
    expect(batch.lotSummary.equipmentHash).toBe(hmacSha256('EQUIP-001'));
  });
});
