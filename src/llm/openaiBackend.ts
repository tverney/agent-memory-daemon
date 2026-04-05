// OpenAI-compatible reference backend.
// Uses raw fetch against the chat completions endpoint so we avoid
// pulling in the full openai SDK as a runtime dependency.

import type { LlmBackend, ConsolidateOptions } from './llmBackend.js';
import type { LlmResponse, FileOperation } from '../types.js';
import { log } from '../logger.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';

export class OpenAIBackend implements LlmBackend {
  readonly name = 'openai';

  private apiKey = '';
  private model = DEFAULT_MODEL;
  private baseUrl = DEFAULT_BASE_URL;

  async initialize(options: Record<string, unknown>): Promise<void> {
    const apiKey = options.apiKey ?? options.api_key;
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw new Error('OpenAI backend requires a non-empty "apiKey" option');
    }
    this.apiKey = apiKey;

    if (typeof options.model === 'string' && options.model.length > 0) {
      this.model = options.model;
    }
    if (typeof options.baseUrl === 'string' && options.baseUrl.length > 0) {
      this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    }
  }

  async consolidate(prompt: string, options?: ConsolidateOptions): Promise<LlmResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    // When a separate systemPrompt is provided, split into system + user
    // messages. OpenAI automatically caches matching prefixes, so keeping
    // the stable instructions in the system message maximises cache hits
    // across multi-chunk consolidation passes.
    const messages = options?.systemPrompt
      ? [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'system', content: prompt }];

    const body = {
      model: this.model,
      messages,
      response_format: { type: 'json_object' },
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI request failed: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)');
      throw new Error(
        `OpenAI API error ${res.status}: ${text}`,
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    return this.parseResponse(json);
  }

  /** Extract LlmResponse from the chat completions JSON envelope. */
  private parseResponse(json: Record<string, unknown>): LlmResponse {
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const content = (choices?.[0]?.message as Record<string, unknown>)
      ?.content as string | undefined;

    if (typeof content !== 'string') {
      log('error', 'llm.parse_failed', { raw: JSON.stringify(json).slice(0, 500) });
      throw new Error('OpenAI response missing message content');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      log('error', 'llm.json_parse_failed', { content: content.slice(0, 500) });
      throw new Error('OpenAI response is not valid JSON');
    }

    return this.validateLlmResponse(parsed);
  }

  /** Validate and coerce the parsed JSON into a well-typed LlmResponse. */
  private validateLlmResponse(raw: unknown): LlmResponse {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('LLM response is not an object');
    }

    const obj = raw as Record<string, unknown>;
    const ops = obj.operations;

    if (!Array.isArray(ops)) {
      throw new Error('LLM response missing "operations" array');
    }

    const operations: FileOperation[] = ops.map((op, i) => {
      if (typeof op !== 'object' || op === null) {
        throw new Error(`operations[${i}] is not an object`);
      }
      const o = op as Record<string, unknown>;

      if (o.op !== 'create' && o.op !== 'update' && o.op !== 'delete') {
        throw new Error(`operations[${i}].op must be "create", "update", or "delete"`);
      }
      if (typeof o.path !== 'string' || o.path.length === 0) {
        throw new Error(`operations[${i}].path must be a non-empty string`);
      }
      if ((o.op === 'create' || o.op === 'update') && typeof o.content !== 'string') {
        throw new Error(`operations[${i}].content required for "${o.op}"`);
      }

      return {
        op: o.op,
        path: o.path,
        ...(typeof o.content === 'string' ? { content: o.content } : {}),
      };
    });

    return {
      operations,
      ...(typeof obj.reasoning === 'string' ? { reasoning: obj.reasoning } : {}),
    };
  }
}
