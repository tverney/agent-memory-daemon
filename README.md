# agent-memory-daemon

Open-source memory consolidation and extraction daemon for AI agents. Filesystem-native, LLM-pluggable, framework-agnostic.

Agents feed it raw observations as markdown files; the daemon runs two complementary modes:

- **Consolidation** — periodically reorganizes, deduplicates, and prunes existing memory files via a four-phase pass (orient → gather → consolidate → prune)
- **Extraction** — watches for new session content and runs an LLM pass to identify facts, decisions, preferences, and error corrections worth remembering, writing them as individual memory files

The filesystem is the interface — no SDK, no API, no MCP required. The LLM backend is pluggable (OpenAI, Amazon Bedrock, or anything with a chat API).

memconsolidate is a standalone, agent-agnostic daemon — available to anyone building with OpenClaw, Strands, LangChain, or any custom agent framework.

## How it works

### Consolidation (reorganize existing memories)

1. Agents write markdown memory files (with YAML frontmatter) to a watched directory
2. A three-gate trigger system (time elapsed + session count + lock) decides when to consolidate
3. The daemon runs a four-phase pass: orient → gather → consolidate → prune
4. The result is organized, deduplicated, size-budgeted memory with a concise MEMORY.md index

### Extraction (discover new memories from sessions)

1. The daemon tracks a cursor (`.extraction-cursor`) — the timestamp of the last extraction
2. On each poll, it scans the session directory for files modified since the cursor
3. If new content is found, it builds a prompt containing the current memory manifest + session content
4. The LLM identifies facts, decisions, preferences, and corrections worth remembering
5. Valid operations are applied to the memory directory and the MEMORY.md index is updated
6. The cursor advances on success; on failure it stays put so the same content is retried

Consolidation takes priority — if both triggers fire on the same tick, consolidation runs first and extraction waits for the next cycle. A shared PID-based lock ensures they never run concurrently.

## Key design goals

- **Agent-agnostic**: any agent that can write a file can use it — OpenClaw, Strands, LangChain, custom agents, raw LLM calls
- **Language-agnostic**: filesystem is the interface — no SDK required
- **LLM-pluggable**: bring your own model (OpenAI, Amazon Bedrock, or any chat API)
- **Two modes, one daemon**: consolidation and extraction run in the same process with mutual exclusion
- **Size-budgeted**: MEMORY.md index stays under 200 lines / 25 KB
- **Concurrent-safe**: PID-based lock file prevents corruption from parallel runs
- **Observable**: structured JSON-line logs with duration, prompt size, and operation metrics
- **Dry-run mode**: preview what either mode would change without writing anything

## Quick start

### Install

```bash
npm install agent-memory-daemon
```

Or run directly with npx:

```bash
npx agent-memory-daemon init
npx agent-memory-daemon start
```

### Configure

```toml
memory_directory = "./memory"
session_directory = "./sessions"
min_hours = 24
min_sessions = 5

# Enable extraction mode (off by default)
extraction_enabled = true
extraction_interval_ms = 60000        # minimum 10000
max_extraction_session_chars = 5000

[llm_backend]
name = "bedrock"          # or "openai"
region = "us-east-1"
profile = "default"
model = "us.anthropic.claude-sonnet-4-20250514-v1:0"
```

### Run

```bash
npx agent-memory-daemon start
```

Or if installed globally / as a project dependency:

```bash
agent-memory-daemon start
```

The daemon polls on a configurable interval. Ctrl+C for graceful shutdown.

## Integration with agent frameworks

The integration pattern is the same regardless of framework — your agent writes session notes, memconsolidate consolidates them in the background, and your agent reads the organized memories at startup.

**OpenClaw**: Point `session_directory` at your OpenClaw workspace's transcript directory. memconsolidate consolidates what the agent accumulates.

**Strands / LangChain**: After each agent run, append a session summary to the sessions directory. At startup, read `MEMORY.md` + topic files into your agent's system prompt.

**Raw LLM calls**: Same pattern — dump session artifacts as markdown, read the memory index before each conversation.

## Configuration reference

All keys use `snake_case` in TOML and are mapped to `camelCase` internally.

### Consolidation settings

| Key | Default | Description |
|---|---|---|
| `memory_directory` | `./memory` | Path to the memory file directory |
| `session_directory` | `./sessions` | Path to the session file directory |
| `min_hours` | `24` | Minimum hours since last consolidation before triggering |
| `min_sessions` | `5` | Minimum session files required to trigger |
| `poll_interval_ms` | `60000` | How often the daemon checks triggers (ms) |
| `min_consolidation_interval_ms` | `300000` | Minimum ms between consolidation passes |
| `max_session_content_chars` | `2000` | Max chars per session file included in the prompt |
| `max_memory_content_chars` | `4000` | Max chars per memory file included in the prompt |
| `max_index_lines` | `200` | MEMORY.md line budget |
| `max_index_bytes` | `25000` | MEMORY.md size budget |
| `stale_lock_threshold_ms` | `3600000` | Lock age before it's considered stale |
| `dry_run` | `false` | Preview changes without writing files |

### Extraction settings

| Key | Default | Description |
|---|---|---|
| `extraction_enabled` | `false` | Enable the extraction mode |
| `extraction_interval_ms` | `60000` | Minimum ms between extraction passes (min: 10000) |
| `max_extraction_session_chars` | `5000` | Max chars of session content included in the extraction prompt |

### LLM backend

```toml
[llm_backend]
name = "bedrock"          # "bedrock" or "openai"
region = "us-east-1"      # Bedrock only
profile = "default"       # Bedrock only (AWS profile)
model = "us.anthropic.claude-sonnet-4-20250514-v1:0"
# api_key = "${OPENAI_API_KEY}"  # OpenAI only
```

## Extraction in detail

Extraction identifies new knowledge from agent sessions and writes it as structured memory files. It's designed to run frequently (every 60 seconds by default) with low overhead — only modified session files are processed.

### What it extracts

The LLM is instructed to look for:
- **Facts** — concrete information about the project, codebase, or environment
- **Decisions** — architectural choices, tool selections, approach decisions
- **Preferences** — user coding style, tool preferences, workflow habits
- **Error corrections** — things that were wrong before and are now corrected

### How the cursor works

The `.extraction-cursor` file in the memory directory contains a millisecond timestamp. On each poll:

1. Session files with `mtime > cursor` are collected
2. If any are found, extraction runs
3. On success, the cursor advances to the current time
4. On failure, the cursor stays put — the same files will be retried next cycle

If the cursor file is missing (first run), all session files are processed.

### Mutual exclusion

Consolidation and extraction share the same PID-based lock and never run concurrently. The daemon enforces this with boolean flags (`consolidating` / `extracting`) checked at the top of each poll cycle. Consolidation always takes priority.

### Log events

| Event | When |
|---|---|
| `daemon:extraction-start` | Extraction pass begins |
| `daemon:extraction-complete` | Extraction pass finishes successfully |
| `daemon:extraction-failed` | Extraction pass fails |

## How does this compare to OpenClaw's memory system?

Both projects use markdown files on disk for agent memory, but they solve different problems at different layers.

**OpenClaw** is a full personal AI assistant with a built-in memory subsystem. Its memory system focuses on *retrieval* — hybrid search (BM25 + vector similarity) so the agent can recall relevant memories during a conversation. Memories are written in real-time during sessions (manual saves, pre-compaction flush, session hooks). There's a community `memory-organizer` skill for manual cleanup, but no automated background consolidation.

**memconsolidate** is a standalone daemon that focuses on *curation*. It runs independently of any agent, periodically reviewing and reorganizing the memory directory using an LLM. It merges duplicates, converts relative dates to absolute, removes contradicted facts, and keeps the index within a size budget. Any agent in any language can drop `.md` files into the directory — memconsolidate handles the housekeeping.

| | OpenClaw | memconsolidate |
|---|---|---|
| What it is | Full AI assistant with memory plugin | Standalone consolidation + extraction daemon |
| Core focus | Memory retrieval (search) | Memory curation (consolidation) + discovery (extraction) |
| When memories are organized | Manually or at compaction | Automatically via background daemon |
| When new memories are created | Agent writes during chat | Extraction mode discovers them from session files |
| Search capabilities | Hybrid vector + BM25 | Not in scope |
| Agent coupling | Plugin inside OpenClaw runtime | Agent-agnostic, filesystem interface |
| Trigger mechanism | User-initiated or compaction threshold | Time + session count + lock gates (consolidation), cursor + mtime (extraction) |
| LLM usage for memory | Agent writes memories during chat | Separate LLM calls for consolidation and extraction |

They're complementary — you could point memconsolidate at an OpenClaw workspace's `memory/` directory and let it periodically clean up what the agent accumulates.
