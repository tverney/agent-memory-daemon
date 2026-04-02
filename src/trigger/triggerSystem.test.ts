import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateTrigger } from './triggerSystem.js';
import type { MemconsolidateConfig } from '../types.js';

// --- Mocks ---

vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

const mockCheckTimeGate = vi.fn<(lastConsolidatedAt: number, minHours: number) => boolean>();
vi.mock('./timeGate.js', () => ({
  checkTimeGate: (...args: [number, number]) => mockCheckTimeGate(...args),
}));

const mockCheckSessionGate = vi.fn<
  (dir: string, ts: number, min: number) => Promise<{ passed: boolean; count: number }>
>();
vi.mock('./sessionGate.js', () => ({
  checkSessionGate: (...args: [string, number, number]) => mockCheckSessionGate(...args),
}));

const mockTryAcquireLock = vi.fn<
  (dir: string, threshold: number) => Promise<{ acquired: boolean; priorMtime: number }>
>();
vi.mock('../lock/consolidationLock.js', () => ({
  tryAcquireLock: (...args: [string, number]) => mockTryAcquireLock(...args),
}));

// --- Helpers ---

function makeConfig(overrides?: Partial<MemconsolidateConfig>): MemconsolidateConfig {
  return {
    memoryDirectory: '/mem',
    sessionDirectory: '/sessions',
    minHours: 24,
    minSessions: 5,
    staleLockThresholdMs: 3_600_000,
    maxIndexLines: 200,
    maxIndexBytes: 25_000,
    llmBackend: 'openai',
    llmBackendOptions: {},
    pollIntervalMs: 60_000,
    ...overrides,
  };
}

const LAST_CONSOLIDATED = Date.now() - 48 * 3_600_000; // 48 hours ago

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Requirement 1.7: Time gate failure short-circuits (skips session + lock)
// ---------------------------------------------------------------------------
describe('short-circuit: time gate fails', () => {
  it('returns time failure and never calls session or lock gates', async () => {
    mockCheckTimeGate.mockReturnValue(false);

    const result = await evaluateTrigger(makeConfig(), LAST_CONSOLIDATED);

    expect(result).toEqual({ triggered: false, failedGate: 'time' });
    expect(mockCheckTimeGate).toHaveBeenCalledOnce();
    expect(mockCheckSessionGate).not.toHaveBeenCalled();
    expect(mockTryAcquireLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Requirement 1.8: Session gate failure short-circuits (skips lock)
// ---------------------------------------------------------------------------
describe('short-circuit: session gate fails', () => {
  it('returns session failure and never calls lock gate', async () => {
    mockCheckTimeGate.mockReturnValue(true);
    mockCheckSessionGate.mockResolvedValue({ passed: false, count: 2 });

    const result = await evaluateTrigger(makeConfig(), LAST_CONSOLIDATED);

    expect(result).toEqual({ triggered: false, failedGate: 'session', sessionCount: 2 });
    expect(mockCheckTimeGate).toHaveBeenCalledOnce();
    expect(mockCheckSessionGate).toHaveBeenCalledOnce();
    expect(mockTryAcquireLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lock gate failure
// ---------------------------------------------------------------------------
describe('lock gate fails', () => {
  it('returns lock failure when lock cannot be acquired', async () => {
    mockCheckTimeGate.mockReturnValue(true);
    mockCheckSessionGate.mockResolvedValue({ passed: true, count: 7 });
    mockTryAcquireLock.mockResolvedValue({ acquired: false, priorMtime: 0 });

    const result = await evaluateTrigger(makeConfig(), LAST_CONSOLIDATED);

    expect(result).toEqual({ triggered: false, failedGate: 'lock' });
    expect(mockTryAcquireLock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Requirement 1.1: All gates pass
// ---------------------------------------------------------------------------
describe('all gates pass', () => {
  it('returns triggered with session count and prior mtime', async () => {
    mockCheckTimeGate.mockReturnValue(true);
    mockCheckSessionGate.mockResolvedValue({ passed: true, count: 10 });
    mockTryAcquireLock.mockResolvedValue({ acquired: true, priorMtime: 12345 });

    const result = await evaluateTrigger(makeConfig(), LAST_CONSOLIDATED);

    expect(result).toEqual({
      triggered: true,
      sessionCount: 10,
      priorMtime: 12345,
    });
  });

  it('passes correct arguments to each gate', async () => {
    const config = makeConfig({ minHours: 12, minSessions: 3, staleLockThresholdMs: 999 });
    mockCheckTimeGate.mockReturnValue(true);
    mockCheckSessionGate.mockResolvedValue({ passed: true, count: 5 });
    mockTryAcquireLock.mockResolvedValue({ acquired: true, priorMtime: 0 });

    await evaluateTrigger(config, LAST_CONSOLIDATED);

    expect(mockCheckTimeGate).toHaveBeenCalledWith(LAST_CONSOLIDATED, 12);
    expect(mockCheckSessionGate).toHaveBeenCalledWith('/sessions', LAST_CONSOLIDATED, 3);
    expect(mockTryAcquireLock).toHaveBeenCalledWith('/mem', 999);
  });
});
