import { checkTimeGate } from './timeGate.js';
import { checkSessionGate } from './sessionGate.js';
import { tryAcquireLock } from '../lock/consolidationLock.js';
import { log } from '../logger.js';
import type { MemconsolidateConfig, TriggerResult } from '../types.js';

/**
 * Evaluate the three-gate trigger system in cheapest-first order:
 *   1. Time gate  — pure computation, no I/O
 *   2. Session gate — directory scan
 *   3. Lock gate  — lock file I/O + PID check
 *
 * Short-circuits on the first gate that fails (Req 1.7, 1.8).
 *
 * Validates: Requirements 1.1, 1.5, 1.6, 1.7, 1.8
 */
export async function evaluateTrigger(
  config: MemconsolidateConfig,
  lastConsolidatedAt: number,
): Promise<TriggerResult> {
  // Gate 1: Time gate (Req 1.2, 1.7)
  const timePassed = checkTimeGate(lastConsolidatedAt, config.minHours);

  if (!timePassed) {
    log('info', 'trigger.evaluate', { result: 'time_gate_failed' });
    return { triggered: false, failedGate: 'time' };
  }

  // Gate 2: Session gate (Req 1.3, 1.4, 1.8)
  const sessionResult = await checkSessionGate(
    config.sessionDirectory,
    lastConsolidatedAt,
    config.minSessions,
  );

  if (!sessionResult.passed) {
    log('info', 'trigger.evaluate', {
      result: 'session_gate_failed',
      sessionCount: sessionResult.count,
    });
    return {
      triggered: false,
      failedGate: 'session',
      sessionCount: sessionResult.count,
    };
  }

  // Gate 3: Lock gate (Req 1.5, 1.6)
  const lockResult = await tryAcquireLock(
    config.memoryDirectory,
    config.staleLockThresholdMs,
  );

  if (!lockResult.acquired) {
    log('info', 'trigger.evaluate', { result: 'lock_gate_failed' });
    return { triggered: false, failedGate: 'lock' };
  }

  // All gates passed
  log('info', 'trigger.evaluate', {
    result: 'all_gates_passed',
    sessionCount: sessionResult.count,
    priorMtime: lockResult.priorMtime,
  });

  return {
    triggered: true,
    sessionCount: sessionResult.count,
    priorMtime: lockResult.priorMtime,
  };
}
