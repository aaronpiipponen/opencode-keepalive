# opencode-keepalive

A per-model prompt-cache keepalive plugin for [OpenCode](https://opencode.ai) v2.

Provider prompt caches expire after a few minutes to an hour. If a session sits idle
longer than that (typically an orchestrator waiting on a long-running subagent), its next
request pays for the whole context again. This plugin periodically sends a tiny request
on the session's own context so the cache stays warm.

OpenCode has a built-in [`warming`](https://opencode.ai/v2/docs/warming/) option, but it
is one global setting. This plugin lets you warm only the expensive models you actually
use for orchestration, each with its own interval. Don't enable both.

## Install

1. Clone this repo somewhere.
2. Copy the example config and edit it:

   ```sh
   cp config.example.json config.json
   ```

3. Add the directory to `plugins` in your `opencode.json(c)`:

   ```jsonc
   { "plugins": ["/path/to/opencode-keepalive"] }
   ```

   To keep the config elsewhere, pass its path as the `config` option:

   ```jsonc
   { "plugins": [{ "package": "/path/to/opencode-keepalive", "options": { "config": "/path/to/keepalive.json" } }] }
   ```

Check it loaded with `opencode api get /api/plugin` (look for `keepalive`). Restart the
service (`opencode service restart`) if it did not pick up the change. The plugin throws
on a missing or invalid config rather than guessing defaults.

## Config

```json
{
  "prompt": "Do not perform any work. Reply with exactly: OK",
  "maxSessions": 4,
  "idleTimeout": 30,
  "autoTune": false,
  "models": {
    "anthropic-sdk/claude-opus-*": { "interval": 50, "duration": 240, "sessions": "top" },
    "commandcode/deepseek/*": { "interval": 25, "duration": 240, "sessions": "top" }
  }
}
```

Top-level keys:

- `prompt`: the default message sent on every warm.
- `maxSessions`: optional cap on how many sessions are warmed at once (`0`, the default,
  means no cap). When a new session would exceed it, the least recently active warmed
  session is dropped first.
- `idleTimeout`: optional minutes. A session no one has viewed within this window stops
  being warmed; `0` (the default) turns this off. The session's `viewed` time is used,
  falling back to `idle` or `updated`.
- `autoTune`: optional, default `false`. When true, a warm that misses the cache shortens
  that rule's interval so the next warm comes sooner. The interval never drops below a
  quarter of the configured value.

`models` maps a `provider/model` glob (`*` wildcard, first match wins) to a rule. A model
with no match is never warmed.

- `interval`: minutes of silence before each warm. Set it just under the provider's cache
  TTL.
- `duration`: minutes of warming after the session's last real request. Make it longer than
  your longest expected subagent run; warming stops when it runs out.
- `sessions`: which sessions the rule warms. `"top"` (default) warms only top-level
  sessions, `"subagents"` only subagent (child) sessions, `"all"` both kinds. A session is a
  subagent when it has a parent session.
- `prompt`: optional message for this rule only, overriding the top-level `prompt`.
- `wake`: optional, default `false`. When true the message is admitted into the chat and the
  model runs, instead of a transient warm. Use it to keep a session working on a timer;
  each wake adds a turn to the conversation.

Provider IDs are whatever your OpenCode setup uses (`opencode models` lists
`provider/model` pairs).

## How it works

A `context` session hook sees every real agent-loop request with its session and model, and
(re)arms a timer for that session. When the timer fires, the plugin calls `session.generate`
with the keepalive prompt. That request reuses the session's system prompt, tools and
history and appends the prompt transiently, so it shares the cached prefix and adds nothing
to the session history. Warms do not reset their own timer. Which sessions are eligible
depends on the rule's `sessions` setting; `"top"` is usually what you want, since the
orchestrator is the one whose cache goes cold while a subagent works. Before each warm the
plugin looks the session up and stops warming it if it was archived or removed, so finished
sessions are not pinged until `duration` runs out. Closing a TUI does not archive a session,
so an idle but unarchived session is still warmed until `duration` ends, unless `idleTimeout`
is set.

Each warm logs its cache read/write delta to the OpenCode log
(`keepalive: warmed <session> ... cache read=N write=M`). A large write with little read
means the warm missed the cache.

OpenCode builds a warm's system prompt from the `generate` hook and a real request's from
the `context` hook. A provider plugin that sets its prompt only in `context` (the Anthropic
plugin does) makes the warm miss from the system prompt onward, so the plugin copies the
last real request's system prefix onto each warm. It handles the three request shapes in
use: Anthropic Messages (`system`), OpenAI Responses (`instructions`), and OpenAI Chat
Completions (leading system-role messages).

## Testing

```sh
npm test
```

The suite uses a mock plugin context, so it needs no network or credentials. It covers
config validation, the `sessions` filter, per-rule `prompt` and `wake`, `idleTimeout`,
`maxSessions`, `autoTune`, warm reporting, and system-prefix alignment for all three request
shapes.

## Caveats

- Warms are real provider requests and cost tokens.
- The intervals only help if the provider keeps the cache that long. Anthropic needs the
  1-hour cache TTL enabled for a 50 minute interval to make sense; check what your setup
  requests. OpenAI cache retention varies by model.
- Written against OpenCode v2.0.20 (the V2 plugin API; V1 plugins have a different shape).
  Cache reuse was confirmed end-to-end against one OpenAI-compatible provider; the Anthropic
  system-prompt fix is verified by the offline tests, not a live Anthropic run.

## License

MIT
