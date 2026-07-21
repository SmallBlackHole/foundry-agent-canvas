# Agent Notes

- This repo is a GitHub Copilot App canvas extension. The provider entrypoint is `extension.mjs` at the project root; modules live in `src/`. esbuild bundles everything into `dist/extension.mjs`.
- `@github/copilot-sdk/extension` is supplied by the Copilot runtime; keep it external and do not add it to the package.
- Use `npm run preview` for integrated-browser UI checks. It serves `public/` with preview data and stubs Copilot chat, Azure sign-in, and Agent Inspector startup.
- In `src/`, do not use `console.log`; stdout is reserved for JSON-RPC. Use `session.log()` instead.
- Keep local/runtime artifacts out of commits: `node_modules/`, `dist/`, `.env`.
