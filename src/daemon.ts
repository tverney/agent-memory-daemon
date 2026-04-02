import fs from 'node:fs/promises';
import { log } from './logger.js';
import { validateConfig } from './config.js';
import { evaluateTrigger } from './trigger/triggerSystem.js';
import { readLockState, releaseLock, rollbackLock } from './lock/consolidationLock.js';
import { runConsolidation } from './consolidation/consolidationEngine.js';
import { OpenAIBackend } from './llm/openaiBackend.js';
import { BedrockBackend } from './llm/bedrockBackend.js';
import type { LlmBackend } from './llm/llmBackend.js';
import type { MemconsolidateConfig } from './types.js';

/**
 * Resolve an LLM backend by name.
 */
function resolveBackend(name: string): LlmBackend {
  switch (name) {
    case 'openai':
      return new OpenAIBackend();
    case 'bedrock':
      return new BedrockBackend();
    default:
      throw new Error(
        `Unknown LLM backend "${name}". Available backends: openai, bedrock`,
      );
  }
}

/**
 * Main daemon class that orchestrates polling, trigger evaluation,
 * and consolidation passes.
 *
 * Validates: Requirements 8.1, 8.2, 11.1, 11.4, 11.5
 */
export class MemconsolidateDaemon {
  private config: MemconsolidateConfig;
  private backend: LlmBackend | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;
  private running = false;
  private consolidating = false;
  private priorMtime = 0;
  private lastSessionScanAt = 0;
  private lastConsolidationAt = 0;
  private static readonly SESSION_SCAN_THROTTLE_MS = 10 * 60 * 1000; // 10 min

  constructor(config: MemconsolidateConfig) {
    this.config = config;
  }

  /**
   * Start the daemon: validate config, initialize LLM backend,
   * create memory dir if missing, perform initial gate check,
   * then poll on pollIntervalMs.
   *
   * Validates: Requirements 11.1, 11.4, 11.5
   */
  async start(): Promise<void> {
    // Validate config (Req 11.1)
    this.config = validateConfig(this.config);

    // Initialize LLM backend (Req 6.3, 6.4, 11.1)
    const backend = resolveBackend(this.config.llmBackend);
    try {
      await backend.initialize(this.config.llmBackendOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'daemon:backend-init-failed', {
        backend: this.config.llmBackend,
        reason: message,
      });
      throw new Error(
        `LLM backend "${this.config.llmBackend}" failed to initialize: ${message}`,
      );
    }
    this.backend = backend;

    // Create memory directory if missing (Req 11.4)
    await fs.mkdir(this.config.memoryDirectory, { recursive: true });

    this.running = true;
    log('info', 'daemon:started', {
      memoryDirectory: this.config.memoryDirectory,
      pollIntervalMs: this.config.pollIntervalMs,
      llmBackend: this.config.llmBackend,
    });

    // Perform initial gate check immediately (Req 11.5)
    await this.runOnce();

    // Begin polling (Req 8.2)
    if (this.running) {
      this.pollTimer = setInterval(() => {
        void this.runOnce();
      }, this.config.pollIntervalMs);
    }
  }

  /**
   * Graceful shutdown: abort in-progress consolidation,
   * rollback lock if needed, stop polling.
   *
   * Validates: Requirements 11.2
   */
  async stop(): Promise<void> {
    this.running = false;

    // Stop polling
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Abort in-progress consolidation
    if (this.abortController) {
      this.abortController.abort();
    }

    // If we were mid-consolidation, rollback the lock
    if (this.consolidating && this.priorMtime > 0) {
      try {
        await rollbackLock(this.config.memoryDirectory, this.priorMtime);
        log('info', 'daemon:lock-rolled-back-on-stop', {
          priorMtime: this.priorMtime,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('warn', 'daemon:rollback-failed-on-stop', { reason: message });
      }
    }

    log('info', 'daemon:stopped');
  }

  /**
   * Single trigger evaluation + consolidation if gates pass.
   *
   * Validates: Requirements 8.1, 11.1
   */
  async runOnce(): Promise<void> {
    if (!this.running || !this.backend) return;

    try {
      // Read last consolidated timestamp from lock file mtime
      const lockState = await readLockState(
        this.config.memoryDirectory,
        this.config.staleLockThresholdMs,
      );
      const lastConsolidatedAt = lockState.mtime;

      // Rate limit: enforce minimum interval between consolidation passes
      const sinceLastConsolidation = Date.now() - this.lastConsolidationAt;
      if (this.lastConsolidationAt > 0 && sinceLastConsolidation < this.config.minConsolidationIntervalMs) {
        log('info', 'daemon:rate-limited', {
          sinceLastMs: sinceLastConsolidation,
          minIntervalMs: this.config.minConsolidationIntervalMs,
        });
        return;
      }

      // Scan throttle: if we recently scanned sessions and they didn't pass,
      // skip re-evaluation until the throttle window expires.
      const sinceScanMs = Date.now() - this.lastSessionScanAt;
      if (this.lastSessionScanAt > 0 && sinceScanMs < MemconsolidateDaemon.SESSION_SCAN_THROTTLE_MS) {
        log('info', 'daemon:scan-throttled', {
          sinceScanMs,
          throttleMs: MemconsolidateDaemon.SESSION_SCAN_THROTTLE_MS,
        });
        return;
      }

      // Evaluate trigger gates
      const triggerResult = await evaluateTrigger(
        this.config,
        lastConsolidatedAt,
      );

      if (!triggerResult.triggered) {
        // If time gate passed but session gate failed, apply scan throttle
        // to avoid re-scanning sessions every poll cycle.
        if (triggerResult.failedGate === 'session') {
          this.lastSessionScanAt = Date.now();
        }
        log('info', 'daemon:trigger-skipped', {
          failedGate: triggerResult.failedGate,
        });
        return;
      }

      // All gates passed — lock is acquired by evaluateTrigger
      this.priorMtime = triggerResult.priorMtime ?? 0;
      this.consolidating = true;
      this.abortController = new AbortController();
      this.lastSessionScanAt = 0; // Reset throttle on successful gate pass

      log('info', 'daemon:consolidation-start', {
        sessionCount: triggerResult.sessionCount,
        priorMtime: this.priorMtime,
      });

      try {
        const result = await runConsolidation(
          this.config,
          this.backend,
          this.abortController.signal,
        );

        // Success — release lock (updates mtime to now)
        await releaseLock(this.config.memoryDirectory);
        this.lastConsolidationAt = Date.now();

        log('info', 'daemon:consolidation-complete', {
          filesCreated: result.filesCreated.length,
          filesUpdated: result.filesUpdated.length,
          filesDeleted: result.filesDeleted.length,
          indexUpdated: result.indexUpdated,
          truncationApplied: result.truncationApplied,
          durationMs: result.durationMs,
          promptLength: result.promptLength,
          operationsRequested: result.operationsRequested,
          operationsApplied: result.operationsApplied,
          operationsSkipped: result.operationsSkipped,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'daemon:consolidation-failed', { reason: message });

        // Rollback lock mtime on failure (Req 2.3)
        try {
          await rollbackLock(this.config.memoryDirectory, this.priorMtime);
        } catch (rollbackErr) {
          const rbMsg =
            rollbackErr instanceof Error
              ? rollbackErr.message
              : String(rollbackErr);
          log('warn', 'daemon:rollback-failed', { reason: rbMsg });
        }
      } finally {
        this.consolidating = false;
        this.abortController = null;
        this.priorMtime = 0;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'daemon:runonce-error', { reason: message });
    }
  }
}
