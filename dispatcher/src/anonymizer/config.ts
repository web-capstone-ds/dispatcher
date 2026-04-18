/**
 * Anonymization rules configuration
 */

export type AnonymizeRule =
  | { action: 'hmac' }       // HMAC-SHA256 hash
  | { action: 'remove' }     // Remove field key entirely
  | { action: 'sequence' };  // Replace with sequence number within LOT

export const ANONYMIZE_RULES: Record<string, AnonymizeRule> = {
  equipment_id: { action: 'hmac' },
  operator_id:  { action: 'remove' },
  lot_id:       { action: 'hmac' },
  strip_id:     { action: 'sequence' },
  unit_id:      { action: 'sequence' },
};
