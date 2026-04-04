// Amazon Bedrock backend using the official AWS SDK.
// Uses the Bedrock Converse API to avoid model-specific payload formats.
// The SDK handles endpoint resolution, credential refresh, signing, retries,
// and network quirks (IPv6, DNS, TLS) automatically.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type SystemContentBlock,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { log } from '../logger.js';
import type { LlmBackend } from './llmBackend.js';
import type { LlmResponse, FileOperation } from '../types.js';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

export class BedrockBackend implements LlmBackend {
  readonly name = 'bedrock';

  private region = DEFAULT_REGION;
  private modelId = DEFAULT_MODEL_ID;
  private client!: BedrockRuntimeClient;

  async initialize(options: Record<string, unknown>): Promise<void> {
    if (typeof options.region === 'string' && options.region.length > 0) {
      this.region = options.region;
    } else if (process.env.AWS_REGION) {
      this.region = process.env.AWS_REGION;
    } else if (process.env.AWS_DEFAULT_REGION) {
      this.region = process.env.AWS_DEFAULT_REGION;
    }
    if (typeof options.model === 'string' && options.model.length > 0) {
      this.modelId = options.model;
    }

    const profile = typeof options.profile === 'string' && options.profile.length > 0
      ? options.profile
      : undefined;

    // The SDK's default credential provider chain handles:
    // env vars, ~/.aws/credentials, SSO, ECS container credentials,
    // EC2 instance metadata (IMDS), and more.
    this.client = new BedrockRuntimeClient({
      region: this.region,
      ...(profile ? { profile } : {}),
    });

    // Verify credentials are resolvable by making a config resolution call
    try {
      const creds = await this.client.config.credentials();
      if (!creds.accessKeyId) {
        throw new Error('No access key');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Bedrock backend: unable to resolve AWS credentials (${message}). ` +
        'Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars, ' +
        'configure ~/.aws/credentials, specify a profile, ' +
        'or run in an environment with an IAM role (ECS, EC2, AgentCore).',
      );
    }

    log('info', 'bedrock:initialized', {
      region: this.region,
      modelId: this.modelId,
      profile: profile ?? '(default chain)',
    });
  }

  async consolidate(prompt: string): Promise<LlmResponse> {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ text: prompt }] as ContentBlock[],
      },
    ];

    const system: SystemContentBlock[] = [
      {
        text: 'You are a memory consolidation assistant. Always respond with valid JSON containing an "operations" array. Each operation has "op" (create/update/delete), "path" (filename), and "content" (for create/update). Optionally include a "reasoning" string.',
      },
    ];

    const command = new ConverseCommand({
      modelId: this.modelId,
      messages,
      system,
      inferenceConfig: {
        maxTokens: 8192,
        temperature: 0.2,
      },
    });

    let response;
    try {
      response = await this.client.send(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Bedrock request failed: ${message}`);
    }

    return this.parseConverseResponse(response as unknown as Record<string, unknown>);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseConverseResponse(response: Record<string, unknown>): LlmResponse {
    const output = response.output as Record<string, unknown> | undefined;
    const message = output?.message as Record<string, unknown> | undefined;
    const contentBlocks = message?.content as Array<Record<string, unknown>> | undefined;

    const textBlock = contentBlocks?.find(
      (b) => typeof b.text === 'string',
    );
    const text = textBlock?.text as string | undefined;

    if (typeof text !== 'string') {
      log('error', 'bedrock:parse_failed', {
        raw: JSON.stringify(response).slice(0, 500),
      });
      throw new Error('Bedrock response missing text content');
    }

    // The model might wrap JSON in markdown code fences — strip them
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      log('error', 'bedrock:json_parse_failed', {
        content: cleaned.slice(0, 500),
      });
      throw new Error('Bedrock response is not valid JSON');
    }

    return this.validateLlmResponse(parsed);
  }

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
        throw new Error(
          `operations[${i}].op must be "create", "update", or "delete"`,
        );
      }
      if (typeof o.path !== 'string' || o.path.length === 0) {
        throw new Error(
          `operations[${i}].path must be a non-empty string`,
        );
      }
      if (
        (o.op === 'create' || o.op === 'update') &&
        typeof o.content !== 'string'
      ) {
        throw new Error(
          `operations[${i}].content required for "${o.op}"`,
        );
      }

      return {
        op: o.op,
        path: o.path,
        ...(typeof o.content === 'string' ? { content: o.content } : {}),
      };
    });

    return {
      operations,
      ...(typeof obj.reasoning === 'string'
        ? { reasoning: obj.reasoning }
        : {}),
    };
  }
}
