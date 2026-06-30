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

1. Add a project using a local folder or repo in the Copilot App.
2. Add [https://github.com/SmallBlackHole/foundry-agent-canvas](https://github.com/SmallBlackHole/foundry-agent-canvas) under `.github\extensions`.
3. Install dependencies: from `.github\extensions\foundry-agent-canvas`, run `npm install`.
   (`node_modules` is not committed, so without this the canvas fails to load with
   `Cannot find module 'ws'`.)
4. Prompt the Copilot App to open the Foundry Agent Canvas.

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
