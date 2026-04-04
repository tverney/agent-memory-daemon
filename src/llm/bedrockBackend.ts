// Amazon Bedrock backend using AWS SDK v4 Signature via raw fetch.
// Uses the Bedrock Converse API to avoid model-specific payload formats.
// Requires AWS credentials available via the standard credential chain
// (env vars, ~/.aws/credentials, instance profile, etc.).

import { log } from '../logger.js';
import type { LlmBackend } from './llmBackend.js';
import type { LlmResponse, FileOperation } from '../types.js';
import { createHash, createHmac } from 'node:crypto';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export class BedrockBackend implements LlmBackend {
  readonly name = 'bedrock';

  private region = DEFAULT_REGION;
  private modelId = DEFAULT_MODEL_ID;
  private profile: string | undefined;
  private credentials: AwsCredentials | null = null;

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
    if (typeof options.profile === 'string' && options.profile.length > 0) {
      this.profile = options.profile;
    }

    // Resolve credentials
    this.credentials = await this.resolveCredentials();
    if (!this.credentials) {
      throw new Error(
        'Bedrock backend: unable to resolve AWS credentials. ' +
        'Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars, ' +
        'configure ~/.aws/credentials, specify a profile, ' +
        'or run in an environment with an IAM role (ECS, EC2, AgentCore).',
      );
    }

    log('info', 'bedrock:initialized', {
      region: this.region,
      modelId: this.modelId,
      profile: this.profile ?? '(default chain)',
    });
  }

  async consolidate(prompt: string): Promise<LlmResponse> {
    // Re-resolve credentials before each call to handle token expiry
    // for temporary credentials (SSO, assumed roles, instance profiles).
    this.credentials = await this.resolveCredentials();
    if (!this.credentials) {
      throw new Error('Bedrock backend: credentials expired and could not be refreshed');
    }

    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const urlPath = `/model/${encodeURIComponent(this.modelId)}/converse`;
    const url = `https://${host}${urlPath}`;
    // SigV4 requires URI-encoding each path segment in the canonical request.
    // Since the model ID is already percent-encoded (%3A), we must encode
    // the percent signs again for the canonical URI (%253A).
    const canonicalUri = `/model/${encodeURIComponent(encodeURIComponent(this.modelId))}/converse`;

    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
      system: [
        {
          text: 'You are a memory consolidation assistant. Always respond with valid JSON containing an "operations" array. Each operation has "op" (create/update/delete), "path" (filename), and "content" (for create/update). Optionally include a "reasoning" string.',
        },
      ],
      inferenceConfig: {
        maxTokens: 8192,
        temperature: 0.2,
      },
    });

    const headers = this.signRequest('POST', canonicalUri, host, body);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Bedrock request failed: ${message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '(no body)');
      throw new Error(`Bedrock API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    return this.parseConverseResponse(json);
  }

  private parseConverseResponse(json: Record<string, unknown>): LlmResponse {
    // Converse API response shape:
    // { output: { message: { role, content: [{ text: "..." }] } }, ... }
    const output = json.output as Record<string, unknown> | undefined;
    const message = output?.message as Record<string, unknown> | undefined;
    const contentBlocks = message?.content as Array<Record<string, unknown>> | undefined;

    const textBlock = contentBlocks?.find(
      (b) => typeof b.text === 'string',
    );
    const text = textBlock?.text as string | undefined;

    if (typeof text !== 'string') {
      log('error', 'bedrock:parse_failed', {
        raw: JSON.stringify(json).slice(0, 500),
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

  // --- AWS SigV4 signing ---

  private signRequest(
    method: string,
    path: string,
    host: string,
    body: string,
  ): Record<string, string> {
    const creds = this.credentials!;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const dateStamp = amzDate.slice(0, 8);
    const service = 'bedrock';
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;

    const payloadHash = sha256(body);

    const signedHeaderNames = creds.sessionToken
      ? 'content-type;host;x-amz-date;x-amz-security-token'
      : 'content-type;host;x-amz-date';

    let canonicalHeaders =
      `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
    if (creds.sessionToken) {
      canonicalHeaders += `x-amz-security-token:${creds.sessionToken}\n`;
    }

    const canonicalRequest = [
      method,
      path,
      '', // no query string
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(
      creds.secretAccessKey,
      dateStamp,
      this.region,
      service,
    );
    const signature = hmacHex(signingKey, stringToSign);

    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

    const headers: Record<string, string> = {
      'x-amz-date': amzDate,
      Authorization: authHeader,
    };
    if (creds.sessionToken) {
      headers['x-amz-security-token'] = creds.sessionToken;
    }
    return headers;
  }

  private async resolveCredentials(): Promise<AwsCredentials | null> {
    // 1. Explicit env vars
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
      };
    }

    // 2. Parse ~/.aws/credentials for the requested profile
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');

      const credsPath = join(homedir(), '.aws', 'credentials');
      const raw = await readFile(credsPath, 'utf-8');
      const profile = this.profile ?? process.env.AWS_PROFILE ?? 'default';
      const creds = parseIniProfile(raw, profile);
      if (creds) return creds;
    } catch {
      // credentials file not found — continue
    }

    // 3. ECS / AgentCore container credentials (task role)
    const containerRelUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const containerFullUri = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    const containerEndpoint = containerFullUri
      ? containerFullUri
      : containerRelUri
        ? `http://169.254.170.2${containerRelUri}`
        : null;

    if (containerEndpoint) {
      try {
        const headers: Record<string, string> = {};
        const authToken = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
        if (authToken) {
          headers['Authorization'] = authToken;
        }
        const res = await fetch(containerEndpoint, { headers });
        if (res.ok) {
          const data = await res.json() as Record<string, string>;
          if (data.AccessKeyId && data.SecretAccessKey) {
            return {
              accessKeyId: data.AccessKeyId,
              secretAccessKey: data.SecretAccessKey,
              sessionToken: data.Token,
            };
          }
        }
      } catch {
        // container endpoint not available — continue
      }
    }

    // 4. EC2 instance metadata (IMDSv2)
    try {
      const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
        method: 'PUT',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
        signal: AbortSignal.timeout(1000),
      });
      if (tokenRes.ok) {
        const token = await tokenRes.text();
        const credsRes = await fetch(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) },
        );
        if (credsRes.ok) {
          const roleName = (await credsRes.text()).trim().split('\n')[0];
          if (roleName) {
            const roleRes = await fetch(
              `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
              { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1000) },
            );
            if (roleRes.ok) {
              const data = await roleRes.json() as Record<string, string>;
              if (data.AccessKeyId && data.SecretAccessKey) {
                return {
                  accessKeyId: data.AccessKeyId,
                  secretAccessKey: data.SecretAccessKey,
                  sessionToken: data.Token,
                };
              }
            }
          }
        }
      }
    } catch {
      // IMDS not available — continue
    }

    return null;
  }
}

// --- Utility functions ---

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf-8').digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf-8').digest('hex');
}

function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function parseIniProfile(
  raw: string,
  profile: string,
): AwsCredentials | null {
  const lines = raw.split('\n');
  let inProfile = false;
  let accessKeyId = '';
  let secretAccessKey = '';
  let sessionToken: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      const name = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim();
      inProfile = name === profile;
      continue;
    }
    if (!inProfile) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();

    if (key === 'aws_access_key_id') accessKeyId = val;
    else if (key === 'aws_secret_access_key') secretAccessKey = val;
    else if (key === 'aws_session_token') sessionToken = val;
  }

  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken };
  }
  return null;
}
