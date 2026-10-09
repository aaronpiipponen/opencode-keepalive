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
  "models": {
    "anthropic/claude-opus-*": { "interval": 50, "duration": 240 },
    "openai/gpt-*": { "interval": 25, "duration": 240 }
  }
}
```

- `prompt`: the message sent on every warm.
- `models`: maps a `provider/model` glob (`*` wildcard, first match wins) to a rule. A
  model with no match is never warmed.
  - `interval`: minutes of silence before each warm. Set it just under the provider's
    cache TTL.
  - `duration`: minutes of warming after the session's last real request. Make it longer
    than your longest expected subagent run; warming stops when it runs out.

Provider IDs are whatever your OpenCode setup uses (`opencode models` lists
`provider/model` pairs).

## How it works

A `context` session hook sees every real agent-loop request with its session and model,
and (re)arms a timer for that session. When the timer fires, the plugin calls
`session.generate` with the keepalive prompt. That request reuses the session's system
prompt, tools and history and appends the prompt transiently, so it shares the cached
prefix and adds nothing to the session history. Warms do not reset their own timer, and
subagent (child) sessions are never warmed; the parent is the one whose cache goes cold.

## Caveats

- Warms are real provider requests and cost tokens.
- The intervals only help if the provider keeps the cache that long. Anthropic needs the
  1-hour cache TTL enabled for a 50 minute interval to make sense; check what your setup
  requests. OpenAI cache retention varies by model.
- Written and tested against OpenCode v2.0.20 (the V2 plugin API; V1 plugins have a
  different shape). Cache hits were not measured, only that warm requests are sent with
  the session's own context.

## License

MIT
