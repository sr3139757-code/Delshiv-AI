// Clipboard History Vault for Delshiv AI (stores last 50 non-sensitive copied items locally with search & restore).
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";
import { sanitizeForMemory } from "./memory-db.js";

const MAX_ITEMS = 50;
const MAX_CHARS = 4000;
const SECRET_CLIP_RE = /\b(?:password|passwd|pwd|secret|token|api[_-]?key|otp|pin|cvv|cvc)\s*(?:is|:|=)\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{25,60}|\bAQ\.[0-9A-Za-z_.-]{20,120}|\bsk-[A-Za-z0-9_-]{16,}|\btvly-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/i;

export function createClipboardHistory({ filePath, log = () => {} }) {
  const loaded = readJsonSafe(filePath, { items: [] }, log);
  let items = Array.isArray(loaded?.items)
    ? loaded.items.filter((i) => i && typeof i.text === "string" && i.id)
    : [];

  const save = (nextItems = items) => atomicWriteJson(filePath, { items: nextItems });

  function push(rawText) {
    const raw = String(rawText || "").trim().slice(0, MAX_CHARS);
    if (!raw) return null;
    if (SECRET_CLIP_RE.test(raw) || sanitizeForMemory(raw) !== raw) {
      return null; // Never persist sensitive keys/OTPs/cards/passwords to clipboard history
    }
    const entry = { id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, text: raw, copiedAt: new Date().toISOString() };
    const next = [entry, ...items.filter((i) => i.text !== raw)];
    if (next.length > MAX_ITEMS) next.length = MAX_ITEMS;
    save(next);
    items = next;
    return entry;
  }

  function list(limit = 15) {
    const n = Math.min(MAX_ITEMS, Math.max(1, Math.floor(Number(limit) || 15)));
    return items.slice(0, n);
  }

  function search(query, limit = 10) {
    const n = Math.min(MAX_ITEMS, Math.max(1, Math.floor(Number(limit) || 10)));
    const q = String(query || "").trim().toLowerCase();
    if (!q) return list(n);
    return items.filter((i) => i.text.toLowerCase().includes(q)).slice(0, n);
  }

  function getByIndexOrId(idOrIndex) {
    const key = String(idOrIndex || "").trim();
    if (!key) return null;
    if (/^\d+$/.test(key)) {
      const idx = Math.max(0, Number(key) - 1);
      return items[idx] || null;
    }
    return items.find((i) => i.id === key) || null;
  }

  function clear() {
    save([]);
    items = [];
  }

  return { push, list, search, getByIndexOrId, clear, size: () => items.length };
}
