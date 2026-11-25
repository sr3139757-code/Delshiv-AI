// Self-Healing Error Logger for Delshiv AI.
// Captures uncaughtException, unhandledRejection, and tool/module try/catch wrappers,
// persists deduplicated JSONL entries to logs/errors.jsonl, and emits real-time events.
import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWriteText } from "../../shared-utils.js";
import { redact } from "../../report-generator.js";
import { APP_PATHS } from "../config/appConfig.js";

const DEFAULT_LOG_FILE = APP_PATHS.errorsLog;
const DEFAULT_MAX_ENTRIES = 500;

function extractErrorDetails(err) {
  if (err instanceof Error) {
    return {
      message: String(err.message || err.name || "Unknown error"),
      stack: String(err.stack || `${err.name || "Error"}: ${err.message || ""}`),
    };
  }
  if (err && typeof err === "object") {
    const message = String(err.message || err.error || JSON.stringify(err));
    const stack = String(err.stack || new Error(message).stack || message);
    return { message, stack };
  }
  const message = String(err || "Unknown error");
  return { message, stack: new Error(message).stack || message };
}

function normalizeMessageForFingerprint(msg) {
  return String(msg || "")
    .replace(/\b\d{10,13}\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTopStackFrame(stack) {
  const lines = String(stack || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "));
  return lines[0] || "";
}

function computeFingerprint(modName, cleanMessage, cleanStack) {
  const raw = `${modName}|${normalizeMessageForFingerprint(cleanMessage)}|${extractTopStackFrame(cleanStack)}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Create a self-healing ErrorLogger built on Node EventEmitter.
 * @param {object} [options]
 * @param {string} [options.logFilePath] Path to the JSONL log file (default: logs/errors.jsonl)
 * @param {number} [options.maxEntries] Max unique deduplicated error records retained
 */
export function createErrorLogger({ logFilePath = DEFAULT_LOG_FILE, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const emitter = new EventEmitter();
  const entriesByFingerprint = new Map();
  let lastUserCommand = "";
  let globalHandlersInstalled = false;
  let uncaughtListener = null;
  let rejectionListener = null;

  function loadExisting() {
    entriesByFingerprint.clear();
    try {
      if (!fs.existsSync(logFilePath)) return;
      const raw = fs.readFileSync(logFilePath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (!parsed || typeof parsed !== "object" || !parsed.module || !parsed.message) continue;
          const fp = String(
            parsed.fingerprint || computeFingerprint(parsed.module, parsed.message, parsed.stack || "")
          );
          entriesByFingerprint.set(fp, {
            id: String(parsed.id || `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
            time: String(parsed.time || new Date().toISOString()),
            firstSeenAt: String(parsed.firstSeenAt || parsed.time || new Date().toISOString()),
            module: String(parsed.module),
            message: String(parsed.message),
            stack: String(parsed.stack || ""),
            userCommand: String(parsed.userCommand || ""),
            count: Math.max(1, Math.floor(Number(parsed.count) || 1)),
            fingerprint: fp,
          });
        } catch {
          // Skip corrupt JSONL line while preserving valid history
        }
      }
    } catch {
      // Initial empty state if file cannot be read
    }
  }

  function persistAll() {
    const dir = path.dirname(logFilePath);
    fs.mkdirSync(dir, { recursive: true });
    while (entriesByFingerprint.size > maxEntries) {
      const oldestKey = entriesByFingerprint.keys().next().value;
      if (oldestKey === undefined) break;
      entriesByFingerprint.delete(oldestKey);
    }
    const content = Array.from(entriesByFingerprint.values())
      .map((item) => JSON.stringify(item))
      .join("\n");
    atomicWriteText(logFilePath, content ? `${content}\n` : "");
  }

  loadExisting();

  function setLastUserCommand(cmd) {
    const clean = redact(String(cmd || "")).trim().slice(0, 500);
    if (clean) lastUserCommand = clean;
  }

  function getLastUserCommand() {
    return lastUserCommand;
  }

  function logError({ module = "unknown", error, userCommand = "", source = "" } = {}) {
    const nowIso = new Date().toISOString();
    const { message: rawMsg, stack: rawStack } = extractErrorDetails(error);
    const modName = String(module || source || "unknown").trim() || "unknown";
    const cleanMessage = redact(rawMsg).slice(0, 2000);
    const cleanStack = redact(rawStack).slice(0, 8000);
    const cleanCmd = redact(String(userCommand || lastUserCommand || "")).trim().slice(0, 500);
    const fingerprint = computeFingerprint(modName, cleanMessage, cleanStack);

    const existing = entriesByFingerprint.get(fingerprint);
    if (existing) {
      existing.count += 1;
      existing.time = nowIso;
      if (cleanCmd) existing.userCommand = cleanCmd;
      // Re-insert so insertion order reflects most recently updated entry
      entriesByFingerprint.delete(fingerprint);
      entriesByFingerprint.set(fingerprint, existing);
      try { persistAll(); } catch { /* never crash caller on disk write error */ }
      emitter.emit("error-repeated", { ...existing });
      return { entry: { ...existing }, isDuplicate: true };
    }

    const entry = {
      id: `err_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      time: nowIso,
      firstSeenAt: nowIso,
      module: modName,
      message: cleanMessage,
      stack: cleanStack,
      userCommand: cleanCmd,
      count: 1,
      fingerprint,
    };
    entriesByFingerprint.set(fingerprint, entry);
    try { persistAll(); } catch { /* never crash caller on disk write error */ }
    emitter.emit("error-logged", { ...entry });
    return { entry: { ...entry }, isDuplicate: false };
  }

  /**
   * Wrap a tool or module function with automatic try/catch error capture.
   */
  function wrapToolCall(moduleName, fn, { getUserCommand = null, rethrow = true } = {}) {
    if (typeof fn !== "function") {
      throw new TypeError(`wrapToolCall("${moduleName}") expected a function.`);
    }
    return async function wrappedToolExecution(...args) {
      let cmd = "";
      try {
        cmd = typeof getUserCommand === "function"
          ? String(getUserCommand(...args) || "")
          : lastUserCommand;
      } catch {
        cmd = lastUserCommand;
      }
      try {
        return await fn.apply(this, args);
      } catch (err) {
        const logged = logError({ module: moduleName, error: err, userCommand: cmd });
        if (rethrow) {
          if (err && typeof err === "object") {
            err._alreadyLoggedByErrorLogger = true;
            err._errorLoggerEntry = logged.entry;
          }
          throw err;
        }
        return {
          ok: false,
          action: moduleName,
          error: logged.entry.message,
          logEntry: logged.entry,
        };
      }
    };
  }

  function installGlobalHandlers({ onGlobalError = null } = {}) {
    if (globalHandlersInstalled) return false;
    globalHandlersInstalled = true;

    uncaughtListener = (err) => {
      const { entry } = logError({ module: "process.uncaughtException", error: err, source: "process" });
      if (typeof onGlobalError === "function") {
        try { onGlobalError("process.uncaughtException", err, entry); } catch { /* ignore */ }
      }
    };

    rejectionListener = (reason) => {
      const errObj = reason instanceof Error ? reason : new Error(String(reason || "Unhandled Promise Rejection"));
      const { entry } = logError({ module: "process.unhandledRejection", error: errObj, source: "process" });
      if (typeof onGlobalError === "function") {
        try { onGlobalError("process.unhandledRejection", errObj, entry); } catch { /* ignore */ }
      }
    };

    process.on("uncaughtException", uncaughtListener);
    process.on("unhandledRejection", rejectionListener);
    return true;
  }

  function uninstallGlobalHandlers() {
    if (!globalHandlersInstalled) return;
    if (uncaughtListener) process.off("uncaughtException", uncaughtListener);
    if (rejectionListener) process.off("unhandledRejection", rejectionListener);
    uncaughtListener = null;
    rejectionListener = null;
    globalHandlersInstalled = false;
  }

  function getRecentErrors(limit = 100) {
    const n = Math.max(1, Math.min(maxEntries, Math.floor(Number(limit) || 100)));
    return Array.from(entriesByFingerprint.values()).reverse().slice(0, n);
  }

  function clearErrors() {
    entriesByFingerprint.clear();
    try { persistAll(); } catch { /* ignore */ }
  }

  return Object.assign(emitter, {
    logFilePath,
    installGlobalHandlers,
    uninstallGlobalHandlers,
    wrapToolCall,
    logError,
    setLastUserCommand,
    getLastUserCommand,
    getRecentErrors,
    clearErrors,
  });
}

export const errorLogger = createErrorLogger();
export default errorLogger;
