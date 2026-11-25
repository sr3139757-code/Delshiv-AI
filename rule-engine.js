// Event/Trigger-based Automation Rules Engine for Delshiv AI.
// Supports: battery_low, cpu_high, downloads_new_file. Persists in rules.json.
import fs from "fs";
import os from "os";
import path from "path";
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";

const TICK_MS = 60_000;
const MAX_RULES = 40;
const TRIGGERS = ["battery_low", "cpu_high", "downloads_new_file"];
const ACTIONS = ["notify", "summarize_doc"];

export function createRuleEngine({ filePath, downloadsDir, getHealth, onTrigger, log = () => {} }) {
  let rules = [];
  let timer = null;
  let dlWatcher = null;
  let checking = false;
  const cooldownUntil = new Map();
  const seenDownloads = new Set();
  const pendingTimers = new Set();

  function load() {
    const parsed = readJsonSafe(filePath, { rules: [] }, log);
    rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  }

  function save(nextRules = rules) {
    atomicWriteJson(filePath, { rules: nextRules });
  }

  function add({ name, trigger, threshold = null, ext = "*", action = "notify" } = {}) {
    const trig = String(trigger || "").toLowerCase().trim();
    if (!TRIGGERS.includes(trig)) throw new Error(`trigger must be one of: ${TRIGGERS.join(", ")}`);
    const act = String(action || "notify").toLowerCase().trim();
    if (!ACTIONS.includes(act)) throw new Error(`action must be one of: ${ACTIONS.join(", ")}`);
    const cleanName = String(name || `${trig} rule`).trim().slice(0, 60);
    if (rules.length >= MAX_RULES) throw new Error(`Rule limit (${MAX_RULES}) reached.`);

    let parsedThreshold = null;
    if (trig === "battery_low" || trig === "cpu_high") {
      if (threshold === null || threshold === undefined || threshold === "") {
        parsedThreshold = trig === "battery_low" ? 20 : 90;
      } else {
        const n = Number(threshold);
        if (!Number.isFinite(n) || n < 1 || n > 100) {
          throw new Error(`threshold for ${trig} must be a number between 1 and 100.`);
        }
        parsedThreshold = Math.round(n);
      }
    }

    const rule = {
      id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      trigger: trig,
      threshold: parsedThreshold,
      ext: trig === "downloads_new_file" ? String(ext || "*").toLowerCase().trim() : null,
      action: act,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastFiredAt: null,
    };
    const next = [...rules, rule];
    save(next);
    rules = next;
    return rule;
  }

  function findRule(idOrName) {
    const raw = String(idOrName || "").trim();
    const q = raw.toLowerCase();
    if (!q) throw new Error("Rule id or name is required.");
    const exact = rules.find((r) => r.id === raw || r.name.toLowerCase() === q);
    if (exact) return exact;
    const matches = rules.filter((r) => r.name.toLowerCase().includes(q));
    if (matches.length > 1) {
      throw new Error(`"${raw}" matches ${matches.length} rules. Provide an exact rule ID.`);
    }
    return matches[0] || null;
  }

  function remove(idOrName) {
    const target = findRule(idOrName);
    if (!target) throw new Error(`Rule "${idOrName}" not found.`);
    const next = rules.filter((r) => r !== target);
    save(next);
    rules = next;
    for (const k of cooldownUntil.keys()) {
      if (k === target.id || k.startsWith(`${target.id}:`)) cooldownUntil.delete(k);
    }
    return target;
  }

  function toggle(idOrName, enabled) {
    const target = findRule(idOrName);
    if (!target) throw new Error(`Rule "${idOrName}" not found.`);
    const nextEnabled = enabled === undefined ? !target.enabled : Boolean(enabled);
    const prev = target.enabled;
    target.enabled = nextEnabled;
    try {
      save();
    } catch (err) {
      target.enabled = prev;
      throw err;
    }
    return target;
  }

  async function fireRule(rule, context, cooldownKey = rule.id) {
    const now = Date.now();
    if ((cooldownUntil.get(cooldownKey) || 0) > now) return;
    cooldownUntil.set(cooldownKey, now + 10 * 60_000);
    rule.lastFiredAt = new Date(now).toISOString();
    try {
      save();
    } catch (err) {
      log(`ruleEngine save (${rule.name})`, err);
    }
    try {
      await onTrigger(rule, context);
    } catch (err) {
      log(`ruleEngine fire (${rule.name})`, err);
    }
  }

  async function checkMetrics() {
    if (checking) return;
    const active = rules.filter((r) => r.enabled && (r.trigger === "battery_low" || r.trigger === "cpu_high"));
    if (!active.length) return;
    checking = true;
    try {
      const health = await getHealth();
      for (const r of active) {
        if (
          r.trigger === "battery_low" &&
          health.battery &&
          health.battery.percent !== null &&
          health.battery.percent !== undefined &&
          !health.battery.charging &&
          Number.isFinite(r.threshold) &&
          health.battery.percent <= r.threshold
        ) {
          await fireRule(r, { detail: `Battery at ${health.battery.percent}% (threshold ${r.threshold}%)` });
        }
        if (
          r.trigger === "cpu_high" &&
          health.cpuPercent !== null &&
          health.cpuPercent !== undefined &&
          Number.isFinite(r.threshold) &&
          health.cpuPercent >= r.threshold
        ) {
          await fireRule(r, { detail: `CPU load at ${health.cpuPercent}% (threshold ${r.threshold}%)` });
        }
      }
    } catch (err) {
      log("ruleEngine checkMetrics", err);
    } finally {
      checking = false;
    }
  }

  function startDownloadsWatch() {
    const dlDir = downloadsDir || path.join(os.homedir(), "Downloads");
    if (!fs.existsSync(dlDir) || dlWatcher) return;
    try {
      for (const f of fs.readdirSync(dlDir)) seenDownloads.add(f);
      dlWatcher = fs.watch(dlDir, (evt, filename) => {
        if (!filename) return;
        const full = path.join(dlDir, filename);
        if (evt === "rename" && !fs.existsSync(full)) {
          seenDownloads.delete(filename);
          return;
        }
        if (/\.(crdownload|part|tmp|partial)$/i.test(filename) || seenDownloads.has(filename)) return;
        const tId = setTimeout(() => {
          pendingTimers.delete(tId);
          try {
            if (!fs.existsSync(full) || seenDownloads.has(filename)) return;
            const st = fs.statSync(full);
            if (!st.isFile()) return;
            if (seenDownloads.size > 2000) seenDownloads.clear();
            seenDownloads.add(filename);
            const ext = path.extname(filename).toLowerCase();
            for (const r of rules) {
              if (!r.enabled || r.trigger !== "downloads_new_file") continue;
              if (r.ext === "*" || r.ext === ext || r.ext === ext.replace(/^\./, "")) {
                void fireRule(
                  r,
                  { filePath: full, fileName: filename, detail: `New file in Downloads: ${filename}` },
                  `${r.id}:${filename.toLowerCase()}`
                );
              }
            }
          } catch (err) {
            log("ruleEngine download callback", err);
          }
        }, 1500);
        pendingTimers.add(tId);
      });
      dlWatcher.on("error", (err) => {
        log("ruleEngine downloadsWatch error", err);
      });
    } catch (err) {
      log("ruleEngine downloadsWatch", err);
    }
  }

  function start() {
    if (timer) return;
    load();
    timer = setInterval(checkMetrics, TICK_MS);
    startDownloadsWatch();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    for (const tId of pendingTimers) clearTimeout(tId);
    pendingTimers.clear();
    if (dlWatcher) {
      try { dlWatcher.close(); } catch { /* ignore */ }
      dlWatcher = null;
    }
  }

  return { start, stop, add, remove, toggle, list: () => rules.slice() };
}
