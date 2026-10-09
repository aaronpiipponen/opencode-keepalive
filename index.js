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
//   logFile     - optional; a file to append report lines to (relative to the config file).
//                 OpenCode does not capture plugin console output, so this is the way to see
//                 the per-warm cache read/write report
//   models      - maps a `provider/model` glob (`*` wildcard, first match wins) to a rule:
//     enabled   - optional; default true. False turns the rule off without deleting it
//     maxPrompts- how many warm/wake prompts to send per idle spell, then stop until the
//                 next genuine user prompt. Counts the same for wake and non-wake rules
//     interval  - minutes of silence before each prompt
//     sessions  - "top" (default), "subagents" or "all"
//     prompt    - optional per-rule message
//     wake      - optional; when true the message is admitted into the chat and the model
//                 runs, instead of a transient warm
//
// A spell starts at a genuine user prompt and lasts until `maxPrompts` prompts have been sent
// (or the session is archived, removed, disabled, or unviewed past `idleTimeout`). A wake is a
// real turn, so it does not reset its own spell.
//
// The config file is watched, so edits (including `enabled`) apply on save with no restart.
//
// A non-wake warm is a transient `session.generate`, so it does not touch history.

import { appendFileSync, readFileSync, watch } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MINUTE = 60_000
const SESSION_KINDS = ["top", "subagents", "all"]
// Auto-tune shortens by this factor and never drops below a quarter of the configured interval.
const TUNE_STEP = 0.8
// A config save arrives as a burst of filesystem events; coalesce them.
const RELOAD_DEBOUNCE = 150
// Marks the plugin's own wake prompts so the prompt hook can tell them from a real user prompt.
const WAKE_METADATA = { keepalive: true }

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
  if (raw.logFile !== undefined && (typeof raw.logFile !== "string" || !raw.logFile)) throw new Error(`${file}: "logFile" must be a non-empty path`)
  const logFile = raw.logFile === undefined ? undefined : path.resolve(path.dirname(file), raw.logFile)

  const rules = Object.entries(raw.models ?? {}).map(([pattern, rule]) => {
    if (!Number.isInteger(rule?.maxPrompts) || rule.maxPrompts < 1) throw new Error(`${file}: models["${pattern}"].maxPrompts must be a whole number of at least 1`)
    if (!(rule?.interval > 0)) throw new Error(`${file}: models["${pattern}"].interval must be a positive number of minutes`)
    const sessions = rule.sessions ?? "top"
    if (!SESSION_KINDS.includes(sessions)) throw new Error(`${file}: models["${pattern}"].sessions must be one of ${SESSION_KINDS.join(", ")}`)
    if (rule.prompt !== undefined && (typeof rule.prompt !== "string" || !rule.prompt)) throw new Error(`${file}: models["${pattern}"].prompt must be a non-empty string`)
    if (rule.wake !== undefined && typeof rule.wake !== "boolean") throw new Error(`${file}: models["${pattern}"].wake must be true or false`)
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") throw new Error(`${file}: models["${pattern}"].enabled must be true or false`)
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    return {
      pattern,
      regex: new RegExp(`^${source}$`),
      enabled: rule.enabled !== false,
      maxPrompts: rule.maxPrompts,
      interval: rule.interval * MINUTE,
      sessions,
      prompt: rule.prompt ?? raw.prompt,
      wake: rule.wake === true,
    }
  })
  return { maxSessions, idleTimeout, autoTune, logFile, rules }
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

function ruleFor(config, model) {
  return config.rules.find((r) => r.regex.test(model))
}

function scopeAllows(rule, child) {
  return rule.sessions === "all" || child === (rule.sessions === "subagents")
}

export default {
  id: "keepalive",
  setup(ctx) {
    // The TUI loads top-level plugins too, with a context that has no session hooks.
    if (typeof ctx?.session?.hook !== "function") return
    const file = ctx.options?.config ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "config.json")

    // A reloaded plugin finds the state of the previous load, so each map is created on demand.
    const shared = (globalThis[STATE] ??= {})
    const sessions = (shared.sessions ??= new Map()) // sessionID -> { timer, lastReal, owner, model, child }
    const isChild = (shared.isChild ??= new Map()) // sessionID -> boolean, parentID never changes
    const spells = (shared.spells ??= new Map()) // sessionID -> prompts sent in the current idle spell
    const systems = (shared.systems ??= new Map()) // sessionID -> system prefix of the last real request
    const tuned = (shared.tuned ??= new Map()) // rule pattern -> interval shortened by auto-tune
    const configs = (shared.configs ??= new Map()) // config file -> loaded config
    const watchers = (shared.watchers ??= new Map()) // config file -> directory watcher

    if (!configs.has(file)) configs.set(file, loadConfig(file))
    const current = () => configs.get(file)

    // OpenCode does not capture plugin console output, so reports go to `logFile` when set.
    const log = (line) => {
      const target = current().logFile
      if (!target) return
      try {
        appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // A failed log write must not break warming.
      }
    }

    const stop = (sessionID) => {
      systems.delete(sessionID)
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.delete(sessionID)
    }

    const arm = (sessionID, rule, session) => {
      const interval = tuned.get(rule.pattern) ?? rule.interval
      const timer = setTimeout(async () => {
        if ((spells.get(sessionID) ?? 0) >= rule.maxPrompts) return stop(sessionID)
        await warm(sessionID, rule)
        if (sessions.get(sessionID)?.lastReal === session.lastReal) arm(sessionID, rule, session)
      }, interval)
      clearTimeout(sessions.get(sessionID)?.timer)
      sessions.set(sessionID, { ...session, timer, owner: ctx })
    }

    const warm = async (sessionID, rule) => {
      const config = current()
      // A removed or archived session is finished with; stop rather than prompt it further. A
      // failed lookup is read as removed.
      let info
      try {
        info = await ctx.session.get({ sessionID })
      } catch (error) {
        log(`keepalive: ${sessionID} not found, no longer warming it:`, error)
        return stop(sessionID)
      }
      if (info.time.archived) return stop(sessionID)
      if (config.idleTimeout > 0) {
        const viewed = info.time.viewed ?? info.time.idle ?? info.time.updated
        if (viewed && Date.now() - viewed > config.idleTimeout * MINUTE) {
          log(`keepalive: ${sessionID} unviewed for over ${config.idleTimeout} min, no longer warming it`)
          return stop(sessionID)
        }
      }
      const before = info.tokens ?? {}
      try {
        if (rule.wake) await ctx.session.prompt({ sessionID, text: rule.prompt, metadata: WAKE_METADATA })
        else await ctx.session.generate({ sessionID, prompt: rule.prompt })
      } catch (error) {
        log(`keepalive: warm of ${sessionID} failed:`, error)
      }
      // Count this prompt against the spell before the wake's own turn can re-arm.
      spells.set(sessionID, (spells.get(sessionID) ?? 0) + 1)
      let after = before
      try {
        after = (await ctx.session.get({ sessionID })).tokens ?? before
      } catch {
        // The session went away between the warm and the read; report what we have.
      }
      const delta = cacheDelta(before, after)
      log(`keepalive: warmed ${sessionID} (${rule.pattern}) cache read=${delta.read} write=${delta.write}`)
      if (config.autoTune && delta.write > delta.read && delta.read + delta.write > 0) {
        const at = tuned.get(rule.pattern) ?? rule.interval
        tuned.set(rule.pattern, Math.max(rule.interval / 4, at * TUNE_STEP))
      }
    }

    const admit = (sessionID, rule, model, child) => {
      const config = current()
      if (!sessions.has(sessionID) && config.maxSessions > 0 && sessions.size >= config.maxSessions) {
        let oldest
        for (const entry of sessions) if (!oldest || entry[1].lastReal < oldest[1].lastReal) oldest = entry
        if (oldest) stop(oldest[0])
      }
      arm(sessionID, rule, { lastReal: Date.now(), model, child })
    }

    // Re-check every warmed session against the current config after a reload, so an edit that
    // disables a rule, changes its interval, or stops matching a model takes effect at once.
    const reapply = () => {
      const config = current()
      for (const [sessionID, session] of [...sessions]) {
        const rule = ruleFor(config, session.model)
        if (!rule || !rule.enabled || !scopeAllows(rule, session.child)) stop(sessionID)
        else arm(sessionID, rule, session)
      }
    }

    if (!watchers.has(file)) {
      try {
        const watcher = watch(path.dirname(file), { persistent: false }, (_event, name) => {
          if (name && name !== path.basename(file)) return
          clearTimeout(watcher.timer)
          watcher.timer = setTimeout(() => {
            try {
              configs.set(file, loadConfig(file))
            } catch (error) {
              log(`keepalive: config reload failed, keeping the previous settings:`, error)
              return
            }
            log(`keepalive: config reloaded (${configs.get(file).rules.length} rules)`)
            reapply()
          }, RELOAD_DEBOUNCE)
        })
        watchers.set(file, watcher)
      } catch (error) {
        log(`keepalive: could not watch ${file} for changes:`, error)
      }
    }

    // A genuine user prompt starts a new spell. The plugin's own wake prompts carry metadata and
    // are ignored, so a wake turn cannot reset (and so loop) its own spell.
    const promptRegistration = ctx.session.hook("prompt", (event) => {
      if (event.metadata?.keepalive === true) return
      spells.set(event.sessionID, 0)
    })

    const registration = ctx.session.hook("context", async (event) => {
      const model = `${event.model.providerID}/${event.model.id}`
      const rule = ruleFor(current(), model)
      if (!rule || !rule.enabled) return stop(event.sessionID)
      if ((spells.get(event.sessionID) ?? 0) >= rule.maxPrompts) return stop(event.sessionID)
      if (!isChild.has(event.sessionID)) isChild.set(event.sessionID, Boolean((await ctx.session.get({ sessionID: event.sessionID })).parentID))
      if (!scopeAllows(rule, isChild.get(event.sessionID))) return
      admit(event.sessionID, rule, model, isChild.get(event.sessionID))
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
      await (await promptRegistration).dispose()
      await (await registration).dispose()
      await (await httpRegistration).dispose()
    }
  },
}
