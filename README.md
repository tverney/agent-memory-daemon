# memconsolidate

The first open-source memory consolidation daemon for AI agents.

Agents feed it raw observations as markdown files; the daemon periodically runs a four-phase consolidation pass (orient → gather → consolidate → prune) to produce organized, durable memory. The filesystem is the interface — no SDK, no API, no MCP required. The LLM backend is pluggable (OpenAI, Amazon Bedrock, or anything with a chat API).

memconsolidate is available to anyone building with OpenClaw, Strands, LangChain, or any custom agent framework.

## How it works

1. Agents write markdown memory files (with YAML frontmatter) to a watched directory
2. A three-gate trigger system (time elapsed + session count + lock) decides when to consolidate
3. The daemon runs a four-phase pass: orient → gather → consolidate → prune
4. The result is organized, deduplicated, size-budgeted memory with a concise MEMORY.md index

## Key design goals

- **Agent-agnostic**: any agent that can write a file can use it — OpenClaw, Strands, LangChain, custom agents, raw LLM calls
- **Language-agnostic**: filesystem is the interface — no SDK required
- **LLM-pluggable**: bring your own model (OpenAI, Amazon Bedrock, or any chat API)
- **Size-budgeted**: MEMORY.md index stays under 200 lines / 25 KB
- **Concurrent-safe**: PID-based lock file prevents corruption from parallel runs
- **Observable**: structured JSON-line logs with duration, prompt size, and operation metrics
- **Dry-run mode**: preview what would change without writing anything

## Quick start

```bash
npm install
npx tsc
```

Create `memconsolidate.toml`:

```toml
memory_directory = "./memory"
session_directory = "./sessions"
min_hours = 24
min_sessions = 5

[llm_backend]
name = "bedrock"          # or "openai"
region = "us-east-1"
profile = "default"
model = "us.anthropic.claude-sonnet-4-20250514-v1:0"
```

Run:

```bash
node dist/index.js memconsolidate.toml
```

The daemon polls on a configurable interval. Ctrl+C for graceful shutdown.

## Integration with agent frameworks

The integration pattern is the same regardless of framework — your agent writes session notes, memconsolidate consolidates them in the background, and your agent reads the organized memories at startup.

**OpenClaw**: Point `session_directory` at your OpenClaw workspace's transcript directory. memconsolidate consolidates what the agent accumulates.

**Strands / LangChain**: After each agent run, append a session summary to the sessions directory. At startup, read `MEMORY.md` + topic files into your agent's system prompt.

**Raw LLM calls**: Same pattern — dump session artifacts as markdown, read the memory index before each conversation.

## How does this compare to OpenClaw's memory system?

Both projects use markdown files on disk for agent memory, but they solve different problems at different layers.

**OpenClaw** is a full personal AI assistant with a built-in memory subsystem. Its memory system focuses on *retrieval* — hybrid search (BM25 + vector similarity) so the agent can recall relevant memories during a conversation. Memories are written in real-time during sessions (manual saves, pre-compaction flush, session hooks). There's a community `memory-organizer` skill for manual cleanup, but no automated background consolidation.

**memconsolidate** is a standalone daemon that focuses on *curation*. It runs independently of any agent, periodically reviewing and reorganizing the memory directory using an LLM. It merges duplicates, converts relative dates to absolute, removes contradicted facts, and keeps the index within a size budget. Any agent in any language can drop `.md` files into the directory — memconsolidate handles the housekeeping.

| | OpenClaw | memconsolidate |
|---|---|---|
| What it is | Full AI assistant with memory plugin | Standalone consolidation daemon |
| Core focus | Memory retrieval (search) | Memory curation (consolidation) |
| When memories are organized | Manually or at compaction | Automatically via background daemon |
| Search capabilities | Hybrid vector + BM25 | Not in scope |
| Agent coupling | Plugin inside OpenClaw runtime | Agent-agnostic, filesystem interface |
| Trigger mechanism | User-initiated or compaction threshold | Time + session count + lock gates |
| LLM usage for memory | Agent writes memories during chat | Separate LLM call for consolidation |

They're complementary — you could point memconsolidate at an OpenClaw workspace's `memory/` directory and let it periodically clean up what the agent accumulates.
