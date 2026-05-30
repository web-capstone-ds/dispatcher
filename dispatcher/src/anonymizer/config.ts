/**
 * Anonymization rules configuration
 */

export type AnonymizeRule =
  | { action: 'hmac' }       // HMAC-SHA256 hash
  | { action: 'remove' }     // Remove field key entirely
  | { action: 'sequence' };  // Replace with sequence number within LOT

// 정책 참조용 문서. 실제 익명화 처리는 각 anonymizeXxx() 함수에서 직접 수행.
// 이 객체를 수정해도 런타임 동작에 영향을 주지 않는다.
export const ANONYMIZE_RULES: Record<string, AnonymizeRule> = {
  equipment_id: { action: 'hmac' },
  operator_id:  { action: 'remove' },
  lot_id:       { action: 'hmac' },
  recipe_id:    { action: 'hmac' },
  strip_id:     { action: 'sequence' },
  unit_id:      { action: 'sequence' },
};
