import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIBackend } from './openaiBackend.js';

// Suppress logger output during tests
vi.mock('../logger.js', () => ({
  log: vi.fn(),
}));

// --- helpers ---

function chatResponse(content: string, status = 200): Response {
  const body = JSON.stringify({
    choices: [{ message: { content } }],
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, body = 'error'): Response {
  return new Response(body, { status });
}

// --- tests ---

describe('OpenAIBackend', () => {
  let backend: OpenAIBackend;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    backend = new OpenAIBackend();
    await backend.initialize({ apiKey: 'sk-test' });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --- initialize ---

  describe('initialize', () => {
    it('throws when apiKey is missing', async () => {
      const b = new OpenAIBackend();
      await expect(b.initialize({})).rejects.toThrow('non-empty "apiKey"');
    });

    it('throws when apiKey is empty string', async () => {
      const b = new OpenAIBackend();
      await expect(b.initialize({ apiKey: '' })).rejects.toThrow('non-empty "apiKey"');
    });

    it('accepts api_key as snake_case alias', async () => {
      const b = new OpenAIBackend();
      await expect(b.initialize({ api_key: 'sk-alt' })).resolves.toBeUndefined();
    });

    it('uses custom model and baseUrl when provided', async () => {
      const b = new OpenAIBackend();
      await b.initialize({
        apiKey: 'sk-test',
        model: 'gpt-3.5-turbo',
        baseUrl: 'https://custom.api.com/v1/',
      });

      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ operations: [] })),
      );

      await b.consolidate('test');

      const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
      expect(calledUrl).toBe('https://custom.api.com/v1/chat/completions');
    });
  });

  // --- response parsing ---

  describe('consolidate — response parsing', () => {
    it('parses a valid response with create/update/delete operations', async () => {
      const llmContent = JSON.stringify({
        operations: [
          { op: 'create', path: 'new.md', content: '# New' },
          { op: 'update', path: 'existing.md', content: '# Updated' },
          { op: 'delete', path: 'old.md' },
        ],
        reasoning: 'consolidated memories',
      });

      fetchSpy.mockResolvedValueOnce(chatResponse(llmContent));

      const result = await backend.consolidate('consolidate prompt');

      expect(result.operations).toHaveLength(3);
      expect(result.operations[0]).toEqual({ op: 'create', path: 'new.md', content: '# New' });
      expect(result.operations[1]).toEqual({ op: 'update', path: 'existing.md', content: '# Updated' });
      expect(result.operations[2]).toEqual({ op: 'delete', path: 'old.md' });
      expect(result.reasoning).toBe('consolidated memories');
    });

    it('parses an empty operations array', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ operations: [] })),
      );

      const result = await backend.consolidate('noop');
      expect(result.operations).toEqual([]);
      expect(result.reasoning).toBeUndefined();
    });

    it('omits reasoning when not present in response', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ operations: [] })),
      );

      const result = await backend.consolidate('test');
      expect(result).not.toHaveProperty('reasoning');
    });

    it('sends prompt as system message with json_object response format', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ operations: [] })),
      );

      await backend.consolidate('my prompt');

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.messages).toEqual([{ role: 'system', content: 'my prompt' }]);
      expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('sends Authorization header with bearer token', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ operations: [] })),
      );

      await backend.consolidate('test');

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-test');
    });
  });

  // --- error handling ---

  describe('consolidate — error handling', () => {
    it('throws on HTTP error status', async () => {
      fetchSpy.mockResolvedValueOnce(errorResponse(429, 'rate limited'));

      await expect(backend.consolidate('test')).rejects.toThrow(
        'OpenAI API error 429: rate limited',
      );
    });

    it('throws on 500 server error', async () => {
      fetchSpy.mockResolvedValueOnce(errorResponse(500, 'internal error'));

      await expect(backend.consolidate('test')).rejects.toThrow(
        'OpenAI API error 500: internal error',
      );
    });

    it('throws on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(backend.consolidate('test')).rejects.toThrow(
        'OpenAI request failed: ECONNREFUSED',
      );
    });

    it('throws when response has no message content', async () => {
      const body = JSON.stringify({ choices: [{ message: {} }] });
      fetchSpy.mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'missing message content',
      );
    });

    it('throws when response content is not valid JSON', async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse('not json at all'));

      await expect(backend.consolidate('test')).rejects.toThrow(
        'not valid JSON',
      );
    });

    it('throws when response is missing operations array', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({ reasoning: 'no ops' })),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'missing "operations" array',
      );
    });

    it('throws on invalid op type', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({
          operations: [{ op: 'rename', path: 'a.md' }],
        })),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'operations[0].op must be "create", "update", or "delete"',
      );
    });

    it('throws when path is empty', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({
          operations: [{ op: 'delete', path: '' }],
        })),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'operations[0].path must be a non-empty string',
      );
    });

    it('throws when create operation is missing content', async () => {
      fetchSpy.mockResolvedValueOnce(
        chatResponse(JSON.stringify({
          operations: [{ op: 'create', path: 'new.md' }],
        })),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'operations[0].content required for "create"',
      );
    });

    it('throws when response is not an object', async () => {
      fetchSpy.mockResolvedValueOnce(chatResponse('"just a string"'));

      await expect(backend.consolidate('test')).rejects.toThrow(
        'LLM response is not an object',
      );
    });

    it('throws when choices array is empty', async () => {
      const body = JSON.stringify({ choices: [] });
      fetchSpy.mockResolvedValueOnce(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

      await expect(backend.consolidate('test')).rejects.toThrow(
        'missing message content',
      );
    });
  });
});
