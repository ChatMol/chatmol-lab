# Contributing to ChatMol Lab

Thank you for helping improve ChatMol Lab.

## Before opening a pull request

1. Create a focused branch from `main`.
2. Do not commit API keys, credentials, private research data, model outputs, or
   patient-identifiable information.
3. Keep platform-neutral behavior in `web/` and Electron lifecycle behavior in
   `electron/`.
4. Add or update Vitest coverage for agent-runtime and policy changes.
5. Run the project checks:

```bash
npm run lint
npm test
npm run build
```

For changes to command execution, approvals, plugins, MCP, memory, or tool
dispatch, describe the trust-boundary impact in the pull request.

## Pull requests

Explain the user-visible behavior, implementation approach, and verification
performed. Avoid mixing unrelated refactors with a functional change.

Contributions are accepted under the repository's MIT license.
