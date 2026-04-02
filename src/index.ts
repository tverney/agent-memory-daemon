#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { MemconsolidateDaemon } from './daemon.js';
import { log } from './logger.js';

const VERSION = '1.0.0';

const HELP = `agent-memory-daemon v${VERSION}
Open-source memory consolidation daemon for AI agents.

Usage:
  agent-memory-daemon start [config-path]   Start the daemon (default: memconsolidate.toml)
  agent-memory-daemon init [config-path]    Generate a starter config file
  agent-memory-daemon --help                Show this help
  agent-memory-daemon --version             Show version

Examples:
  npx agent-memory-daemon init
  npx agent-memory-daemon start
  npx agent-memory-daemon start ./my-config.toml
`;

const DEFAULT_CONFIG = `# agent-memory-daemon configuration
# See: https://github.com/tverney/agent-memory-daemon

memory_directory = "./memory"
session_directory = "./sessions"
min_hours = 24
min_sessions = 5
poll_interval_ms = 60000

# Uncomment to preview changes without writing files:
# dry_run = true

# Content caps for prompt size control (chars per file):
# max_session_content_chars = 2000
# max_memory_content_chars = 4000

# --- LLM Backend ---
# Choose one: "openai" or "bedrock"

[llm_backend]
name = "bedrock"
region = "us-east-1"
# profile = "default"
model = "us.anthropic.claude-sonnet-4-20250514-v1:0"

# For OpenAI:
# [llm_backend]
# name = "openai"
# api_key = "\${OPENAI_API_KEY}"
# model = "gpt-4o"
`;

async function cmdInit(configPath?: string): Promise<void> {
  const target = resolve(configPath ?? 'memconsolidate.toml');

  try {
    await writeFile(target, DEFAULT_CONFIG, { flag: 'wx' });
    console.log(`Created ${target}`);
    console.log('Edit the [llm_backend] section, then run: agent-memory-daemon start');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`File already exists: ${target}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

async function cmdStart(configPath?: string): Promise<void> {
  log('info', 'cli:starting', {
    configPath: configPath ?? '(default)',
    pid: process.pid,
    version: VERSION,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await cmdInit(args[1]);
      break;
    case 'start':
      await cmdStart(args[1]);
      break;
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      break;
    default:
      // Backward compat: if the arg looks like a file path, treat it as `start <path>`
      if (command.endsWith('.toml') || command.endsWith('.json')) {
        await cmdStart(command);
      } else {
        console.error(`Unknown command: ${command}\n`);
        console.log(HELP);
        process.exitCode = 1;
      }
      break;
  }
}

main();
