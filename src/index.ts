#!/usr/bin/env node

import { loadConfig } from './config.js';
import { MemconsolidateDaemon } from './daemon.js';
import { log } from './logger.js';

/**
 * CLI entry point for memconsolidate.
 *
 * Usage: memconsolidate [config-path]
 *
 * Validates: Requirements 7.1, 11.1, 11.2, 11.3
 */
async function main(): Promise<void> {
  const configPath = process.argv[2];

  log('info', 'cli:starting', {
    configPath: configPath ?? '(default)',
    pid: process.pid,
  });

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'cli:config-load-failed', { reason: message });
    process.exitCode = 1;
    return;
  }

  const daemon = new MemconsolidateDaemon(config);

  // Register signal handlers for graceful shutdown (Req 11.2)
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log('info', 'cli:shutdown-signal', { signal });
    await daemon.stop();
    log('info', 'cli:shutdown-complete');
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await daemon.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', 'cli:start-failed', { reason: message });
    process.exitCode = 1;
  }
}

main();
