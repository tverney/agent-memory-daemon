import { describe, it, expect, vi } from 'vitest';
import { checkTimeGate } from './timeGate.js';

// Suppress logger stdout noise during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Requirement 1.2: Time gate passes when elapsed hours >= minHours
// ---------------------------------------------------------------------------
describe('checkTimeGate', () => {
  it('returns true when elapsed time equals the threshold exactly', () => {
    const minHours = 24;
    const lastConsolidatedAt = Date.now() - minHours * 3_600_000;

    expect(checkTimeGate(lastConsolidatedAt, minHours)).toBe(true);
  });

  it('returns true when elapsed time exceeds the threshold', () => {
    const minHours = 24;
    const lastConsolidatedAt = Date.now() - 48 * 3_600_000; // 48 hours ago

    expect(checkTimeGate(lastConsolidatedAt, minHours)).toBe(true);
  });

  it('returns false when elapsed time is below the threshold', () => {
    const minHours = 24;
    const lastConsolidatedAt = Date.now() - 12 * 3_600_000; // 12 hours ago

    expect(checkTimeGate(lastConsolidatedAt, minHours)).toBe(false);
  });

  it('returns true when lastConsolidatedAt is 0 (never consolidated)', () => {
    expect(checkTimeGate(0, 24)).toBe(true);
  });

  it('returns true when minHours is 0 (always passes)', () => {
    expect(checkTimeGate(Date.now(), 0)).toBe(true);
  });

  it('returns false when consolidation just happened', () => {
    expect(checkTimeGate(Date.now(), 1)).toBe(false);
  });
});
