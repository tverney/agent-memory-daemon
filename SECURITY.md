# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public issue.** Instead, use [GitHub's private vulnerability reporting](https://github.com/tverney/agent-memory-daemon/security/advisories/new) to submit a report.

You should receive an acknowledgment within 48 hours. The maintainer will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security considerations

- The daemon reads and writes files to configured directories. Ensure `memory_directory` and `session_directory` are not world-writable.
- LLM API keys (OpenAI) should be passed via environment variables, not hardcoded in config files.
- The PID-based lock file is not a security mechanism — it prevents concurrent corruption, not unauthorized access.
- The daemon does not open any network ports or accept inbound connections.
