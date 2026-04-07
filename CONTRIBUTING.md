# Contributing to agent-memory-daemon

Thanks for your interest in contributing. Here's how to get started.

## Development setup

```bash
git clone https://github.com/tverney/agent-memory-daemon.git
cd agent-memory-daemon
npm install
```

Run the test suite:

```bash
npm test
```

Build:

```bash
npm run build
```

## Making changes

1. Fork the repo and create a branch from `main`
2. Make your changes — keep commits focused and atomic
3. Add or update tests for any new behavior
4. Run `npm test` and make sure everything passes
5. Open a pull request against `main`

## Code style

- TypeScript with strict mode
- ESM modules (`.js` extensions in imports)
- Tests use Vitest with property-based testing via fast-check
- Structured JSON logging — no `console.log`

## What to work on

- Check [open issues](https://github.com/tverney/agent-memory-daemon/issues) for bugs and feature requests
- Issues labeled `good first issue` are a good starting point
- If you want to work on something not yet tracked, open an issue first to discuss

## Tests

The project uses property-based testing extensively. When adding new features:

- Write property tests that describe invariants (not just example-based tests)
- Use fast-check arbitraries to generate inputs
- Ensure preservation tests cover existing behavior that shouldn't change

## Pull requests

- Keep PRs small and focused on a single concern
- Include a clear description of what changed and why
- Reference any related issues
- All tests must pass before merge

## Reporting bugs

Open an issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Relevant log output (the daemon emits structured JSON logs)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
