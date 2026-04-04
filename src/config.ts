import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { MemconsolidateConfig } from './types.js';
import { log } from './logger.js';

const DEFAULTS: Omit<MemconsolidateConfig, 'memoryDirectory' | 'sessionDirectory' | 'llmBackend' | 'llmBackendOptions' | 'dryRun'> = {
  minHours: 24,
  minSessions: 5,
  staleLockThresholdMs: 3_600_000,
  maxIndexLines: 200,
  maxIndexBytes: 25_000,
  pollIntervalMs: 60_000,
  maxSessionContentChars: 2_000,
  maxMemoryContentChars: 4_000,
  minConsolidationIntervalMs: 300_000, // 5 min minimum between consolidation passes
  extractionEnabled: false,
  extractionIntervalMs: 60_000,
  maxExtractionSessionChars: 5_000,
};

/**
 * Recursively substitute `${ENV_VAR}` patterns in string values
 * with the corresponding environment variable.
 */
function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        log('warn', 'env_var_missing', { variable: varName });
        return '';
      }
      return envVal;
    });
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Map snake_case TOML keys to camelCase config keys.
 */
const KEY_MAP: Record<string, string> = {
  memory_directory: 'memoryDirectory',
  session_directory: 'sessionDirectory',
  min_hours: 'minHours',
  min_sessions: 'minSessions',
  stale_lock_threshold_ms: 'staleLockThresholdMs',
  max_index_lines: 'maxIndexLines',
  max_index_bytes: 'maxIndexBytes',
  llm_backend: 'llmBackend',
  poll_interval_ms: 'pollIntervalMs',
  max_session_content_chars: 'maxSessionContentChars',
  max_memory_content_chars: 'maxMemoryContentChars',
  dry_run: 'dryRun',
  min_consolidation_interval_ms: 'minConsolidationIntervalMs',
  extraction_enabled: 'extractionEnabled',
  extraction_interval_ms: 'extractionIntervalMs',
  max_extraction_session_chars: 'maxExtractionSessionChars',
};

function camelizeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const mapped = KEY_MAP[k] ?? k;
    result[mapped] = v;
  }
  return result;
}

/**
 * Validate a raw config object and apply defaults.
 * Throws on invalid values.
 */
export function validateConfig(raw: unknown): MemconsolidateConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a non-null object');
  }

  const obj = raw as Record<string, unknown>;

  // Handle the nested [llm_backend] table from TOML
  let camelized = camelizeKeys(obj);

  // Extract llm_backend section
  const llmSection = camelized['llmBackend'] ?? camelized['llm_backend'];
  if (llmSection !== undefined && typeof llmSection === 'object' && llmSection !== null) {
    const { name, ...rest } = llmSection as Record<string, unknown>;
    camelized['llmBackend'] = name as string;
    camelized['llmBackendOptions'] = rest;
  }

  const config: MemconsolidateConfig = {
    memoryDirectory: stringField(camelized, 'memoryDirectory', './memory'),
    sessionDirectory: stringField(camelized, 'sessionDirectory', './sessions'),
    minHours: numberField(camelized, 'minHours', DEFAULTS.minHours),
    minSessions: numberField(camelized, 'minSessions', DEFAULTS.minSessions),
    staleLockThresholdMs: numberField(camelized, 'staleLockThresholdMs', DEFAULTS.staleLockThresholdMs),
    maxIndexLines: numberField(camelized, 'maxIndexLines', DEFAULTS.maxIndexLines),
    maxIndexBytes: numberField(camelized, 'maxIndexBytes', DEFAULTS.maxIndexBytes),
    llmBackend: stringField(camelized, 'llmBackend', ''),
    llmBackendOptions: (camelized['llmBackendOptions'] as Record<string, unknown>) ?? {},
    pollIntervalMs: numberField(camelized, 'pollIntervalMs', DEFAULTS.pollIntervalMs),
    maxSessionContentChars: numberField(camelized, 'maxSessionContentChars', DEFAULTS.maxSessionContentChars),
    maxMemoryContentChars: numberField(camelized, 'maxMemoryContentChars', DEFAULTS.maxMemoryContentChars),
    dryRun: booleanField(camelized, 'dryRun', false),
    minConsolidationIntervalMs: numberField(camelized, 'minConsolidationIntervalMs', DEFAULTS.minConsolidationIntervalMs),
    extractionEnabled: booleanField(camelized, 'extractionEnabled', DEFAULTS.extractionEnabled),
    extractionIntervalMs: numberField(camelized, 'extractionIntervalMs', DEFAULTS.extractionIntervalMs),
    maxExtractionSessionChars: numberField(camelized, 'maxExtractionSessionChars', DEFAULTS.maxExtractionSessionChars),
  };

  // Validate constraints
  if (config.minHours < 0) throw new Error(`minHours must be non-negative, got ${config.minHours}`);
  if (config.minSessions < 0) throw new Error(`minSessions must be non-negative, got ${config.minSessions}`);
  if (config.staleLockThresholdMs < 0) throw new Error(`staleLockThresholdMs must be non-negative, got ${config.staleLockThresholdMs}`);
  if (config.maxIndexLines < 1) throw new Error(`maxIndexLines must be at least 1, got ${config.maxIndexLines}`);
  if (config.maxIndexBytes < 1) throw new Error(`maxIndexBytes must be at least 1, got ${config.maxIndexBytes}`);
  if (config.pollIntervalMs < 1000) throw new Error(`pollIntervalMs must be at least 1000, got ${config.pollIntervalMs}`);
  if (config.maxSessionContentChars < 100) throw new Error(`maxSessionContentChars must be at least 100, got ${config.maxSessionContentChars}`);
  if (config.maxMemoryContentChars < 100) throw new Error(`maxMemoryContentChars must be at least 100, got ${config.maxMemoryContentChars}`);
  if (config.minConsolidationIntervalMs < 0) throw new Error(`minConsolidationIntervalMs must be non-negative, got ${config.minConsolidationIntervalMs}`);
  if (config.extractionIntervalMs < 10_000) throw new Error(`extractionIntervalMs must be at least 10000, got ${config.extractionIntervalMs}`);
  if (!config.llmBackend) throw new Error('llmBackend is required');

  return config;
}

function stringField(obj: Record<string, unknown>, key: string, fallback: string): string {
  const val = obj[key];
  if (val === undefined) return fallback;
  if (typeof val !== 'string') throw new Error(`${key} must be a string, got ${typeof val}`);
  return val;
}

function numberField(obj: Record<string, unknown>, key: string, fallback: number): number {
  const val = obj[key];
  if (val === undefined) return fallback;
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`${key} must be a finite number, got ${String(val)}`);
  }
  return val;
}

function booleanField(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const val = obj[key];
  if (val === undefined) return fallback;
  if (typeof val !== 'boolean') throw new Error(`${key} must be a boolean, got ${typeof val}`);
  return val;
}

/**
 * Load config from a TOML file (with JSON fallback).
 * If no path is given, looks for `memconsolidate.toml` in the current directory.
 */
export async function loadConfig(configPath?: string): Promise<MemconsolidateConfig> {
  const filePath = resolve(configPath ?? 'memconsolidate.toml');
  let raw: string;

  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`Cannot read config file "${filePath}": ${code ?? String(err)}`);
  }

  let parsed: unknown;

  // Try TOML first, fall back to JSON
  try {
    parsed = parseToml(raw);
  } catch {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Config file "${filePath}" is neither valid TOML nor valid JSON`);
    }
  }

  // Substitute env vars in all string values
  parsed = substituteEnvVars(parsed);

  return validateConfig(parsed);
}
