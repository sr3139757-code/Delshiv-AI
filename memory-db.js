// SQLite Long-Term Memory (chat_history + session_summary + long-term facts) using built-in node:sqlite.
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { redact } from "./report-generator.js";
import { GEMINI_MODELS } from "./shared-utils.js";

const VALID_CATEGORIES = new Set(["preference", "project", "person", "routine", "decision", "task", "general"]);

function isValidLuhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function sanitizeForMemory(text) {
  let out = redact(String(text ?? ""), { redactEmails: false });
  out = out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:otp|pin|cvv|cvc)\s*(?:is|:|=)\s*\d{4,8}\b/gi, "[REDACTED_OTP_PIN]")
    .replace(/\b(?:\d{4}[ -]){3}\d{4}\b/g, "[REDACTED_CARD]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) {
        return "[REDACTED_CARD_OR_ACCOUNT]";
      }
      return m;
    });
  return out.trim();
}

export function createMemoryDb({ dbPath, log = () => {}, apiEndpoint = "", minRequestIntervalMs = 2500 } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  let closed = false;
  const summarizingSessions = new Set();
  let lastRequestTime = 0;
  let rateLimitCooldownUntil = 0;

  async function requestWithRateLimitAndBackoff(url, fetchOpts, {
    model = "",
    action = "memory-api",
    maxRetries = 2,
    initialDelayMs = 1500,
    maxDelayMs = 8000,
    timeoutMs = 8000,
  } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (closed) return null;

      // 1. Client-side Rate Limit Throttling: respect cooldown on 429
      const now = Date.now();
      if (rateLimitCooldownUntil > now) {
        const cooldownRemaining = rateLimitCooldownUntil - now;
        await new Promise((r) => setTimeout(r, Math.min(cooldownRemaining, 4000)));
      }

      // Enforce minimum spacing between client calls to avoid spiking server limits
      const elapsed = Date.now() - lastRequestTime;
      if (elapsed < minRequestIntervalMs) {
        await new Promise((r) => setTimeout(r, minRequestIntervalMs - elapsed));
      }

      try {
        lastRequestTime = Date.now();
        // Generate a fresh AbortSignal per attempt to avoid stale aborted signals poisoning retries
        const attemptSignal = AbortSignal.timeout(timeoutMs);
        const res = await fetch(url, { ...fetchOpts, signal: attemptSignal });

        // Success
        if (res.ok) {
          return res;
        }

        // Standard Error Handling:
        // HTTP 404: Non-retryable endpoint / resource error — stop immediately on this model so next model can try
        if (res.status === 404) {
          return null;
        }

        // HTTP 429: Too Many Requests / Rate Limited
        if (res.status === 429) {
          let retryAfterMs = 0;
          const retryHeader = res.headers?.get ? res.headers.get("retry-after") : null;
          if (retryHeader) {
            const parsedSeconds = Number(retryHeader);
            if (Number.isFinite(parsedSeconds)) {
              retryAfterMs = parsedSeconds * 1000;
            } else {
              const parsedDate = Date.parse(retryHeader);
              if (Number.isFinite(parsedDate)) retryAfterMs = Math.max(0, parsedDate - Date.now());
            }
          }

          // Exponential backoff: base * 2^attempt + jitter
          const jitter = Math.floor(Math.random() * 250);
          const computedDelay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt) + jitter);
          const waitDelay = Math.max(retryAfterMs, computedDelay);

          rateLimitCooldownUntil = Date.now() + waitDelay;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, waitDelay));
            continue;
          }
          return null;
        }

        // 5xx Server Errors: retryable with backoff
        if (res.status >= 500) {
          const delay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          return null;
        }

        // Other non-retryable 4xx errors (400, 401, 403)
        return null;
      } catch (err) {
        const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError" || /timeout|aborted/i.test(err?.message || "");
        if (isTimeout) {
          // Unresponsive or slow model: skip to fallback model immediately, do not waste 15-30s in retries
          return null;
        }
        if (attempt < maxRetries) {
          const delay = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      summary TEXT NOT NULL,
      msg_count INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    const verRow = db.prepare("PRAGMA user_version").get();
    const dbVer = Number(verRow?.user_version || 0);
    if (dbVer < 2) {
      db.exec("PRAGMA user_version = 2;");
    }
  } catch { /* non-fatal */ }

  const insertMsg = db.prepare("INSERT INTO chat_messages (session_id, role, text, created_at) VALUES (?, ?, ?, ?)");
  const selectLatestMsgs = db.prepare("SELECT id, session_id, role, text, created_at FROM chat_messages ORDER BY id DESC LIMIT ?");
  const selectSessionMsgs = db.prepare("SELECT id, session_id, role, text, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC");
  const countSessionMsgs = db.prepare("SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?");
  const upsertSummary = db.prepare(`
    INSERT INTO session_summaries (session_id, summary, msg_count, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, msg_count = excluded.msg_count, updated_at = excluded.updated_at
  `);
  const selectSummaryRow = db.prepare("SELECT msg_count FROM session_summaries WHERE session_id = ?");
  const selectRecentSummaries = db.prepare(
    "SELECT session_id, summary, msg_count, updated_at FROM session_summaries WHERE session_id != ? ORDER BY updated_at DESC, id DESC LIMIT ?"
  );
  const insertAudit = db.prepare("INSERT INTO memory_audit_log (action, detail, created_at) VALUES (?, ?, ?)");
  const pruneAudit = db.prepare("DELETE FROM memory_audit_log WHERE id NOT IN (SELECT id FROM memory_audit_log ORDER BY id DESC LIMIT 1000)");
  const selectAudit = db.prepare("SELECT id, action, detail, created_at FROM memory_audit_log ORDER BY id DESC LIMIT ?");
  const insertFact = db.prepare("INSERT INTO memories (fact, category, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  const updateFactStmt = db.prepare("UPDATE memories SET fact = ?, category = ?, importance = ?, updated_at = ? WHERE id = ?");
  const deleteFactStmt = db.prepare("DELETE FROM memories WHERE id = ?");
  const selectFactById = db.prepare("SELECT id, fact, category, importance, created_at, updated_at FROM memories WHERE id = ?");
  const selectAllFacts = db.prepare("SELECT id, fact, category, importance, created_at, updated_at FROM memories ORDER BY importance DESC, id DESC");
  const selectPastRecent = db.prepare("SELECT id, session_id, role, text, created_at FROM chat_messages WHERE session_id != ? ORDER BY id DESC LIMIT ?");
  const searchPastLike = db.prepare("SELECT id, session_id, role, text, created_at FROM chat_messages WHERE session_id != ? AND LOWER(text) LIKE ? ORDER BY id DESC LIMIT ?");

  let auditWrites = 0;

  function ensureOpen() {
    if (closed) throw new Error("Memory database is closed.");
  }

  function audit(action, detail) {
    if (closed) return;
    try {
      insertAudit.run(String(action), String(detail).slice(0, 300), new Date().toISOString());
      auditWrites += 1;
      if (auditWrites % 50 === 0) pruneAudit.run();
    } catch (err) {
      log("memory-db audit", err);
    }
  }

  function saveMessage({ sessionId, role, text }) {
    ensureOpen();
    const sid = String(sessionId || "default").trim();
    const r = role === "model" || role === "bot" || role === "assistant" ? "model" : "user";
    const clean = sanitizeForMemory(text).slice(0, 8000);
    if (!clean) return null;
    const now = new Date().toISOString();
    const info = insertMsg.run(sid, r, clean, now);
    return { id: Number(info.lastInsertRowid), sessionId: sid, role: r, text: clean, createdAt: now };
  }

  function getRecentMessages(limit = 16) {
    ensureOpen();
    const n = Math.min(50, Math.max(1, Math.floor(Number(limit) || 16)));
    return selectLatestMsgs.all(n).reverse();
  }

  function shouldAutoSummarize(sessionId) {
    if (closed) return false;
    const sid = String(sessionId || "");
    if (!sid || summarizingSessions.has(sid)) return false;
    const count = Number(countSessionMsgs.get(sid)?.cnt || 0);
    if (count < 12) return false;
    const prev = selectSummaryRow.get(sid);
    const prevCount = prev ? Number(prev.msg_count) : 0;
    return count - prevCount >= 12;
  }

  async function summarizeSession({ sessionId, apiKey = "" } = {}) {
    if (closed) return null;
    const sid = String(sessionId || "").trim();
    if (!sid || summarizingSessions.has(sid)) return null;
    summarizingSessions.add(sid);
    try {
      const msgs = selectSessionMsgs.all(sid);
      if (msgs.length < 2) return null;

      const transcript = msgs.slice(-30).map((m) => `${m.role === "user" ? "BOSS" : "Delshiv"}: ${m.text}`).join("\n").slice(0, 12000);
      let summary = "";

      if (apiKey) {
        const prompt = `Summarize this conversation session in 2-4 concise sentences (key topics, tasks done, decisions, and pending follow-ups). Do not include any passwords or keys.\n\n${transcript}`;
        for (const model of GEMINI_MODELS) {
          try {
            const endpointBase = apiEndpoint ? apiEndpoint.replace(/\/+$/, "") : "https://generativelanguage.googleapis.com/v1beta";
            const url = `${endpointBase}/models/${encodeURIComponent(model)}:generateContent`;
            const res = await requestWithRateLimitAndBackoff(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
            }, { model, action: "summarizeSession", timeoutMs: 8000 });

            if (!res || !res.ok) continue;
            const data = await res.json();
            summary = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
            if (summary) break;
          } catch (err) {
            log(`memory-db summarize (${model})`, err);
          }
        }
      }

      if (closed) return null;
      if (!summary) {
        const userTopics = msgs.filter((m) => m.role === "user").slice(-4).map((m) => m.text.slice(0, 80));
        summary = `Session (${msgs.length} messages): BOSS discussed ${userTopics.join("; ")}.`;
      }

      const cleanSummary = sanitizeForMemory(summary).slice(0, 1000);
      const now = new Date().toISOString();
      upsertSummary.run(sid, cleanSummary, msgs.length, now);
      audit("session_summary", `${sid} (${msgs.length} msgs)`);
      return { sessionId: sid, summary: cleanSummary, msgCount: msgs.length, updatedAt: now };
    } finally {
      summarizingSessions.delete(sid);
    }
  }

  function getRecentSummaries(limit = 5, excludeSessionId = "") {
    ensureOpen();
    const n = Math.min(10, Math.max(1, Math.floor(Number(limit) || 5)));
    return selectRecentSummaries.all(String(excludeSessionId || ""), n);
  }

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch (err) { log("memory-db close", err); }
  }

  // ───────── Long-Term Facts (auto_memory + retrieval + viewer CRUD) ─────────
  const SENSITIVE_RE = /\b(?:password|passwd)\s*(?:is|:|=)\s*\S+|\b(?:otp|cvv|cvc)\s*(?:is|:|=)?\s*\d+|\b(?:credit\s+card|debit\s+card|bank\s+account|ifsc|private\s+key|secret\s+key)\b|\b(?:api[_ ]?key)\s*(?:is|:|=)\s*\S+/i;
  const TRIVIAL_RE = /^(hi|hello|hey|namaste|ok|okay|thanks|thank you|bye|good morning|good night|time kya hai|what time is it)\W*$/i;
  const toks = (s) => (String(s || "").toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/g) || []);
  const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function saveOrUpdateFact({ fact, category = "general", importance = 3, replacesTopic = "" } = {}) {
    ensureOpen();
    const rawFact = String(fact || "");
    if (SENSITIVE_RE.test(rawFact)) return { skipped: true, reason: "Empty or sensitive" };
    const clean = sanitizeForMemory(rawFact).slice(0, 400);
    if (clean.length < 4 || SENSITIVE_RE.test(clean)) return { skipped: true, reason: "Empty or sensitive" };
    const catLower = String(category || "general").toLowerCase().trim();
    const cat = VALID_CATEGORIES.has(catLower) ? catLower : "general";
    const imp = Math.min(5, Math.max(1, Math.round(Number(importance) || 3)));
    const all = selectAllFacts.all();
    const newToks = new Set(toks(clean));
    const topic = String(replacesTopic || "").trim();
    const topicRe = topic.length >= 4 ? new RegExp(`\\b${escapeRegex(topic)}\\b`, "i") : null;

    for (const row of all) {
      if (row.fact.toLowerCase() === clean.toLowerCase()) return { item: row, duplicate: true };
      const oldSet = new Set(toks(row.fact));
      let intersection = 0;
      for (const t of oldSet) {
        if (newToks.has(t)) intersection++;
      }
      const unionSize = new Set([...oldSet, ...newToks]).size;
      const jaccard = intersection / Math.max(1, unionSize);
      const minLen = Math.min(oldSet.size, newToks.size);
      const topicHit = topicRe ? topicRe.test(row.fact) : false;

      if ((minLen >= 3 && jaccard >= 0.65) || topicHit) {
        const now = new Date().toISOString();
        updateFactStmt.run(clean, cat, imp, now, row.id);
        audit("memory_update", `#${row.id}: ${clean}`);
        return { item: { ...row, fact: clean, category: cat, importance: imp, updated_at: now }, updated: true };
      }
    }

    const now = new Date().toISOString();
    const info = insertFact.run(clean, cat, imp, now, now);
    const created = { id: Number(info.lastInsertRowid), fact: clean, category: cat, importance: imp, created_at: now, updated_at: now };
    audit("memory_save", `#${created.id} [${cat}:${imp}]: ${clean}`);
    return { item: created, created: true };
  }

  async function autoExtractMemory({ userText, assistantText = "", apiKey = "" } = {}) {
    if (closed) return { saved: false };
    const rawUser = String(userText || "").trim();
    if (!rawUser || rawUser.length < 14 || TRIVIAL_RE.test(rawUser) || SENSITIVE_RE.test(rawUser)) return { saved: false };
    if (!apiKey) return { saved: false };

    const safeUser = sanitizeForMemory(rawUser).slice(0, 600);
    const safeAssistant = sanitizeForMemory(String(assistantText || "")).slice(0, 300);
    if (!safeUser || safeUser.length < 14) return { saved: false };

    const prompt = `Analyze this conversation turn and decide if there is a durable fact worth remembering long-term (user preferences, ongoing projects, people names, routines, decisions, recurring tasks).
Do NOT save trivial greetings, one-off questions (weather/time), or any passwords/OTPs/bank/card/key info.
Return JSON:
- should_save: boolean
- fact: concise 1-sentence fact in clear English/Hinglish (empty if should_save=false)
- category: one of "preference", "project", "person", "routine", "decision", "task", "general"
- importance: integer 1 to 5
- replaces_topic: short keyword if this updates an old preference/decision, else ""

User: ${safeUser}
Assistant: ${safeAssistant}`;

    const schema = {
      type: "OBJECT",
      properties: {
        should_save: { type: "BOOLEAN" },
        fact: { type: "STRING" },
        category: { type: "STRING" },
        importance: { type: "NUMBER" },
        replaces_topic: { type: "STRING" },
      },
      required: ["should_save", "fact", "category", "importance", "replaces_topic"],
    };

    for (const model of GEMINI_MODELS) {
      try {
        const endpointBase = apiEndpoint ? apiEndpoint.replace(/\/+$/, "") : "https://generativelanguage.googleapis.com/v1beta";
        const url = `${endpointBase}/models/${encodeURIComponent(model)}:generateContent`;
        const res = await requestWithRateLimitAndBackoff(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema },
          }),
        }, { model, action: "autoExtractMemory", timeoutMs: 7000 });

        if (!res || !res.ok) continue;
        const data = await res.json();
        const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!parsed.should_save || !parsed.fact) return { saved: false };
        if (closed) return { saved: false };
        const resSave = saveOrUpdateFact({
          fact: parsed.fact,
          category: parsed.category,
          importance: parsed.importance,
          replacesTopic: parsed.replaces_topic,
        });
        return { saved: !resSave.skipped && !resSave.duplicate, ...resSave };
      } catch (err) {
        log(`memory-db autoExtract (${model})`, err);
      }
    }
    return { saved: false };
  }

  function retrieveRelevantMemories(query, limit = 6) {
    ensureOpen();
    const all = selectAllFacts.all();
    if (!all.length) return [];
    const qToks = [...new Set(toks(query))];
    const n = Math.min(8, Math.max(1, Math.floor(Number(limit) || 6)));
    if (!qToks.length) return all.slice(0, n);

    const scored = all.map((row) => {
      const fToks = new Set(toks(`${row.fact} ${row.category}`));
      const hits = qToks.filter((t) => fToks.has(t)).length;
      const parsedTs = Date.parse(row.updated_at);
      const ageDays = Number.isFinite(parsedTs) ? Math.max(0, (Date.now() - parsedTs) / 86400000) : 30;
      const recency = 1 / (1 + ageDays);
      const score = hits * 3 + (hits > 0 ? row.importance * 0.5 + recency : row.importance * 0.15);
      return { row, hits, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map((x) => x.row);
  }

  function listFacts(limit = 100) {
    ensureOpen();
    return selectAllFacts.all().slice(0, Math.min(500, Math.max(1, Math.floor(Number(limit) || 100))));
  }

  function updateFact(id, { fact, category, importance } = {}) {
    ensureOpen();
    const numId = Number(id);
    const existing = Number.isInteger(numId) ? selectFactById.get(numId) : null;
    if (!existing) throw new Error(`Memory #${id} not found.`);
    const raw = fact !== undefined ? String(fact) : existing.fact;
    if (fact !== undefined && SENSITIVE_RE.test(raw)) throw new Error("Invalid or sensitive memory text.");
    const clean = fact !== undefined ? sanitizeForMemory(raw).slice(0, 400) : existing.fact;
    if (clean.length < 3 || SENSITIVE_RE.test(clean)) throw new Error("Invalid or sensitive memory text.");
    const catLower = category !== undefined ? String(category).toLowerCase().trim() : existing.category;
    const cat = VALID_CATEGORIES.has(catLower) ? catLower : existing.category;
    const imp = importance !== undefined ? Math.min(5, Math.max(1, Math.round(Number(importance) || 3))) : existing.importance;
    const now = new Date().toISOString();
    updateFactStmt.run(clean, cat, imp, now, existing.id);
    audit("memory_edit", `#${existing.id}: ${clean}`);
    return { ...existing, fact: clean, category: cat, importance: imp, updated_at: now };
  }

  function deleteFact(idOrQuery) {
    ensureOpen();
    const key = String(idOrQuery ?? "").trim();
    if (!key) throw new Error("Memory id or text is required.");
    let target = /^\d+$/.test(key) ? selectFactById.get(Number(key)) : null;
    if (!target) {
      const all = selectAllFacts.all();
      const q = key.toLowerCase();
      const exact = all.find((r) => r.fact.toLowerCase() === q);
      if (exact) {
        target = exact;
      } else {
        const matches = all.filter((r) => r.fact.toLowerCase().includes(q));
        if (matches.length > 1) {
          throw new Error(`Multiple memories match "${key}". Provide an exact memory ID.`);
        }
        target = matches[0] || null;
      }
    }
    if (!target) throw new Error(`Memory "${idOrQuery}" not found.`);
    deleteFactStmt.run(target.id);
    audit("memory_delete", `#${target.id}: ${target.fact}`);
    return target;
  }

  function getAuditLog(limit = 20) {
    ensureOpen();
    return selectAudit.all(Math.min(100, Math.max(1, Math.floor(Number(limit) || 20))));
  }

  function searchPastChats(query, { excludeSessionId = "", limit = 8 } = {}) {
    ensureOpen();
    const n = Math.min(15, Math.max(1, Math.floor(Number(limit) || 8)));
    const excl = String(excludeSessionId || "");
    const qToks = [...new Set(toks(query))];
    const askingAboutHistory = /\b(pichli|purani|previous|last|earlier|yesterday|kal|chat|baat|bola|kaha|bataya)\b/i.test(String(query || ""));

    const candidateMap = new Map();
    for (const tok of qToks.slice(0, 4)) {
      const escapedTok = tok.replace(/[\\%_]/g, "\\$&");
      const rows = searchPastLike.all(excl, `%${escapedTok}%`, 100);
      for (const r of rows) candidateMap.set(r.id, r);
    }

    if (!qToks.length || askingAboutHistory) {
      const matched = [...candidateMap.values()].slice(0, Math.ceil(n / 2));
      const recent = selectPastRecent.all(excl, n);
      const seen = new Set();
      return [...matched, ...recent].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, n).reverse();
    }

    const candidates = [...candidateMap.values()];
    if (!candidates.length) return [];

    const scored = candidates
      .map((r) => {
        const rt = new Set(toks(r.text));
        const hits = qToks.filter((t) => rt.has(t)).length;
        return { r, hits };
      })
      .filter((x) => x.hits > 0);
    scored.sort((a, b) => b.hits - a.hits || b.r.id - a.r.id);
    return scored.slice(0, n).map((x) => x.r).reverse();
  }

  function importLegacyFacts(legacyItems = []) {
    ensureOpen();
    let imported = 0;
    let skipped = 0;
    for (const item of Array.isArray(legacyItems) ? legacyItems : []) {
      const txt = typeof item === "string" ? item : item?.text;
      if (!txt) { skipped++; continue; }
      const res = saveOrUpdateFact({ fact: txt, category: "general", importance: 3 });
      if (res?.created) imported++;
      else skipped++;
    }
    return { imported, skipped };
  }

  return {
    saveMessage, getRecentMessages, shouldAutoSummarize, summarizeSession, getRecentSummaries, close,
    saveOrUpdateFact, autoExtractMemory, retrieveRelevantMemories, listFacts, updateFact, deleteFact, getAuditLog,
    searchPastChats, importLegacyFacts,
    checkServerStatus: (opts = {}) => checkMemoryServerStatus({ endpoint: apiEndpoint, ...opts }),
  };
}

export async function checkMemoryServerStatus({
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
  apiKey = "",
  model = "gemini-flash-lite-latest",
  timeoutMs = 5000,
} = {}) {
  const start = Date.now();
  const rawEndpoint = String(endpoint || "https://generativelanguage.googleapis.com/v1beta").trim().replace(/\/+$/, "");

  if (!/^https?:\/\//i.test(rawEndpoint)) {
    return {
      ok: false,
      status: 400,
      latencyMs: 0,
      endpoint: rawEndpoint,
      error: `Invalid memory database endpoint format: "${rawEndpoint}". Must start with http:// or https://.`,
      recommendation: "Verify configuration and supply a valid HTTP/HTTPS URL.",
    };
  }

  const testUrl = `${rawEndpoint}/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey || "")}`;
  try {
    const res = await fetch(testUrl, {
      method: "GET",
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      return {
        ok: true,
        status: res.status,
        latencyMs,
        endpoint: rawEndpoint,
        model,
        message: `Memory database server is reachable and responsive (${latencyMs}ms).`,
      };
    }

    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        latencyMs,
        endpoint: rawEndpoint,
        model,
        error: `Resource endpoint not found (HTTP 404): "${rawEndpoint}/models/${model}".`,
        recommendation: "Verify that the resource endpoint exists, URL path is correct, and the model identifier is active.",
      };
    }

    if (res.status === 429) {
      const retryAfter = res.headers?.get ? res.headers.get("retry-after") : "rate limit exceeded";
      return {
        ok: false,
        status: 429,
        latencyMs,
        endpoint: rawEndpoint,
        model,
        error: `Rate limit exceeded (HTTP 429). Server is rejecting requests due to rate limits.`,
        recommendation: `Implement exponential backoff and throttle client request rate. Server Retry-After: ${retryAfter || "unknown"}.`,
      };
    }

    return {
      ok: false,
      status: res.status,
      latencyMs,
      endpoint: rawEndpoint,
      model,
      error: `Server responded with HTTP ${res.status}: ${res.statusText || "Unexpected Status"}.`,
      recommendation: "Inspect server logs and verify authentication credentials.",
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      status: 0,
      latencyMs,
      endpoint: rawEndpoint,
      model,
      error: err?.message || String(err),
      recommendation: "Check network connection, DNS resolution, and firewall settings.",
    };
  }
}
