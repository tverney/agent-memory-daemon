import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig, loadConfig } from './config.js';

// Suppress logger output during tests
vi.mock('./logger.js', () => ({
  log: vi.fn(),
}));

describe('validateConfig', () => {
  const minimal = {
    memoryDirectory: './mem',
    sessionDirectory: './sess',
    llmBackend: 'openai',
  };

  it('applies all defaults when only required fields are provided', () => {
    const cfg = validateConfig(minimal);
    expect(cfg.minHours).toBe(24);
    expect(cfg.minSessions).toBe(5);
    expect(cfg.staleLockThresholdMs).toBe(3_600_000);
    expect(cfg.maxIndexLines).toBe(200);
    expect(cfg.maxIndexBytes).toBe(25_000);
    expect(cfg.pollIntervalMs).toBe(60_000);
    expect(cfg.llmBackendOptions).toEqual({});
  });

  it('preserves explicitly set values over defaults', () => {
    const cfg = validateConfig({ ...minimal, minHours: 48, minSessions: 10 });
    expect(cfg.minHours).toBe(48);
    expect(cfg.minSessions).toBe(10);
  });

  it('throws on null input', () => {
    expect(() => validateConfig(null)).toThrow('non-null object');
  });

  it('throws on array input', () => {
    expect(() => validateConfig([])).toThrow('non-null object');
  });

  it('throws when llmBackend is missing', () => {
    expect(() => validateConfig({ memoryDirectory: './m', sessionDirectory: './s' })).toThrow('llmBackend is required');
  });

  it('throws on negative minHours', () => {
    expect(() => validateConfig({ ...minimal, minHours: -1 })).toThrow('minHours must be non-negative');
  });

  it('throws on negative minSessions', () => {
    expect(() => validateConfig({ ...minimal, minSessions: -1 })).toThrow('minSessions must be non-negative');
  });

  it('throws on negative staleLockThresholdMs', () => {
    expect(() => validateConfig({ ...minimal, staleLockThresholdMs: -1 })).toThrow('staleLockThresholdMs must be non-negative');
  });

  it('throws on maxIndexLines < 1', () => {
    expect(() => validateConfig({ ...minimal, maxIndexLines: 0 })).toThrow('maxIndexLines must be at least 1');
  });

  it('throws on maxIndexBytes < 1', () => {
    expect(() => validateConfig({ ...minimal, maxIndexBytes: 0 })).toThrow('maxIndexBytes must be at least 1');
  });

  it('throws on pollIntervalMs < 1000', () => {
    expect(() => validateConfig({ ...minimal, pollIntervalMs: 500 })).toThrow('pollIntervalMs must be at least 1000');
  });

  it('throws when a number field receives a string', () => {
    expect(() => validateConfig({ ...minimal, minHours: 'ten' })).toThrow('minHours must be a finite number');
  });

  it('throws when a string field receives a number', () => {
    expect(() => validateConfig({ ...minimal, memoryDirectory: 42 })).toThrow('memoryDirectory must be a string');
  });

  it('handles snake_case keys from TOML', () => {
    const cfg = validateConfig({
      memory_directory: '/data/mem',
      session_directory: '/data/sess',
      min_hours: 12,
      min_sessions: 3,
      llm_backend: { name: 'openai', api_key: 'sk-test' },
    });
    expect(cfg.memoryDirectory).toBe('/data/mem');
    expect(cfg.sessionDirectory).toBe('/data/sess');
    expect(cfg.minHours).toBe(12);
    expect(cfg.minSessions).toBe(3);
    expect(cfg.llmBackend).toBe('openai');
    expect(cfg.llmBackendOptions).toEqual({ api_key: 'sk-test' });
  });

  it('extracts llmBackendOptions from nested llm_backend table', () => {
    const cfg = validateConfig({
      ...minimal,
      llmBackend: { name: 'anthropic', model: 'claude-3', temperature: 0.2 },
    });
    expect(cfg.llmBackend).toBe('anthropic');
    expect(cfg.llmBackendOptions).toEqual({ model: 'claude-3', temperature: 0.2 });
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `memconsolidate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid TOML config file', async () => {
    const toml = `
memory_directory = "./memories"
session_directory = "./sessions"

[llm_backend]
name = "openai"
api_key = "sk-abc123"
model = "gpt-4"
`;
    const cfgPath = join(tmpDir, 'config.toml');
    await writeFile(cfgPath, toml);

    const cfg = await loadConfig(cfgPath);
    expect(cfg.memoryDirectory).toBe('./memories');
    expect(cfg.llmBackend).toBe('openai');
    expect(cfg.llmBackendOptions).toEqual({ api_key: 'sk-abc123', model: 'gpt-4' });
  });

  it('falls back to JSON when TOML parsing fails', async () => {
    const json = JSON.stringify({
      memoryDirectory: './mem',
      sessionDirectory: './sess',
      llmBackend: 'openai',
      llmBackendOptions: {},
    });
    const cfgPath = join(tmpDir, 'config.json');
    await writeFile(cfgPath, json);

    const cfg = await loadConfig(cfgPath);
    expect(cfg.memoryDirectory).toBe('./mem');
    expect(cfg.llmBackend).toBe('openai');
  });

  it('throws on non-existent file', async () => {
    await expect(loadConfig(join(tmpDir, 'nope.toml'))).rejects.toThrow('Cannot read config file');
  });

  it('throws on file that is neither TOML nor JSON', async () => {
    const cfgPath = join(tmpDir, 'bad.toml');
    await writeFile(cfgPath, '<<<not valid>>>');
    await expect(loadConfig(cfgPath)).rejects.toThrow('neither valid TOML nor valid JSON');
  });
});

describe('environment variable substitution', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved['TEST_MEM_DIR'] = process.env['TEST_MEM_DIR'];
    saved['TEST_API_KEY'] = process.env['TEST_API_KEY'];
    process.env['TEST_MEM_DIR'] = '/resolved/mem';
    process.env['TEST_API_KEY'] = 'sk-secret';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('substitutes env vars in TOML string values', async () => {
    const tmpDir = join(tmpdir(), `memconsolidate-env-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    try {
      const toml = `
memory_directory = "\${TEST_MEM_DIR}"
session_directory = "./sess"

[llm_backend]
name = "openai"
api_key = "\${TEST_API_KEY}"
`;
      const cfgPath = join(tmpDir, 'config.toml');
      await writeFile(cfgPath, toml);

      const cfg = await loadConfig(cfgPath);
      expect(cfg.memoryDirectory).toBe('/resolved/mem');
      expect(cfg.llmBackendOptions).toMatchObject({ api_key: 'sk-secret' });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('replaces undefined env vars with empty string', async () => {
    delete process.env['NONEXISTENT_VAR'];
    const tmpDir2 = join(tmpdir(), `memconsolidate-env2-${Date.now()}`);
    await mkdir(tmpDir2, { recursive: true });
    try {
      const toml = `
memory_directory = "\${NONEXISTENT_VAR}/data"
session_directory = "./sess"

[llm_backend]
name = "openai"
`;
      const cfgPath = join(tmpDir2, 'config.toml');
      await writeFile(cfgPath, toml);

      const cfg = await loadConfig(cfgPath);
      expect(cfg.memoryDirectory).toBe('/data');
    } finally {
      await rm(tmpDir2, { recursive: true, force: true });
    }
  });
});
