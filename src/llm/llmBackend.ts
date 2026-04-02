// LLM backend interface — stateless, pluggable provider abstraction.
// Each consolidation prompt is self-contained; backends hold no conversation state.

import type { FileOperation, LlmResponse } from '../types.js';

export type { FileOperation, LlmResponse };

export interface LlmBackend {
  /** Provider identifier (e.g. "openai", "anthropic") */
  readonly name: string;

  /** One-time setup — create client, validate credentials, etc. */
  initialize(options: Record<string, unknown>): Promise<void>;

  /** Send a self-contained consolidation prompt and return file operations. */
  consolidate(prompt: string): Promise<LlmResponse>;
}
