import type { LogEntry } from './types.js';

export function log(
  level: LogEntry['level'],
  event: string,
  data?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(data !== undefined && { data }),
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}
