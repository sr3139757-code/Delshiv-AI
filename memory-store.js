// Legacy fallback JSON memory store for Delshiv AI (used only if SQLite memoryDb fails to initialise).
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";
import { sanitizeForMemory } from "./memory-db.js";
import { tokenize } from "./code-search.js";

const MAX_MEMORIES = 500;
const MAX_TEXT = 500;
const SENSITIVE_RE = /\b(?:password|passwd)\s*(?:is|:|=)\s*\S+|\b(?:otp|cvv|cvc)\s*(?:is|:|=)?\s*\d+|\b(?:credit\s+card|debit\s+card|bank\s+account|ifsc|private\s+key|secret\s+key)\b/i;

export function createMemoryStore({ filePath, log = () => {} }) {
  const parsed = readJsonSafe(filePath, { items: [] }, log);
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
  let items = rawItems
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      id: String(m.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`),
      text: m.text.trim().slice(0, MAX_TEXT),
      tags: Array.isArray(m.tags) ? m.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
      createdAt: String(m.createdAt || new Date().toISOString()),
    }));

  const save = (nextItems) => {
    atomicWriteJson(filePath, { items: nextItems });
  };

  function remember(text, tags = []) {
    const raw = String(text || "").trim();
    if (SENSITIVE_RE.test(raw)) throw new Error("Cannot store sensitive credentials or secrets in memory.");
    const clean = sanitizeForMemory(raw).slice(0, MAX_TEXT);
    if (clean.length < 3) throw new Error("Memory text is too short.");
    const dup = items.find((m) => m.text.toLowerCase() === clean.toLowerCase());
    if (dup) return { item: dup, duplicate: true };
    if (items.length >= MAX_MEMORIES) throw new Error(`Memory is full (${MAX_MEMORIES}). Forget some memories first.`);
    const item = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      tags: (Array.isArray(tags) ? tags : String(tags || "").split(",")).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 5),
      createdAt: new Date().toISOString(),
    };
    const next = [item, ...items];
    save(next);
    items = next;
    return { item, duplicate: false };
  }

  function recall(query, limit = 5) {
    const lim = Math.min(20, Math.max(1, Math.floor(Number(limit) || 5)));
    const q = [...new Set(tokenize(query))];
    if (!q.length) return items.slice(0, lim);
    const scored = items.map((m) => {
      const toks = new Set(tokenize(`${m.text} ${m.tags.join(" ")}`));
      const hits = q.filter((t) => toks.has(t)).length;
      const ts = Date.parse(m.createdAt);
      const ageDays = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 86400000) : 30;
      return { m, score: hits ? hits + 1 / (1 + ageDays) : 0 };
    }).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, lim).map((x) => x.m);
  }

  function forget(idOrQuery) {
    const key = String(idOrQuery || "").trim();
    if (!key) throw new Error("Memory id or text is required.");
    let target = items.find((m) => m.id === key);
    if (!target) {
      const qToks = tokenize(key);
      if (!qToks.length) throw new Error(`No memory matches "${key}".`);
      const matches = recall(key, 2);
      if (matches.length > 1 && matches[0].text.toLowerCase() !== key.toLowerCase()) {
        throw new Error(`"${key}" matches several memories. Use list to get an exact id.`);
      }
      target = matches[0];
    }
    if (!target) throw new Error(`No memory matches "${key}".`);
    const next = items.filter((m) => m !== target);
    save(next);
    items = next;
    return target;
  }

  function list(n = 20) {
    const lim = Math.min(200, Math.max(1, Math.floor(Number(n) || 20)));
    return items.slice(0, lim);
  }

  return { remember, recall, forget, list, size: () => items.length };
}
