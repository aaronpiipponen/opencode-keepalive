// opencode-keepalive — OpenCode v2 plugin
//
// Keeps the provider-side prompt cache of selected models warm while a session waits
// (e.g. an orchestrator blocked on a long subagent). OpenCode's built-in `warming`
// option is global; this one is per provider/model, so only the expensive orchestration
// models are warmed.
//
// Config (config.json next to this file, or the `config` plugin option):
//   prompt      - the default keepalive message
//   maxSessions - optional cap on how many sessions are warmed at once (0 = no cap); the
//                 least recently active warmed session is dropped first
//   idleTimeout - optional minutes; a session no one has viewed within this window stops
//                 being warmed (0 = off)
//   autoTune    - optional; when true, an interval that keeps missing the cache is shortened
//   models      - maps a `provider/model` glob (`*` wildcard, first match wins) to a rule:
//     interval  - minutes of silence before each warm
//     duration  - minutes of warming after the session's last real request
//     sessions  - "top" (default), "subagents" or "all"
//     prompt    - optional per-rule message
//     wake      - optional; when true the message is admitted into the chat and the model
//                 runs, instead of a transient warm, so a rule can act as an idle timer
//
// A warm is a transient `session.generate`, so it does not touch history. Warming stops at
// the end of `duration`, or earlier once the session is archived, removed, or (with
// `idleTimeout`) unviewed.

import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MINUTE = 60_000
const SESSION_KINDS = ["top", "subagents", "all"]
// Auto-tune shortens by this factor and never drops below a quarter of the configured interval.
const TUNE_STEP = 0.8

// OpenCode runs setup once per location, and every instance sees every session, so the timers
// live in process-wide state: one timer per session however many instances are loaded.
const STATE = Symbol.for("opencode.keepalive.state")

function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"))
  if (typeof raw.prompt !== "string" || !raw.prompt) throw new Error(`${file}: "prompt" must be a non-empty string`)

  const maxSessions = raw.maxSessions ?? 0
  if (!Number.isInteger(maxSessions) || maxSessions < 0) throw new Error(`${file}: "maxSessions" must be a whole number of sessions`)
  const idleTimeout = raw.idleTimeout ?? 0
  if (!(idleTimeout >= 0)) throw new Error(`${file}: "idleTimeout" must be a number of minutes`)
  const autoTune = raw.autoTune === true
  if (raw.autoTune !== undefined && typeof raw.autoTune !== "boolean") throw new Error(`${file}: "autoTune" must be true or false`)

  const rules = Object.entries(raw.models ?? {}).map(([pattern, rule]) => {
    for (const key of ["interval", "duration"]) {
      if (!(rule?.[key] > 0)) throw new Error(`${file}: models["${pattern}"].${key} must be a positive number of minutes`)
    }
    const sessions = rule.sessions ?? "top"
    if (!SESSION_KINDS.includes(sessions)) throw new Error(`${file}: models["${pattern}"].sessions must be one of ${SESSION_KINDS.join(", ")}`)
    if (rule.prompt !== undefined && (typeof rule.prompt !== "string" || !rule.prompt)) throw new Error(`${file}: models["${pattern}"].prompt must be a non-empty string`)
    if (rule.wake !== undefined && typeof rule.wake !== "boolean") throw new Error(`${file}: models["${pattern}"].wake must be true or false`)
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    return {
      pattern,
      regex: new RegExp(`^${source}$`),
      interval: rule.interval * MINUTE,
      duration: rule.duration * MINUTE,
      sessions,
      prompt: rule.prompt ?? raw.prompt,
      wake: rule.wake === true,
    }
  })
  return { maxSessions, idleTimeout, autoTune, rules }
}

// The cache token counters are cumulative, so a warm's effect is the difference across it.
function cacheDelta(before, after) {
  return {
    read: (after?.cache?.read ?? 0) - (before?.cache?.read ?? 0),
    write: (after?.cache?.write ?? 0) - (before?.cache?.write ?? 0),
  }
}

function isSystemRole(role) {
  return role === "system" || role === "developer"
}

// The system-defining prefix that a real request and its warm must share for the provider's
// prompt cache to be reused. Providers shape it three ways: Anthropic Messages uses `system`,
// OpenAI Responses uses `instructions`, and OpenAI Chat Completions carries it as leading
// system/developer messages. Returns the field name and its value, or null for an unknown shape.
function systemPrefix(body) {
  if (body.system !== undefined) return { field: "system", value: body.system }
  if (body.instructions !== undefined) return { field: "instructions", value: body.instructions }
  if (Array.isArray(body.messages)) {
    let end = 0
    while (end < body.messages.length && isSystemRole(body.messages[end]?.role)) end++
    if (end > 0) return { field: "messages", value: body.messages.slice(0, end) }
  }
  return null
}

// Copy the captured prefix onto a warm body of the same shape, or return null when the warm
// has no such field to replace.
function applyPrefix(body, prefix) {
  if (prefix.field === "system" && body.system !== undefined) return { ...body, system: prefix.value }
  if (prefix.field === "instructions" && body.instructions !== undefined) return { ...body, instructions: prefix.value }
  if (prefix.field === "messages" && Array.isArray(body.messages)) {
    let end = 0
    while (end < body.messages.length && isSystemRole(body.messages[end]?.role)) end++
    if (end === 0) return null
    return { ...body, messages: [...prefix.value, ...body.messages.slice(end)] }
  }
  return null
}

export default {
  id: "keepalive",
  setup(ctx) {
    // The TUI loads top-level plugins too, with a context that has no session hooks.
    if (typeof ctx?.session?.hook !== "function") return
    const file = ctx.options?.config ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json")
    const config = loadConfig(file)

    // A reloaded plugin finds the state of the previous load, so each map is created on demand.
    const shared = (globalThis[STATE] ??= {})
    const sessions = (shared.sessions ??= new Map()) // sessionID -> { timer, lastReal, owner }, owner being the arming instance's ctx
    const isChild = (shared.isChild ??= new Map()) // sessionID -> boolean, parentID never changes
    const systems = (shared.systems ??= new Map()) // sessionID -> system array of the last real Anthropic-shaped request
    const tuned = (shared.tuned ??= new Map()) // rule pattern -> interval shortened by auto-tune

    const stop = (sessionID) => {
      systems.delete(sessionID)
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.delete(sessionID)
    }

    const warm = async (sessionID, rule, lastReal) => {
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
      if (config.idleTimeout > 0) {
        const viewed = info.time.viewed ?? info.time.idle ?? info.time.updated
        if (viewed && Date.now() - viewed > config.idleTimeout * MINUTE) {
          console.error(`keepalive: ${sessionID} unviewed for over ${config.idleTimeout} min, no longer warming it`)
          return stop(sessionID)
        }
      }
      const before = info.tokens ?? {}
      try {
        if (rule.wake) await ctx.session.prompt({ sessionID, text: rule.prompt })
        else await ctx.session.generate({ sessionID, prompt: rule.prompt })
      } catch (error) {
        console.error(`keepalive: warm of ${sessionID} failed:`, error)
      }
      let after = before
      try {
        after = (await ctx.session.get({ sessionID })).tokens ?? before
      } catch {
        // The session went away between the warm and the read; report what we have.
      }
      const delta = cacheDelta(before, after)
      console.error(`keepalive: warmed ${sessionID} (${rule.pattern}) cache read=${delta.read} write=${delta.write}`)
      if (config.autoTune && delta.write > delta.read && delta.read + delta.write > 0) {
        const current = tuned.get(rule.pattern) ?? rule.interval
        tuned.set(rule.pattern, Math.max(rule.interval / 4, current * TUNE_STEP))
      }
    }

    const arm = (sessionID, rule, lastReal) => {
      const interval = tuned.get(rule.pattern) ?? rule.interval
      const timer = setTimeout(async () => {
        if (Date.now() + interval > lastReal + rule.duration) return stop(sessionID)
        await warm(sessionID, rule, lastReal)
        if (sessions.get(sessionID)?.lastReal === lastReal) arm(sessionID, rule, lastReal)
      }, interval)
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.set(sessionID, { timer, lastReal, owner: ctx })
    }

    const admit = (sessionID, rule, lastReal) => {
      if (!sessions.has(sessionID) && config.maxSessions > 0 && sessions.size >= config.maxSessions) {
        let oldest
        for (const entry of sessions) if (!oldest || entry[1].lastReal < oldest[1].lastReal) oldest = entry
        if (oldest) stop(oldest[0])
      }
      arm(sessionID, rule, lastReal)
    }

    const registration = ctx.session.hook("context", async (event) => {
      const rule = config.rules.find((r) => r.regex.test(`${event.model.providerID}/${event.model.id}`))
      if (!rule) return stop(event.sessionID)
      if (!isChild.has(event.sessionID)) isChild.set(event.sessionID, Boolean((await ctx.session.get({ sessionID: event.sessionID })).parentID))
      if (rule.sessions !== "all" && isChild.get(event.sessionID) !== (rule.sessions === "subagents")) return
      admit(event.sessionID, rule, Date.now())
    })

    // A warm built by session.generate can carry a different system prompt than the agent loop's
    // requests, so it misses the real conversation's cache from the system prompt onward. This
    // happens with the Anthropic provider plugin, which sets its prompt only through the `context`
    // hook, and the `context` hook does not run for the `generate` kind. Send the last real
    // request's system prefix on every warm, for whichever shape the provider uses.
    const httpRegistration = ctx.session.hook("http.request", async (event) => {
      if (!sessions.has(event.sessionID) || (event.kind !== "primary" && event.kind !== "generate")) return
      const body = await event.request.clone().json()
      const prefix = systemPrefix(body)
      if (!prefix) return
      if (event.kind === "primary") return void systems.set(event.sessionID, prefix)
      const primary = systems.get(event.sessionID)
      if (!primary) return
      const aligned = applyPrefix(body, primary)
      if (!aligned) return
      const headers = new Headers(event.request.headers)
      headers.delete("content-length")
      event.request = new Request(event.request.url, { method: event.request.method, headers, body: JSON.stringify(aligned) })
    })

    return async () => {
      for (const [sessionID, session] of [...sessions]) if (session.owner === ctx) stop(sessionID)
      await (await registration).dispose()
      await (await httpRegistration).dispose()
    }
  },
}
