# Agent Notes

- This repo is a GitHub Copilot App canvas extension. The provider entrypoint is `extension.mjs` at the project root; modules live in `src/`. esbuild bundles everything into `dist/extension.mjs`.
- `@github/copilot-sdk/extension` is supplied by the Copilot runtime; keep it external and do not add it to the package.
- Use `npm run preview` for integrated-browser UI checks. It serves `public/` with preview data and stubs Copilot chat, Azure sign-in, and Agent Inspector startup.
- In `src/`, do not use `console.log`; stdout is reserved for JSON-RPC. Use `session.log()` instead.
- Preserving marketplace update and uninstall is a release-blocking requirement. Code running from an installed plugin must not call plugin-management RPCs (including `plugins.list`, `plugins.update`, install, uninstall, enable/disable, or marketplace refresh), mutate its installation, retain extra file handles under the installed plugin tree, or initiate competing plugin lifecycle work. Update detection, if present, must use only side-effect-free local manifest reads and direct HTTP metadata fetches.
- Do not ship plugin lifecycle or update UX based only on mocked RPC tests. Verify the packaged plugin end to end on Windows with restored sessions and multiple rehydrated canvases, and confirm the supported host-managed marketplace update and uninstall flows still succeed. If the host cannot quiesce every provider before replacement, do not offer an in-canvas update action or claim that reopening a session/canvas applies an update.
- Keep local/runtime artifacts out of commits: `node_modules/`, `dist/`, `.env`.
