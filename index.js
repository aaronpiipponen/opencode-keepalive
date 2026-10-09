// opencode-keepalive — OpenCode v2 plugin
//
// Keeps the provider-side prompt cache of selected models warm while a session waits
// (e.g. an orchestrator blocked on a long subagent). OpenCode's built-in `warming`
// option is global; this one is per provider/model, so only the expensive orchestration
// models are warmed.
//
// Config (config.json next to this file, or the `config` plugin option): `models` maps
// a `provider/model` glob (`*` wildcard, first match wins) to
//   interval - minutes of silence before each warm, set just under the cache TTL
//   duration - minutes of warming after the session's last real request
//   sessions - which sessions the rule warms: "top" (default), "subagents" or "all"
// `prompt` is sent on every warm.
//
// Warming of a session stops at the end of `duration`, or earlier once the session is
// archived or removed.
//
// Mechanism: the `context` hook sees every real agent-loop request with its session and
// model, which (re)arms a timer for that session. A warm is a transient
// `session.generate`, so it does not touch history. A session counts as a subagent when it
// has a parent session.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MINUTE = 60_000
const SESSION_KINDS = ["top", "subagents", "all"]

function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  if (typeof raw.prompt !== "string" || !raw.prompt) throw new Error(`${file}: "prompt" must be a non-empty string`)
  const rules = Object.entries(raw.models ?? {}).map(([pattern, rule]) => {
    for (const key of ["interval", "duration"]) {
      if (!(rule?.[key] > 0)) throw new Error(`${file}: models["${pattern}"].${key} must be a positive number of minutes`)
    }
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    const sessions = rule.sessions ?? "top"
    if (!SESSION_KINDS.includes(sessions)) throw new Error(`${file}: models["${pattern}"].sessions must be one of ${SESSION_KINDS.join(", ")}`)
    return { pattern, regex: new RegExp(`^${source}$`), interval: rule.interval * MINUTE, duration: rule.duration * MINUTE, sessions }
  })
  return { prompt: raw.prompt, rules }
}

export default {
  id: "keepalive",
  setup(ctx) {
    // The TUI loads top-level plugins too, with a context that has no session hooks.
    if (typeof ctx?.session?.hook !== "function") return
    const file = ctx.options?.config ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json")
    const config = loadConfig(file)
    const sessions = new Map() // sessionID -> { timer, lastReal }
    const isChild = new Map() // sessionID -> boolean, parentID never changes

    const stop = (sessionID) => {
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.delete(sessionID)
    }

    const arm = (sessionID, rule, lastReal) => {
      const timer = setTimeout(async () => {
        if (Date.now() + rule.interval > lastReal + rule.duration) return stop(sessionID)
        // A removed or archived session is finished with; stop rather than ping it until the
        // duration window runs out. A failed lookup is read as removed.
        let info
        try {
          info = await ctx.session.get({ sessionID })
        } catch (error) {
          console.error(`keepalive: ${sessionID} not found, no longer warming it:`, error)
          return stop(sessionID)
        }
        if (info.time.archived) return stop(sessionID)
        try {
          await ctx.session.generate({ sessionID, prompt: config.prompt })
        } catch (error) {
          console.error(`keepalive: warm of ${sessionID} failed:`, error)
        }
        if (sessions.get(sessionID)?.lastReal === lastReal) arm(sessionID, rule, lastReal)
      }, rule.interval)
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.set(sessionID, { timer, lastReal })
    }

    const registration = ctx.session.hook("context", async (event) => {
      const rule = config.rules.find((r) => r.regex.test(`${event.model.providerID}/${event.model.id}`))
      if (!rule) return stop(event.sessionID)
      if (!isChild.has(event.sessionID)) isChild.set(event.sessionID, Boolean((await ctx.session.get({ sessionID: event.sessionID })).parentID))
      if (rule.sessions !== "all" && isChild.get(event.sessionID) !== (rule.sessions === "subagents")) return
      arm(event.sessionID, rule, Date.now())
    })

    return async () => {
      for (const sessionID of [...sessions.keys()]) stop(sessionID)
      await (await registration).dispose()
    }
  },
}
