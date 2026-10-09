import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PLUGIN = new URL("../index.js", import.meta.url).href
const STATE = Symbol.for("opencode.keepalive.state")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log("ok   " + name) }
  else { failed++; console.log("FAIL " + name + (extra ? "  -> " + extra : "")) }
}

async function load(config) {
  delete globalThis[STATE]
  const dir = mkdtempSync(path.join(tmpdir(), "ka-"))
  const file = path.join(dir, "config.json")
  writeFileSync(file, JSON.stringify(config))
  const mod = await import(PLUGIN + "?t=" + Math.random())
  return { setup: mod.default.setup, file }
}

async function mount(config, opts = {}) {
  const { setup, file } = await load(config)
  const hooks = {}
  const calls = { generate: [], prompt: [] }
  const logs = []
  const origError = console.error
  console.error = (...a) => logs.push(a.join(" "))
  const ctx = {
    options: { config: opts.file ?? file },
    session: {
      hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} } },
      get: async ({ sessionID }) => {
        const s = opts.get ? opts.get(sessionID) : {}
        return { parentID: opts.parentID, time: {}, tokens: { cache: { read: 0, write: 0 } }, ...s }
      },
      generate: async (a) => { calls.generate.push(a); opts.onGenerate?.(a) },
      prompt: async (a) => { calls.prompt.push(a) },
    },
  }
  const cleanup = setup(ctx)
  return { hooks, calls, logs, cleanup: async () => { await (await cleanup)(); console.error = origError } }
}

const arm = (hooks, sessionID, model, parentID) =>
  hooks.context({ sessionID, model: { providerID: model[0], id: model[1] } })

// --- config validation -------------------------------------------------------

{
  const base = { prompt: "P", models: { "*": { interval: 1, duration: 1 } } }
  for (const [name, cfg] of [
    ["no prompt", { models: {} }],
    ["bad sessions", { prompt: "P", models: { "*": { interval: 1, duration: 1, sessions: "x" } } }],
    ["bad interval", { prompt: "P", models: { "*": { interval: 0, duration: 1 } } }],
    ["bad maxSessions", { prompt: "P", maxSessions: 1.5, models: {} }],
    ["bad idleTimeout", { prompt: "P", idleTimeout: -1, models: {} }],
    ["bad autoTune", { prompt: "P", autoTune: "yes", models: {} }],
    ["bad wake", { prompt: "P", models: { "*": { interval: 1, duration: 1, wake: "x" } } }],
  ]) {
    let threw = false
    try { await mount(cfg) } catch { threw = true }
    check("rejects " + name, threw)
  }
}

// --- sessions filter ---------------------------------------------------------

async function sessionsCase(setting, parentID) {
  const m = await mount({ prompt: "P", models: { "*": { interval: 0.002, duration: 60, sessions: setting } } }, { parentID })
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  await m.cleanup()
  return m.calls.generate.length > 0
}
check("sessions top warms top", await sessionsCase("top", undefined))
check("sessions top skips child", !(await sessionsCase("top", "ses_parent")))
check("sessions subagents skips top", !(await sessionsCase("subagents", undefined)))
check("sessions subagents warms child", await sessionsCase("subagents", "ses_parent"))
check("sessions all warms top", await sessionsCase("all", undefined))
check("sessions all warms child", await sessionsCase("all", "ses_parent"))

// --- per-rule prompt and wake ------------------------------------------------

{
  const m = await mount({ prompt: "GLOBAL", models: { "*": { interval: 0.002, duration: 60, prompt: "RULE" } } })
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  check("per-rule prompt", m.calls.generate[0]?.prompt === "RULE", JSON.stringify(m.calls.generate[0]))
  await m.cleanup()
}
{
  const m = await mount({ prompt: "GLOBAL", models: { "*": { interval: 0.002, duration: 60, wake: true } } })
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  check("wake uses prompt", m.calls.prompt.length > 0 && m.calls.generate.length === 0)
  check("wake sends text", m.calls.prompt[0]?.text === "GLOBAL")
  await m.cleanup()
}

// --- idle timeout ------------------------------------------------------------

{
  const m = await mount(
    { prompt: "P", idleTimeout: 5, models: { "*": { interval: 0.002, duration: 60 } } },
    { get: () => ({ time: { viewed: Date.now() - 10 * 60000 } }) },
  )
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  check("idle timeout skips unseen session", m.calls.generate.length === 0)
  check("idle timeout logs", m.logs.some((l) => l.includes("unviewed")))
  await m.cleanup()
}
{
  const m = await mount(
    { prompt: "P", idleTimeout: 5, models: { "*": { interval: 0.002, duration: 60 } } },
    { get: () => ({ time: { viewed: Date.now() } }) },
  )
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  check("idle timeout warms seen session", m.calls.generate.length > 0)
  await m.cleanup()
}

// --- max sessions ------------------------------------------------------------

{
  const m = await mount({ prompt: "P", maxSessions: 2, models: { "*": { interval: 0.002, duration: 60 } } })
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(20)
  await arm(m.hooks, "s2", ["p", "m"])
  await sleep(20)
  await arm(m.hooks, "s3", ["p", "m"])
  await sleep(300)
  const ids = new Set(m.calls.generate.map((c) => c.sessionID))
  check("maxSessions warms at most 2", ids.size <= 2, [...ids].join(","))
  check("maxSessions drops oldest", !ids.has("s1"), [...ids].join(","))
  await m.cleanup()
}

// --- auto tune ---------------------------------------------------------------

async function tuneCase(autoTune) {
  let write = 0
  const m = await mount(
    { prompt: "P", autoTune, models: { "*": { interval: 0.002, duration: 60 } } },
    {
      get: () => ({ time: { viewed: Date.now() }, tokens: { cache: { read: 0, write } } }),
      onGenerate: () => { write += 1000 },
    },
  )
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(1500)
  await m.cleanup()
  return m.calls.generate.length
}
const off = await tuneCase(false)
const on = await tuneCase(true)
check("autoTune off does not shorten", off > 0)
check("autoTune shortens interval", on > off, `off=${off} on=${on}`)

// --- reporting ---------------------------------------------------------------

{
  let write = 0
  const m = await mount(
    { prompt: "P", models: { "*": { interval: 0.002, duration: 60 } } },
    { get: () => ({ time: { viewed: Date.now() }, tokens: { cache: { read: 0, write } } }), onGenerate: () => { write += 500 } },
  )
  await arm(m.hooks, "s1", ["p", "m"])
  await sleep(200)
  check("reports a warm with its cache delta", m.logs.some((l) => l.includes("warmed s1") && l.includes("write=")), m.logs.join(" | "))
  await m.cleanup()
}

// --- http prefix alignment ---------------------------------------------------

async function httpCase(primary, generate, want, opts = {}) {
  const m = await mount({ prompt: "P", models: { "*": { interval: 1000, duration: 60 } } }, opts)
  const sid = opts.sessionID ?? "s1"
  await arm(m.hooks, sid, ["p", "m"], opts.parentID)
  const primaryEvent = { sessionID: sid, kind: "primary", request: req(primary) }
  await m.hooks["http.request"](primaryEvent)
  const genEvent = { sessionID: sid, kind: "generate", request: req(generate) }
  await m.hooks["http.request"](genEvent)
  const got = JSON.parse(await genEvent.request.text())
  await m.cleanup()
  return got
}
function req(body) {
  return new Request("https://example.test/v1/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

{
  const p = { model: "c", system: [{ text: "cc1" }, { text: "cc-prompt" }], messages: [{ role: "user", content: "hi" }] }
  const g = { model: "c", system: [{ text: "cc1" }, { text: "default-prompt" }], messages: [{ role: "user", content: "hi" }, { role: "user", content: "warm" }] }
  const got = await httpCase(p, g, null)
  check("anthropic system realigned", same(got.system, p.system), JSON.stringify(got.system))
  check("anthropic messages untouched", same(got.messages, g.messages))
}
{
  const p = { instructions: "primary-instructions", input: [{ role: "user", content: "hi" }] }
  const g = { instructions: "generate-instructions", input: [{ role: "user", content: "hi" }, { role: "user", content: "warm" }] }
  const got = await httpCase(p, g, null)
  check("responses instructions realigned", got.instructions === p.instructions)
  check("responses input untouched", same(got.input, g.input))
}
{
  const p = { messages: [{ role: "system", content: "primary-sys" }, { role: "user", content: "hi" }] }
  const g = { messages: [{ role: "system", content: "gen-sys" }, { role: "user", content: "hi" }, { role: "user", content: "warm" }] }
  const got = await httpCase(p, g, null)
  check("chat system message realigned", got.messages[0].content === "primary-sys")
  check("chat history preserved", same(got.messages.slice(1), g.messages.slice(1)))
}
{
  const p = { instructions: "same", input: [{ role: "user", content: "hi" }] }
  const g = { instructions: "same", input: [{ role: "user", content: "hi" }, { role: "user", content: "warm" }] }
  const got = await httpCase(p, g, null)
  check("identical prefix is a no-op", same(got, g))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
