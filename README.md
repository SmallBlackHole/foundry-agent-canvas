# Foundry Agent Canvas

A GitHub Copilot CLI **canvas extension** that reproduces the Microsoft Foundry
"Build agent" experience in a side panel. Pick models, tools, and toolboxes from
your live Foundry project; initialize, inspect, and deploy a hosted agent — each
affordance sends a ready-to-edit prompt to chat.

## Features

- **Build view** — add models, tools, skills, knowledge, connected agents, memory.
- **Live project data** — model deployments, tool connections, and Foundry
  Toolboxes are read from your selected project (read-only).
- **Project picker** — sign in, pick subscription + project; the selection
  persists locally across reopens.
- **Toolboxes** — list/add toolboxes; "Add tool" lets you pick a target toolbox
  (or create a new one).
- **Local Agent Inspector** — static inspector UI proxied to a locally running
  agent on port 8088.
- **Prompt-to-chat** — every action posts a prompt to the chat session; no
  mutating API calls are made by the canvas itself.

## Requirements

- GitHub Copilot CLI with canvas extension support
- Node.js 18+
- Azure CLI (`az login`) for live project/model/toolbox data
- (Optional) `azd` to run/deploy hosted agents

## Install

```bash
npm install
```

Copy the folder into your extensions directory (project: `.github/extensions/`,
or your user extensions dir), then reload extensions. The canvas registers as
`agent-builder`.

## Configuration

No project is hardcoded. Sign in via the panel and pick your subscription +
project; or pass `projectEndpoint` / `model` when opening the canvas. Local-only
state is written to `.selection.json` (gitignored — never committed).

## Dependencies

- `@azure/identity` — auth for live project data
- `ws` — inspector WebSocket proxy

## Security

No secrets are stored in the repo. `.env` and `.selection.json` are gitignored.
The bundled `inspector-ui/` assets are prebuilt vendor files.

## License

MIT
