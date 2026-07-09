# Foundry Agent Canvas

A GitHub Copilot App **canvas extension** that reproduces the Microsoft Foundry
"Build agent" experience in a side panel. Pick models, tools, and toolboxes from
your live Foundry project; initialize, inspect, and deploy a hosted agent. Most
affordances send a ready-to-edit prompt to chat; **Inspect locally** runs the
agent in the integrated terminal and embeds the Agent Inspector.

## Features

- **Build view** — add models, tools, skills, guardrails.
- **Live project data** — model deployments, tool connections, and Foundry
  Toolboxes are read from your selected project (read-only).
- **Project picker** — sign in, pick subscription + project; the selection
  persists locally across reopens.
- **Toolboxes** — list/add toolboxes; "Add tool" lets you pick a target toolbox
  (or create a new one).
- **Local Agent Inspector** — **Inspect locally** launches the agent with
  `azd ai agent run --no-inspector` in the integrated terminal (reusing an
  already-running one) and embeds the inspector UI, proxied to the agent on
  port 8088. Closing the last builder canvas closes that terminal, stopping the
  agent and freeing the port.
- **Prompt-to-chat** — actions post a prompt to the chat session for Copilot
  to execute.

## Requirements

- GitHub Copilot App with canvas extension support
- Node.js 18+
- Azure CLI (`az login`) for live project/model/toolbox data
- (Optional) `azd` to run/deploy hosted agents

## Install

1. Add a project using a local folder or repo in the Copilot App.
2. Install the extension — prompt Copilot:

   > Install https://github.com/SmallBlackHole/foundry-agent-canvas/releases/download/nightly/foundry-agent-canvas.zip
   > into .github/extensions/foundry-agent-canvas/

   Or manually: download the zip from
   [this direct link](https://github.com/SmallBlackHole/foundry-agent-canvas/releases/download/nightly/foundry-agent-canvas.zip)
   and unzip it into `.github/extensions/foundry-agent-canvas/` in your
   project root.
3. Prompt the Copilot App to open the Foundry Agent Canvas.

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
