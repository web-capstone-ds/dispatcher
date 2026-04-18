import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { anonymizeRecord, anonymizeBatch, hmacSha256 } from '../src/anonymizer/anonymizer.js';
import { RawLotRecord } from '../src/types/index.js';

describe('anonymizer', () => {
  const mockSecret = 'test_secret_key_at_least_32_chars_long';

  beforeEach(() => {
    vi.stubEnv('HMAC_SECRET', mockSecret);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const mockRecord: RawLotRecord = {
    id: 1,
    equipment_id: 'EQUIP-001',
    operator_id: 'OP-123',
    lot_id: 'LOT-999',
    strip_id: 'STRIP-A',
    unit_id: 'UNIT-01',
    inspection_result: 'PASS',
    created_at: new Date().toISOString(),
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

  it('HMAC_SECRET 미설정 시 즉시 에러를 던져야 한다', () => {
    vi.stubEnv('HMAC_SECRET', '');
    expect(() => hmacSha256('test')).toThrow('HMAC_SECRET environment variable is not set');
  });

  it('원본 lot_id와 해시된 lot_id가 다른지 확인', () => {
    const hash = hmacSha256(mockRecord.lot_id);
    expect(hash).not.toBe(mockRecord.lot_id);
  });
});
