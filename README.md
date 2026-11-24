<p align="center">
  <img src="/assets/logo.svg" alt="opencode-keepalive" width="360">
</p>

<p align="center">
  An OpenCode v2 plugin that keeps the prompt cache of chosen models warm while a session sits idle.
</p>

<p align="center">
  <a href="/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="/package.json"><img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-blue.svg"></a>
</p>

---

**Contents**

- [Why it exists](#why-it-exists)
- [Features](#features)
- [Set it up](#set-it-up)
- [Limits](#limits)
- [License](#license)

## Why it exists

Model providers keep a prompt cache for a few minutes to an hour. When a session sits idle longer
than that, for example an orchestrator waiting on a long-running subagent, the next request pays for
the whole context again.

The plugin sends a tiny request on the idle session's own context before the cache expires, so the
cache stays warm. OpenCode has a built-in [`warming`](https://opencode.ai/v2/docs/warming/) option,
but it is one global setting. This plugin warms only the models you list, each with its own interval.

> [!NOTE]
> The built-in option and this plugin both send warm requests, so enable only one of them.

## Features

### Per-model rules

A rule matches a `provider/model` pattern and sets how often to warm and how many times. A model
that matches no rule is never warmed, and a rule can be switched off without deleting it.

### Warm or wake

A warm is a hidden request that reuses the session's system prompt, tools and history. It shares the
cached prefix and adds nothing to the conversation. A rule with `wake` set sends its message into the
chat instead, so the model answers and the conversation gets a new turn.

### Choose the sessions

A rule can warm top-level sessions, subagent sessions, or both. Top-level is usually the right
choice, because the orchestrator's cache goes cold while a subagent works.

### Rules per project

A directory can have its own rules. The same model can be woken in one project and only warmed, or
left alone, everywhere else.

### Keeping warming in check

Warming stops after a set number of prompts per idle period, once nobody has viewed the session for
a set time, and when the session is archived or removed. You can also cap how many sessions are
warmed at once, and let the plugin shorten an interval that keeps missing the cache.

### Cache report

When `logFile` is set, each warm appends a line with how many cache tokens were read and written.
Many tokens written and few read means the warm missed the cache. An error while scheduling a warm
is written to the same file and ends warming for that session. A plugin error never fails the
request.

### Edit without restarting

The plugin watches its configuration file. A change applies when the file is saved, and a file with
an error is rejected, with the reason logged, while the previous settings stay in use.

### Cache reuse across providers

A warm made by OpenCode can carry a different system prompt than the real requests. The Anthropic
provider plugin does this, and the warm then misses the cache from the system prompt onward. The
plugin copies the system prompt of the last real request onto each warm. It handles the Anthropic
Messages, OpenAI Responses and OpenAI Chat Completions request formats.

## Set it up

1. Clone this repository somewhere.
2. Copy the example configuration and edit it:

   ```bash
   cp config.example.json config.json
   ```

3. Add the directory to `plugins` in `opencode.json` or `opencode.jsonc`:

   ```jsonc
   { "plugins": ["/path/to/opencode-keepalive"] }
   ```

   To keep the configuration somewhere else, pass its path as the `config` option:

   ```jsonc
   { "plugins": [{ "package": "/path/to/opencode-keepalive", "options": { "config": "/path/to/keepalive.json" } }] }
   ```

4. Check that the plugin loaded. `keepalive` should appear in the output:

   ```bash
   opencode api get /api/plugin
   ```

   If it is missing, run `opencode service restart`.

The plugin throws on a missing or invalid configuration file instead of guessing defaults.
`npm test` runs the tests, which use a mock plugin context and need no network or credentials.

### Configuration

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

| Key | Meaning |
|---|---|
| `prompt` | The message sent on every warm. |
| `maxSessions` | Optional cap on how many sessions are warmed at once. `0`, the default, means no cap. When a new session would exceed the cap, the least recently active warmed session is dropped. |
| `idleTimeout` | Optional minutes. A session nobody has viewed within this time stops being warmed. `0`, the default, turns it off. |
| `autoTune` | Optional, `false` by default. When true, a warm that misses the cache shortens that rule's interval, down to a quarter of the configured value. |
| `logFile` | Optional file, relative to the configuration file, that report lines are appended to. OpenCode does not capture plugin console output, so this is the only way to read the cache report. |

`models` maps a `provider/model` pattern to a rule. `*` matches any text, and the first matching
pattern wins. `opencode models` lists the `provider/model` names.

| Rule key | Meaning |
|---|---|
| `enabled` | Optional, `true` by default. `false` turns the rule off. |
| `maxPrompts` | How many prompts to send per idle period, at least 1. A period starts at a real user prompt, and the rule stops after this many prompts until the next one. |
| `interval` | Minutes of silence before each prompt. Set it slightly under the provider's cache lifetime. |
| `sessions` | `"top"`, the default, warms top-level sessions. `"subagents"` warms sessions that have a parent, and `"all"` warms both. |
| `prompt` | Optional message for this rule, replacing the top-level `prompt`. |
| `wake` | Optional, `false` by default. When true, the message is sent into the chat and the model runs. Each wake adds a turn to the conversation. |

`directories` is optional. It maps a directory, written as an absolute path or starting with `~/`,
to its own `models` map. A session in that directory or below it uses that map instead of the
top-level `models`, and the deepest matching directory wins. A session's directory is read on every
request, so a session moved to another directory follows the new directory's rules.

```json
{
  "prompt": "Do not perform any work. Reply with exactly: OK",
  "models": {
    "anthropic-sdk/claude-opus-*": { "maxPrompts": 5, "interval": 50 }
  },
  "directories": {
    "~/projects/long-running": {
      "models": {
        "anthropic-sdk/claude-opus-*": { "maxPrompts": 60, "interval": 50, "wake": true, "prompt": "Continue." }
      }
    }
  }
}
```

The cache report line looks like `keepalive: warmed <session> ... cache read=N write=M`. For a `wake`
rule the counts are read before the model answers, so they show `read=0 write=0`. Use a rule
without `wake` to measure the cache.

## Limits

- Warm requests are real provider requests and cost tokens.
- A warm only helps if the provider keeps the cache that long. Anthropic needs its 1-hour cache
  lifetime enabled for a 50 minute interval to make sense. OpenAI cache retention varies by model.
- The plugin is written for OpenCode v2.0.20 and the v2 plugin API. v1 plugins have a different
  shape.

## License

This project is released under the [MIT License](/LICENSE).
