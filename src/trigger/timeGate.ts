import { log } from '../logger.js';

/**
 * Check whether enough time has elapsed since the last consolidation.
 *
 * Returns true when (Date.now() - lastConsolidatedAt) >= minHours * 3_600_000.
 *
 * Validates: Requirement 1.2
 */
export function checkTimeGate(lastConsolidatedAt: number, minHours: number): boolean {
  const elapsedMs = Date.now() - lastConsolidatedAt;
  const thresholdMs = minHours * 3_600_000;
  const passed = elapsedMs >= thresholdMs;

  log('info', 'trigger.time_gate', {
    lastConsolidatedAt,
    minHours,
    elapsedMs,
    thresholdMs,
    passed,
  });

  return passed;
}
