// Autonomous Scheduler Engine for Delshiv AI.
// Dependency-free: 5-field cron parsing, one-shot delays/timestamps, JSON persistence, tick loop.
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";

const TICK_MS = 10_000;
const MAX_TASKS = 200;
const MIN_RECURRING_MS = 60_000;
const MAX_DELAY_MS = 366 * 24 * 3600 * 1000;

// ───────── Cron ─────────
const FIELD_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (7 → 0)
];

function parseField(src, [min, max], isDow) {
  const out = new Set();
  const effectiveMax = isDow ? 7 : max;
  for (const part of src.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`Invalid cron field "${src}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Invalid cron step in "${src}"`);
    let lo, hi;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else if (m[1].includes("-")) {
      [lo, hi] = m[1].split("-").map(Number);
    } else {
      lo = Number(m[1]);
      hi = m[2] ? effectiveMax : lo;
    }
    if (lo < min || hi > effectiveMax || lo > hi) throw new Error(`Cron value out of range in "${src}"`);
    for (let v = lo; v <= hi; v += step) {
      out.add(isDow && v === 7 ? 0 : v);
    }
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron must have 5 fields (min hour dom mon dow), got "${expr}"`);
  const sets = parts.map((p, i) => parseField(p, FIELD_RANGES[i], i === 4));
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function isCronExpression(s) {
  try {
    parseCron(s);
    return true;
  } catch {
    return false;
  }
}

/** Next matching minute strictly after `fromMs` (local time). */
export function nextCronRun(expr, fromMs = Date.now()) {
  const { sets, domStar, dowStar } = parseCron(expr);
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  if (d.getTime() <= fromMs) d.setTime(fromMs + 60_000);
  const limit = fromMs + 5 * 366 * 24 * 3600 * 1000;

  while (d.getTime() <= limit) {
    if (!sets[3].has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = sets[2].has(d.getDate());
    const dowOk = sets[4].has(d.getDay());
    const dayOk = !domStar && !dowStar ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!sets[1].has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!sets[0].has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    if (d.getTime() <= fromMs) {
      d.setTime(d.getTime() + 60_000);
      continue;
    }
    return d.getTime();
  }
  throw new Error(`Cron "${expr}" never fires.`);
}

// ───────── Schedule resolution ─────────
export function resolveSchedule({ scheduleType, cronOrDelay }, now = Date.now()) {
  const raw = typeof cronOrDelay === "string" ? cronOrDelay.trim() : cronOrDelay;
  if (raw === "" || raw === undefined || raw === null) throw new Error("cronOrDelay is required.");
  const type = String(scheduleType || "").toLowerCase();
  if (type && type !== "oneshot" && type !== "recurring") {
    throw new Error(`scheduleType must be "oneshot" or "recurring", got "${scheduleType}".`);
  }

  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const ms = Number(raw);
    if (!Number.isFinite(ms)) throw new Error("Delay must be a finite number of milliseconds.");
    if (type === "recurring") {
      if (ms < MIN_RECURRING_MS || ms > MAX_DELAY_MS) {
        throw new Error("Recurring interval must be between 60000 ms and one year; use a cron expression for calendar schedules.");
      }
      return { scheduleType: "recurring", cronOrDelay: String(ms), nextRunAt: now + ms };
    }
    if (ms < 0 || ms > MAX_DELAY_MS) throw new Error("Delay must be between 0 ms and one year.");
    return { scheduleType: "oneshot", cronOrDelay: String(ms), nextRunAt: now + ms };
  }

  const str = String(raw);
  if (isCronExpression(str)) {
    if (type === "oneshot") return { scheduleType: "oneshot", cronOrDelay: str, nextRunAt: nextCronRun(str, now) };
    return { scheduleType: "recurring", cronOrDelay: str, nextRunAt: nextCronRun(str, now) };
  }

  const ts = /^[\d*/,\-]+(\s+[\d*/,\-]+){4}$/.test(str) ? NaN : Date.parse(str);
  if (Number.isNaN(ts)) throw new Error(`cronOrDelay "${str}" is not a cron expression, millisecond delay, or ISO timestamp.`);
  if (type === "recurring") throw new Error("A recurring task needs a cron expression or interval, not a timestamp.");
  if (ts < now - 60_000) throw new Error(`Timestamp ${str} is in the past.`);
  return { scheduleType: "oneshot", cronOrDelay: new Date(ts).toISOString(), nextRunAt: Math.max(ts, now) };
}

// ───────── Engine ─────────
export function createScheduler({ filePath, onDue, log = () => {} }) {
  let tasks = [];
  let timer = null;
  let running = false;

  function load() {
    const parsed = readJsonSafe(filePath, { tasks: [] }, log);
    const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    tasks = list.filter((t) => t && typeof t === "object" && typeof t.taskName === "string" && Number.isFinite(Number(t.nextRunAt)));
  }

  function save(nextTasks = tasks) {
    atomicWriteJson(filePath, { tasks: nextTasks });
  }

  function normalizePayload(p) {
    if (p && typeof p === "object") {
      const type = ["command", "briefing", "macro"].includes(p.type) ? p.type : "notify";
      return {
        type,
        text: String(p.text || p.message || "").slice(0, 500),
        command: String(p.command || "").slice(0, 2000),
        macro: String(p.macro || "").slice(0, 40),
      };
    }
    return { type: "notify", text: String(p || "").slice(0, 500), command: "", macro: "" };
  }

  function add(input = {}) {
    const taskName = String(input.taskName || "").trim();
    if (!taskName) throw new Error("taskName is required.");
    if (tasks.length >= MAX_TASKS) throw new Error(`Schedule limit (${MAX_TASKS}) reached. Cancel some tasks first.`);
    const sched = resolveSchedule(input);
    const actionPayload = normalizePayload(input.actionPayload);
    if (actionPayload.type === "command" && !actionPayload.command) throw new Error("A command action needs actionPayload.command.");
    if (actionPayload.type === "macro" && !actionPayload.macro) throw new Error("A macro action needs actionPayload.macro.");
    if (actionPayload.type === "notify" && !actionPayload.text) actionPayload.text = taskName;
    const task = {
      id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      taskName,
      scheduleType: sched.scheduleType,
      cronOrDelay: sched.cronOrDelay,
      actionPayload,
      createdAt: new Date().toISOString(),
      nextRunAt: sched.nextRunAt,
      lastRunAt: null,
      runCount: 0,
    };
    const next = [...tasks, task];
    save(next);
    tasks = next;
    return task;
  }

  function findTask(idOrName) {
    const raw = String(idOrName || "").trim();
    const q = raw.toLowerCase();
    if (!q) throw new Error("Task id or name is required.");
    const exact = tasks.find((t) => t.id === raw || t.taskName.toLowerCase() === q);
    if (exact) return exact;
    const matches = tasks.filter((t) => t.taskName.toLowerCase().includes(q));
    if (matches.length > 1) {
      throw new Error(`"${raw}" matches ${matches.length} scheduled tasks. Provide an exact task ID.`);
    }
    return matches[0] || null;
  }

  function cancel(idOrName) {
    const t = findTask(idOrName);
    if (!t) throw new Error(`Scheduled task "${idOrName}" not found.`);
    const next = tasks.filter((x) => x !== t);
    save(next);
    tasks = next;
    return t;
  }

  function list() {
    return tasks
      .slice()
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .map((t) => ({ ...t, nextRun: new Date(t.nextRunAt).toLocaleString() }));
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      const due = tasks.filter((t) => t.nextRunAt <= now).map((t) => ({ t, missedByMs: now - t.nextRunAt }));
      if (!due.length) return;

      const updatedById = new Map();
      const removeIds = new Set();

      for (const { t } of due) {
        const clone = { ...t, lastRunAt: new Date(now).toISOString(), runCount: (t.runCount || 0) + 1 };
        if (t.scheduleType === "recurring") {
          try {
            if (/^\d+$/.test(t.cronOrDelay)) {
              const stepMs = Math.max(MIN_RECURRING_MS, Number(t.cronOrDelay));
              let nextAt = t.nextRunAt + stepMs;
              if (nextAt <= now) {
                const steps = Math.floor((now - t.nextRunAt) / stepMs) + 1;
                nextAt = t.nextRunAt + steps * stepMs;
              }
              clone.nextRunAt = nextAt;
            } else {
              clone.nextRunAt = nextCronRun(t.cronOrDelay, now);
            }
            updatedById.set(t.id, clone);
          } catch (err) {
            log(`scheduler reschedule (${t.taskName})`, err);
            removeIds.add(t.id);
          }
        } else {
          removeIds.add(t.id);
        }
      }

      const nextTasks = tasks
        .filter((x) => !removeIds.has(x.id))
        .map((x) => updatedById.get(x.id) || x);

      save(nextTasks);
      tasks = nextTasks;

      for (const { t, missedByMs } of due) {
        try {
          await onDue(t, { missedByMs });
        } catch (err) {
          log(`scheduler action (${t.taskName})`, err);
        }
      }
    } catch (err) {
      log("scheduler tick", err);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    load();
    timer = setInterval(tick, TICK_MS);
    void tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, add, cancel, list, tick, now: () => ({ iso: new Date().toISOString(), local: new Date().toString() }) };
}
