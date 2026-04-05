// LLM backend interface — stateless, pluggable provider abstraction.
// Each consolidation prompt is self-contained; backends hold no conversation state.

import type { FileOperation, LlmResponse } from '../types.js';

export type { FileOperation, LlmResponse };

/**
 * Options for a consolidation LLM call.
 *
 * `systemPrompt` — stable instructions that rarely change between calls.
 *   Backends that support prompt caching (Bedrock/Anthropic, OpenAI) place
 *   this in a cacheable position so repeated calls with the same system
 *   prompt get a cache hit, cutting input token costs significantly.
 */
export interface ConsolidateOptions {
  /** Stable system-level instructions (cacheable). */
  systemPrompt?: string;
}

export interface LlmBackend {
  /** Provider identifier (e.g. "openai", "anthropic") */
  readonly name: string;

  /** One-time setup — create client, validate credentials, etc. */
  initialize(options: Record<string, unknown>): Promise<void>;

  /** Send a self-contained consolidation prompt and return file operations. */
  consolidate(prompt: string, options?: ConsolidateOptions): Promise<LlmResponse>;
}
