# Long-term memory service

OpenMausBot can hand each bot's captured turns to a memory service running
beside it and add that service's recall to every turn. The bundled service is
[`plugins/maus-memory`](../plugins/maus-memory/README.md): per-bot dated facts,
hybrid search and a knowledge graph in Postgres (pgvector and Apache AGE), an
incremental dream per bot, and an MCP server with the bot's memory tools. Any
service that speaks the same three calls works.

## Turning it on

Set it in `~/.openmausbot/config.json` and restart, or set
`OMB_EXTERNAL_MEMORY_URL` and `OMB_EXTERNAL_MEMORY_TOKEN` in the server's
environment (the environment wins):

```json
{ "memory": { "external": { "url": "http://127.0.0.1:8787", "token": "…", "recallTimeoutMs": 1500 } } }
```

The address must be https, or http on this computer or a private network
(Tailscale names included); any other address is refused and logged once.
`PUT /api/config` refuses `memory.external`: every captured turn goes to that
address, so only whoever runs the server sets it.

## What it receives and adds

- **Turns.** The turns memory upkeep would capture, whatever the bot's upkeep
  switch: a 1:1 turn the person started (no routine runs, internal or
  unattended turns, other bots' asks), and room turns only with
  `features.roomMemoryCapture`. `POST /v1/turns` with `botId` (the memory
  layer's id), `botName`, `threadId`, `turnId`, `person`, `reply`, `owner`,
  `room` and `at`. A turn the service cannot take waits in memory (at most 500)
  and is retried; a 4xx answer drops it.
- **Recall.** Before a 1:1 or room turn, `POST /v1/recall` with `botId` and the
  message. Its `passages` (`label`, `at`, `snippet`) come first in the recall
  block, labelled `long-term memory`; a slow or failing service gives none
  after `recallTimeoutMs` (default 1500) and the turn goes on. Bot API turns
  get none.
- **Core facts.** The answer's `core` lines are kept per bot and added to the
  bot's Memory prompt section from its next turn on; they are fetched for every
  bot when the server starts.

A bot with **Let this bot use memory** off neither sends nor receives
anything, and `features.autoRecall: false` stops the recall calls.

## Checking it

```sh
pnpm exec vitest run server/external-memory.test.ts server/external-memory.e2e.test.ts
cd plugins/maus-memory && npm test   # needs Postgres with pgvector and AGE, see its README
```

The end-to-end test runs the isolated fake-engine server against a stand-in
service and checks the turn it receives, the recall in the next turn's prompt,
the core facts in the system prompt and its preview, the refused API change,
and that a bot with memory off sends and receives nothing.
