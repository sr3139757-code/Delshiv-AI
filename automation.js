// Workflow macros + daily briefing builder for Delshiv AI.
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";

const MAX_MACROS = 50;
const MAX_STEPS = 12;

/** Step grammar: "app:<name>" or "url:<https://...>" — no raw commands, so macros can't smuggle shell access. */
export function parseStep(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(app|url):\s*(.+)$/i);
  if (!m) throw new Error(`Invalid step "${s}". Use "app:<name>" or "url:<https://...>".`);
  const kind = m[1].toLowerCase();
  const value = m[2].trim();
  if (kind === "url") {
    let u;
    try { u = new URL(value); } catch { throw new Error(`Invalid URL in step "${s}".`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`Only http/https URLs are allowed in macros: "${s}".`);
    return { kind, value: u.toString() };
  }
  if (!/^[\w .\-+]{1,40}$/.test(value)) throw new Error(`Invalid app name in step "${s}".`);
  return { kind, value };
}

export function createMacroStore({ filePath, log = () => {} }) {
  const loaded = readJsonSafe(filePath, { macros: [] }, log);
  let macros = Array.isArray(loaded?.macros)
    ? loaded.macros.filter((m) => m && typeof m.name === "string" && Array.isArray(m.steps))
    : [];

  const save = (nextMacros = macros) => atomicWriteJson(filePath, { macros: nextMacros });
  const norm = (n) => String(n || "").trim().toLowerCase();

  return {
    list: () => macros.slice(),
    get: (name) => macros.find((m) => norm(m.name) === norm(name)) || null,
    create(name, steps) {
      const n = String(name || "").trim();
      if (!n || n.length > 40) throw new Error("Macro name is required (max 40 chars).");
      if (!Array.isArray(steps) || !steps.length) throw new Error("Macro needs at least one step.");
      if (steps.length > MAX_STEPS) throw new Error(`Macro can have at most ${MAX_STEPS} steps.`);
      const parsed = steps.map(parseStep);
      const existing = macros.findIndex((m) => norm(m.name) === norm(n));
      if (existing === -1 && macros.length >= MAX_MACROS) throw new Error(`Macro limit (${MAX_MACROS}) reached.`);
      const macro = { name: n, steps: parsed.map((p) => `${p.kind}:${p.value}`), updatedAt: new Date().toISOString() };
      const next = macros.slice();
      if (existing >= 0) next[existing] = macro;
      else next.push(macro);
      save(next);
      macros = next;
      return macro;
    },
    remove(name) {
      const i = macros.findIndex((m) => norm(m.name) === norm(name));
      if (i === -1) throw new Error(`Macro "${name}" not found.`);
      const removed = macros[i];
      const next = macros.filter((_, idx) => idx !== i);
      save(next);
      macros = next;
      return removed;
    },
  };
}

/** Pure text builder — every line comes from the data passed in. */
export function buildBriefingText({ name = "BOSS", now = new Date(), pendingTasks = [], upcoming = [], headlines = null, headlinesGap = "" } = {}) {
  const hour = now.getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const lines = [`${greet}, ${name}! Today is ${now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}.`];

  if (pendingTasks.length) {
    lines.push(`📝 ${pendingTasks.length} pending task${pendingTasks.length > 1 ? "s" : ""}: ${pendingTasks.slice(0, 4).map((t) => t.title).join("; ")}${pendingTasks.length > 4 ? "…" : ""}`);
  } else lines.push("📝 No pending tasks.");

  if (upcoming.length) {
    lines.push(`⏰ Next 24h: ${upcoming.slice(0, 4).map((s) => `${s.taskName} (${new Date(s.nextRunAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })})`).join("; ")}`);
  } else lines.push("⏰ Nothing scheduled in the next 24 hours.");

  if (headlines && headlines.length) lines.push(`📰 ${headlines.slice(0, 3).map((h) => h.title).join(" | ")}`);
  else lines.push(`📰 Headlines unavailable${headlinesGap ? ` (${headlinesGap})` : ""}.`);
  return lines.join("\n");
}
