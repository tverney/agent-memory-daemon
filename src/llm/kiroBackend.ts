// Kiro CLI backend — pipes prompts through `kiro-cli chat` in non-interactive mode.
// Useful for Amazon employees with Kiro access who want to avoid Bedrock metered costs.
//
// Requires the `kiro-cli` binary on PATH (https://aws.amazon.com/kiro/).

import { spawn } from 'node:child_process';
import type { LlmBackend, ConsolidateOptions } from './llmBackend.js';
import type { LlmResponse, FileOperation } from '../types.js';
import { log } from '../logger.js';

const DEFAULT_BINARY = 'kiro-cli';
const DEFAULT_AGENT = 'memconsolidate';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 min

// JSON-only instruction appended to every prompt so Kiro's agent emits
// structured output instead of conversational markdown.
const JSON_INSTRUCTION =
  '\n\nRespond ONLY with a valid JSON object matching this shape — no markdown fences, no prose, no commentary:\n' +
  '{"operations":[{"op":"create|update|delete","path":"<file>","content":"<str>","reasoning":"<optional>"}]}';

export class KiroBackend implements LlmBackend {
  readonly name = 'kiro';

  private binary = DEFAULT_BINARY;
  private agent: string | null = DEFAULT_AGENT;
  private model: string | undefined;
  private timeoutMs = DEFAULT_TIMEOUT_MS;

  async initialize(options: Record<string, unknown>): Promise<void> {
    if (typeof options.binary === 'string' && options.binary.length > 0) {
      this.binary = options.binary;
    }
    // `agent` can be explicitly set to "" or null to disable the agent flag
    // and fall back to Kiro's default (heavyweight) session context.
    if (options.agent === null || options.agent === '') {
      this.agent = null;
    } else if (typeof options.agent === 'string') {
      this.agent = options.agent;
    }
    if (typeof options.model === 'string' && options.model.length > 0) {
      this.model = options.model;
    }
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      this.timeoutMs = options.timeoutMs;
    }

    // Verify the binary is runnable
    await this.runKiro(['--version']).catch((err) => {
      throw new Error(
        `Kiro backend: cannot invoke "${this.binary}" (${(err as Error).message}). ` +
          'Install Kiro CLI or set options.binary to the correct path.',
      );
    });

    log('info', 'kiro:initialized', {
      binary: this.binary,
      agent: this.agent ?? '(default)',
      model: this.model ?? '(default)',
    });
  }

  async consolidate(prompt: string, options?: ConsolidateOptions): Promise<LlmResponse> {
    const fullPrompt =
      (options?.systemPrompt ? `${options.systemPrompt}\n\n---\n\n` : '') +
      prompt +
      JSON_INSTRUCTION;

    const args = ['chat', '--no-interactive', '--trust-tools='];
    if (this.agent) args.push('--agent', this.agent);
    if (this.model) args.push('--model', this.model);
    args.push(fullPrompt);

    const stdout = await this.runKiro(args);
    return this.parseResponse(stdout);
  }

  /** Spawn kiro-cli and collect stdout. Rejects on non-zero exit or timeout. */
  private runKiro(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { env: { ...process.env, NO_COLOR: '1' } });
      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Kiro CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Kiro CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Strip ANSI + CLI chrome, find the JSON object, parse and validate. */
  private parseResponse(raw: string): LlmResponse {
    // eslint-disable-next-line no-control-regex
    const stripped = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

    // Kiro's output wraps the response with a "> " prompt marker and a
    // trailing " ▸ Credits: ... • Time: ..." footer. The JSON object is
    // the first balanced {...} in between.
    const json = extractJsonObject(stripped);
    if (!json) {
      log('error', 'kiro:parse_failed', { raw: stripped.slice(0, 500) });
      throw new Error('Kiro response did not contain a JSON object');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      log('error', 'kiro:json_parse_failed', { content: json.slice(0, 500) });
      throw new Error('Kiro response is not valid JSON');
    }

    return validateLlmResponse(parsed);
  }
}

/** Find the first balanced {...} object in a string (handles nested braces and strings). */
function extractJsonObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Shared validation — identical to the other backends. */
function validateLlmResponse(raw: unknown): LlmResponse {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('LLM response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  const ops = obj.operations;
  if (!Array.isArray(ops)) throw new Error('LLM response missing "operations" array');

  const operations: FileOperation[] = ops.map((op, i) => {
    if (typeof op !== 'object' || op === null) throw new Error(`operations[${i}] is not an object`);
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
