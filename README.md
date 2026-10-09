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
    "anthropic-sdk/claude-opus-*": { "enabled": true, "maxPrompts": 5, "interval": 50, "sessions": "top" },
    "commandcode/deepseek/*": { "enabled": true, "maxPrompts": 10, "interval": 25, "sessions": "top" }
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
- `logFile`: optional. A file (relative to the config file) that the plugin appends report
  lines to. OpenCode does not capture plugin console output, so this is how you see the
  per-prompt cache report. Without it, the plugin writes no reports.

`models` maps a `provider/model` glob (`*` wildcard, first match wins) to a rule. A model
with no match is never warmed.

- `enabled`: optional, default `true`. `false` turns the rule off without deleting it.
- `maxPrompts`: how many warm/wake prompts to send per idle spell, at least 1. This is the
  bound for both `wake` and non-wake rules: after this many prompts the rule stops until the
  next genuine user prompt starts a new spell.
- `interval`: minutes of silence before each prompt. Set it just under the provider's cache
  TTL.
- `sessions`: which sessions the rule warms. `"top"` (default) warms only top-level
  sessions, `"subagents"` only subagent (child) sessions, `"all"` both kinds. A session is a
  subagent when it has a parent session.
- `prompt`: optional message for this rule only, overriding the top-level `prompt`.
- `wake`: optional, default `false`. When true the message is admitted into the chat and the
  model runs, instead of a transient warm. Each wake adds a turn to the conversation.

Provider IDs are whatever your OpenCode setup uses (`opencode models` lists
`provider/model` pairs).

Saving the config file applies the new settings immediately. The plugin watches it, so a
changed `enabled`, `maxPrompts`, `interval`, `prompt` or glob takes effect without a restart.
An invalid file is rejected and the previous settings stay in effect, with the reason logged.

## How it works

A `context` session hook sees every real agent-loop request with its session and model, and
(re)arms a timer for that session. When the timer fires, the plugin calls `session.generate`
with the keepalive prompt (or `session.prompt` for a `wake` rule). A `generate` request reuses
the session's system prompt, tools and history and appends the prompt transiently, so it shares
the cached prefix and adds nothing to the session history.

Each prompt counts against the session's spell. A spell starts at a genuine user prompt and
ends once `maxPrompts` prompts have been sent; a wake is a real turn, so it does not reset its
own spell. Which sessions are eligible depends on the rule's `sessions` setting; `"top"` is
usually what you want, since the orchestrator is the one whose cache goes cold while a subagent
works. Before each prompt the plugin looks the session up and stops if it was archived or
removed, or unviewed past `idleTimeout`.

Each prompt appends a line to `logFile` (when set): `keepalive: warmed <session> ... cache
read=N write=M`. A large write with little read means the prompt missed the cache. For a
`wake` rule the delta is read right after the message is admitted, before the model runs, so
it reads as `read=0 write=0`; use a non-wake rule to measure the cache.

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
