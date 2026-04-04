import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { validateConfig } from '../config.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

describe('Extraction config property tests', () => {
  // Feature: memory-extraction, Property 1: Extraction config defaults are applied
  it('Property 1: Extraction config defaults are applied', () => {
    // Validates: Requirements 1.1, 1.2, 1.3
    const baseArb = fc.record({
      llmBackend: fc.constant('openai'),
      memoryDirectory: fc.constant('./mem'),
      sessionDirectory: fc.constant('./sess'),
    });

    fc.assert(
      fc.property(baseArb, (raw) => {
        // raw omits extractionEnabled, extractionIntervalMs, maxExtractionSessionChars
        const cfg = validateConfig(raw);
        expect(cfg.extractionEnabled).toBe(false);
        expect(cfg.extractionIntervalMs).toBe(60_000);
        expect(cfg.maxExtractionSessionChars).toBe(5_000);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: memory-extraction, Property 2: Invalid extraction interval is rejected
  it('Property 2: Invalid extraction interval is rejected', () => {
    // Validates: Requirements 1.4
    const invalidIntervalArb = fc.integer({ min: 0, max: 9999 });

    fc.assert(
      fc.property(invalidIntervalArb, (interval) => {
        expect(() =>
          validateConfig({
            llmBackend: 'openai',
            memoryDirectory: './mem',
            sessionDirectory: './sess',
            extractionIntervalMs: interval,
          }),
        ).toThrow('extractionIntervalMs must be at least 10000');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: memory-extraction, Property 3: TOML snake_case keys map to camelCase
  it('Property 3: TOML snake_case keys map to camelCase', () => {
    // Validates: Requirements 1.6
    const snakeCaseArb = fc.record({
      extraction_enabled: fc.boolean(),
      extraction_interval_ms: fc.integer({ min: 10_000, max: 1_000_000 }),
      max_extraction_session_chars: fc.integer({ min: 1, max: 100_000 }),
    });

    fc.assert(
      fc.property(snakeCaseArb, (snakeFields) => {
        const raw = {
          llm_backend: { name: 'openai' },
          memory_directory: './mem',
          session_directory: './sess',
          ...snakeFields,
        };
        const cfg = validateConfig(raw);
        expect(cfg.extractionEnabled).toBe(snakeFields.extraction_enabled);
        expect(cfg.extractionIntervalMs).toBe(snakeFields.extraction_interval_ms);
        expect(cfg.maxExtractionSessionChars).toBe(snakeFields.max_extraction_session_chars);
      }),
      { numRuns: 100 },
    );
  });
});
