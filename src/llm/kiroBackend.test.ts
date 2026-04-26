import { describe, it, expect, vi } from 'vitest';
import { KiroBackend } from './kiroBackend.js';

vi.mock('../logger.js', () => ({ log: vi.fn() }));

/** Invoke the private parseResponse method for testing. */
function parse(raw: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (new KiroBackend() as any).parseResponse(raw);
}

describe('KiroBackend parseResponse', () => {
  it('extracts JSON from plain output', () => {
    const raw = '{"operations":[{"op":"create","path":"a.md","content":"x"}]}';
    expect(parse(raw).operations).toHaveLength(1);
  });

  it('strips ANSI escape codes before parsing', () => {
    const raw =
      '\u001B[38;5;141m> \u001B[0m' +
      '{"operations":[{"op":"create","path":"a.md","content":"x"}]}' +
      '\u001B[0m';
    const r = parse(raw);
    expect(r.operations[0]).toEqual({ op: 'create', path: 'a.md', content: 'x' });
  });

  it('ignores CLI chrome around the JSON object', () => {
    const raw =
      '> json\n' +
      '{"operations":[{"op":"update","path":"b.md","content":"y"}]}\n' +
      ' ▸ Credits: 0.07 • Time: 1s\n';
    const r = parse(raw);
    expect(r.operations[0].op).toBe('update');
  });

  it('handles nested braces inside string content', () => {
    const raw =
      '{"operations":[{"op":"create","path":"a.md","content":"hello {world} and } bye"}]}';
    expect(parse(raw).operations[0].content).toBe('hello {world} and } bye');
  });

  it('preserves optional reasoning field', () => {
    const raw =
      '{"operations":[{"op":"delete","path":"a.md"}],"reasoning":"stale"}';
    expect(parse(raw).reasoning).toBe('stale');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parse('nothing here')).toThrow(/did not contain a JSON object/);
  });

  it('throws when JSON is malformed', () => {
    expect(() => parse('{broken')).toThrow(/did not contain a JSON object/);
  });

  it('throws when operations array is missing', () => {
    expect(() => parse('{"foo":"bar"}')).toThrow(/missing "operations"/);
  });

  it('throws when operation op is invalid', () => {
    const raw = '{"operations":[{"op":"move","path":"a.md","content":"x"}]}';
    expect(() => parse(raw)).toThrow(/must be "create", "update", or "delete"/);
  });
});
