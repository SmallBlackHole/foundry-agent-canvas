# Responses vs Invocations — Microsoft Foundry hosted agents

Distilled from https://ankitbko.github.io/blog/2026/05/hosted-agents-part-1/.

Foundry hosted agents support two communication protocols: **Responses** and **Invocations**.

## Responses protocol
- Follows the OpenAI `/responses` contract (familiar if you've used the OpenAI SDK).
- Platform-managed conversation history via `conversation_id` (no manual turn tracking).
- Standard streaming lifecycle events: `response.created` -> `response.in_progress` -> `response.output_text.delta` -> `response.completed`.
- Background execution via `background: true` for long-running tasks.
- Built-in heads for Teams/M365 publishing and agent-to-agent (A2A) delegation come free.
- Other Foundry features like evaluation work out of the box.
- You write minimal code; the platform handles the HTTP contract, session management, and streaming.

## Invocations protocol
- Your agent exposes `/invocations` and accepts an arbitrary payload you define (blob-in/blob-out).
- You manage session state yourself.
- Raw SSE control: you format events and manage the stream.
- Full payload freedom (any JSON/byte structure).
- Trade-off: Teams/M365 publishing and A2A delegation are **NOT** available.

## Recommendation
Start with **Responses** unless you have a specific reason not to — you get conversation management, streaming, and Teams/A2A integration for free. Reach for **Invocations** only when you need arbitrary payloads, custom streaming behavior, or full HTTP control. Both protocols can coexist in one agent, so it isn't a one-way door.
