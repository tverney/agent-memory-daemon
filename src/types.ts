// Shared type definitions for memconsolidate

// --- Memory Types ---

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

// --- Config ---

export interface MemconsolidateConfig {
  memoryDirectory: string;
  sessionDirectory: string;
  minHours: number;
  minSessions: number;
  staleLockThresholdMs: number;
  maxIndexLines: number;
  maxIndexBytes: number;
  llmBackend: string;
  llmBackendOptions: Record<string, unknown>;
  pollIntervalMs: number;
  maxSessionContentChars: number;
  maxMemoryContentChars: number;
  dryRun: boolean;
  minConsolidationIntervalMs: number;
}

// --- Trigger System ---

export interface TriggerResult {
  triggered: boolean;
  failedGate?: 'time' | 'session' | 'lock';
  sessionCount?: number;
  priorMtime?: number;
}

// --- Lock Manager ---

export interface LockState {
  exists: boolean;
  holderPid: number | null;
  mtime: number;
  isStale: boolean;
  holderAlive: boolean;
}

// --- Consolidation Engine ---

export interface ConsolidationResult {
  filesCreated: string[];
  filesUpdated: string[];
  filesDeleted: string[];
  indexUpdated: boolean;
  truncationApplied: boolean;
  durationMs: number;
  promptLength: number;
  operationsRequested: number;
  operationsApplied: number;
  operationsSkipped: number;
}

// --- LLM Backend ---

export interface FileOperation {
  op: 'create' | 'update' | 'delete';
  path: string;
  content?: string;
}

export interface LlmResponse {
  operations: FileOperation[];
  reasoning?: string;
}

// --- Logger ---

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  data?: Record<string, unknown>;
}

// --- Index Manager ---

export interface IndexEntry {
  title: string;
  file: string;
  description: string;
}

// --- Frontmatter ---

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType | null;
}

export interface ParsedMemoryFile {
  frontmatter: MemoryFrontmatter;
  body: string;
}

// --- Memory Scanner ---

export interface MemoryHeader {
  path: string;
  name: string;
  description: string;
  type: MemoryType | null;
  mtimeMs: number;
}
