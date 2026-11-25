// Adaptive behavior tracker + persistent offline queue for Delshiv AI.
// Privacy: the behavior profile stores ONLY aggregate counters — never raw message text.
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";
import { sanitizeForMemory } from "./memory-db.js";

// ───────── Behavior tracker ─────────
const TOPICS = ["javascript", "typescript", "python", "electron", "react", "node", "html", "css", "java", "sql", "git", "docker", "api", "gemini"];
const TOPIC_REGEXES = TOPICS.map((t) => [t, new RegExp(`\\b${t}\\b`)]);
const BRIEF_RE = /\b(short(?:\s+(?:me|mein|rakho|answer|reply|jawab))|brief(?:ly)?|chh?ota\s+jawab|sankshipt|keep it short)\b|संक्षिप्त|छोटा\s+जवाब/i;
const DETAIL_RE = /\b(in detail|detail\s*(?:me|mein)|step by step|vistar se|explain fully|samjha(?:o|iye))\b|विस्तार\s+से|समझाओ/i;
const BRIEF_RESET_RE = /\b(detail|step by step|vistar)|विस्तार|समझाओ/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function createSafeCounterObj(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

function emptyProfile() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    lastSeen: null,
    messages: { count: 0, totalChars: 0, devanagari: 0, latin: 0 },
    hours: new Array(24).fill(0),
    tools: {},
    topics: {},
    prefs: { verbosity: null },
  };
}

export function createBehaviorTracker({ filePath, log }) {
  const loaded = readJsonSafe(filePath, emptyProfile(), log);
  const base = emptyProfile();
  let p = {
    ...base,
    ...(isPlainObject(loaded) ? loaded : {}),
    hours: Array.isArray(loaded?.hours) && loaded.hours.length === 24 ? loaded.hours.map((x) => Math.max(0, Number(x) || 0)) : base.hours,
    messages: { ...base.messages, ...(isPlainObject(loaded?.messages) ? loaded.messages : {}) },
    tools: createSafeCounterObj(loaded?.tools),
    topics: createSafeCounterObj(loaded?.topics),
    prefs: isPlainObject(loaded?.prefs) ? { verbosity: loaded.prefs.verbosity === "brief" || loaded.prefs.verbosity === "detailed" ? loaded.prefs.verbosity : null } : { verbosity: null },
  };
  let dirty = false;
  let flushTimer = null;

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    try {
      atomicWriteJson(filePath, p);
      dirty = false;
    } catch (err) {
      log?.("behavior flush", err);
    }
  }

  function touch() {
    dirty = true;
    p.lastSeen = new Date().toISOString();
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 2000);
  }

  function recordMessage(text) {
    const s = String(text || "").trim();
    if (!s) return;
    p.messages.count += 1;
    p.messages.totalChars += Math.min(s.length, 2000);
    p.messages.devanagari += (s.match(/[\u0900-\u097F]/g) || []).length;
    p.messages.latin += (s.match(/[A-Za-z]/g) || []).length;
    p.hours[new Date().getHours()] += 1;
    const lower = s.toLowerCase();
    for (const [t, re] of TOPIC_REGEXES) {
      if (re.test(lower)) p.topics[t] = (Object.hasOwn(p.topics, t) ? p.topics[t] : 0) + 1;
    }
    if (BRIEF_RE.test(s) && !BRIEF_RESET_RE.test(s)) p.prefs.verbosity = "brief";
    else if (DETAIL_RE.test(s)) p.prefs.verbosity = "detailed";
    touch();
  }

  function recordTool(name) {
    const n = String(name || "").trim().slice(0, 40);
    if (!n || FORBIDDEN_KEYS.has(n)) return;
    p.tools[n] = (Object.hasOwn(p.tools, n) ? p.tools[n] : 0) + 1;
    touch();
  }

  function top(obj, n, min = 1) {
    return Object.entries(obj).filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function getSummary() {
    const m = p.messages;
    const avgLen = m.count ? Math.round(m.totalChars / m.count) : 0;
    const style = m.count < 5 ? "unknown (still learning)" : avgLen < 45 ? "terse, short messages" : avgLen < 140 ? "moderate" : "detailed, long messages";
    const scriptTotal = m.devanagari + m.latin;
    const devShare = scriptTotal ? m.devanagari / scriptTotal : 0;
    const language = m.count < 5 ? "unknown" : devShare > 0.5 ? "mostly Hindi (Devanagari)" : "Roman script (English/Hinglish)";
    const tools = top(p.tools, 4, 3);
    const topics = top(p.topics, 4, 2);
    const peakHour = Math.max(...p.hours) >= 5 ? p.hours.indexOf(Math.max(...p.hours)) : null;
    const suggestions = top(p.tools, 3, 5).map(([t, c]) => `BOSS has used ${t} ${c} times — offer to automate it (e.g. via scheduleTask) when relevant.`);

    const lines = [];
    if (p.prefs.verbosity) lines.push(`Explicit preference: BOSS wants ${p.prefs.verbosity === "brief" ? "SHORT, to-the-point" : "DETAILED, step-by-step"} answers.`);
    else if (m.count >= 5) lines.push(`Adapt depth to BOSS's style (${style}).`);
    if (m.count >= 5) lines.push(`Observed language: ${language}.`);
    if (topics.length) lines.push(`Frequent topics: ${topics.map(([t]) => t).join(", ")}.`);
    if (tools.length) lines.push(`Frequently used tools: ${tools.map(([t, c]) => `${t} (${c})`).join(", ")}.`);
    if (peakHour !== null) lines.push(`Most active around ${peakHour}:00.`);
    lines.push(...suggestions);

    return {
      stats: { messages: m.count, avgMessageLength: avgLen, style, language, verbosityPreference: p.prefs.verbosity, topTools: top(p.tools, 5), topTopics: top(p.topics, 5), peakHour },
      promptText: lines.length ? `Learned user behavior (local, adaptive): ${lines.join(" ")}` : "",
    };
  }

  function reset() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    p = emptyProfile();
    dirty = true;
    flush();
  }

  return { recordMessage, recordTool, getSummary, reset, flush };
}

// ───────── Offline queue ─────────
const MAX_QUEUE = 100;
const MAX_TEXT = 4000;

export function createOfflineQueue({ filePath, log }) {
  const loaded = readJsonSafe(filePath, { items: [] }, log);
  let items = Array.isArray(loaded?.items)
    ? loaded.items.filter((i) => i && typeof i.text === "string" && i.id)
    : [];

  const save = (nextItems = items) => atomicWriteJson(filePath, { items: nextItems });

  return {
    add(type, payload) {
      if (type !== "chat") throw new Error(`Unsupported queue item type "${type}".`);
      const text = sanitizeForMemory(String(payload?.text || "")).trim().slice(0, MAX_TEXT);
      if (!text) throw new Error("Cannot queue an empty message.");
      if (items.length >= MAX_QUEUE) throw new Error(`Offline queue is full (${MAX_QUEUE}). Reconnect to sync.`);
      const item = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, type, text, createdAt: new Date().toISOString() };
      const next = [...items, item];
      save(next);
      items = next;
      return item;
    },
    list: () => items.slice(),
    remove(id) {
      const next = items.filter((i) => i.id !== id);
      if (next.length !== items.length) {
        save(next);
        items = next;
        return true;
      }
      return false;
    },
    size: () => items.length,
  };
}
