// ─────────────────────────────────────────────────────────────
//  DELSHIV AI — DESKTOP APPLICATION (ELECTRON)
//  Real-Time Voice, Fast Flash Neural Core & Desktop Tool Suite
// ─────────────────────────────────────────────────────────────
import { exec, execFile, spawn } from "child_process";
import crypto from "crypto";
import electronPkg from "electron";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { analyzeClipboardText, normalizeClipboardText } from "./clipboard-intelligence.js";
import { createScheduler } from "./scheduler.js";
import { createBehaviorTracker, createOfflineQueue } from "./adaptive-offline.js";
import { buildReportMarkdown, markdownToHtml, AUDIENCES } from "./report-generator.js";
import { classifyRisk, configureSafetyPaths, createActivityLog, isProtectedPath, isSensitiveForPin } from "./safety-guard.js";
import { searchCode } from "./code-search.js";
import { createMacroStore, buildBriefingText } from "./automation.js";
import { resolveTargetDir, findDuplicates, planOrganize, applyOrganize, undoOrganize } from "./file-organizer.js";
import { createMemoryStore } from "./memory-store.js";
import { queryDocument } from "./document-qa.js";
import { manageWindows, automateInput } from "./window-automation.js";
import { getSystemHealthSummary, listProcesses, killProcess, listListeningPorts, freePort, pingHost } from "./system-health.js";
import { createRuleEngine } from "./rule-engine.js";
import { extractTextFromImage } from "./windows-ocr.js";
import { getOllamaStatus, askOllama } from "./ollama-client.js";
import { setRadioState, setBrightness, setDarkMode, setPowerPlan, SETTINGS_URIS } from "./windows-settings.js";
import { runWithStrategies, findFileAcrossUserDirs, buildSmartStrategies } from "./smart-executor.js";
import { listGmailMessages, readGmailMessage } from "./gmail-tool.js";
import { scanJunkFiles, cleanJunkFiles } from "./junk-cleaner.js";
import { readWebPage } from "./web-reader.js";
import { createClipboardHistory } from "./clipboard-history.js";
import { createFocusManager } from "./focus-mode.js";
import { sendMediaKey, playYouTube } from "./media-control.js";
import { createPinGuard } from "./pin-guard.js";
import { createPluginLoader } from "./plugin-loader.js";
import { tavilyWebSearch, fetchPageWithCheerio, fetchYoutubeTranscript } from "./research-tools.js";
import { createPcKnowledge, cleanCommandText, parseCommandIntent, logCommandTrace } from "./command-understanding.js";
import { createMemoryDb } from "./memory-db.js";
import errorLogger from "./src/healing/errorLogger.js";
import { APP_PATHS, CURRENT_SCHEMA_VERSION, getUserDataDir as getConfigUserDataDir } from "./src/config/appConfig.js";
import { createSecretsStore } from "./src/config/secretsStore.js";
import { runAppMigrations } from "./src/config/migrations.js";
import {
  GEMINI_MODELS,
  atomicWriteJson,
  atomicWriteText,
  cleanPowershellStderr,
  decodeHtmlEntities,
  isSafeExternalUrl,
  readJsonSafe,
  runPowerShellDetailed,
} from "./shared-utils.js";

let memoryDb = null;
let activeSessionId = "";

let pcKnowledge = null;

let clipboardHistory = null;
let focusManager = null;
let pinGuard = null;
let pluginLoader = null;

let ruleEngine = null;

let memoryStore = null;
let quickBarWin = null;

let macroStore = null;

let activityLog = null;

let behavior = null;
let offlineQueue = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!__dirname.includes(".asar")) {
  try { process.chdir(__dirname); } catch { /* ignore */ }
}

const { app, BrowserWindow, Menu, session, shell, ipcMain, clipboard, desktopCapturer, screen, globalShortcut, Notification, safeStorage } =
  typeof electronPkg === "object" && electronPkg !== null ? electronPkg : {};

const gotSingleInstanceLock = app ? app.requestSingleInstanceLock() : true;
if (app && !gotSingleInstanceLock) {
  app.quit();
}

const API_KEY_RE = /^(AIza[0-9A-Za-z_-]{25,60}|AQ\.[0-9A-Za-z_.-]{20,120})$/;

let win = null;
const errorLogs = [];
const MAX_ERROR_LOGS = 200;

function sendToRenderer(channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch { /* window closing */ }
}

export function logBackendError(action, err, extra = {}) {
  const now = new Date();
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && err.message
        ? String(err.message)
        : String(err || "Unknown error");

  const rawStack =
    err instanceof Error && err.stack
      ? err.stack
      : typeof err === "object" && err !== null && err.stack
        ? String(err.stack)
        : typeof extra.stack === "string" && extra.stack
          ? extra.stack
          : new Error(message).stack || message;

  const entry = {
    id: `err_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toISOString(),
    time: now.toLocaleTimeString("en-US", { hour12: false }),
    action: String(action || "Backend Operation"),
    source: String(extra.source || "main.js"),
    message,
    stack: rawStack,
  };

  errorLogs.unshift(entry);
  if (errorLogs.length > MAX_ERROR_LOGS) {
    errorLogs.length = MAX_ERROR_LOGS;
  }

  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send("delshiv:error-log", entry);
    }
  } catch { }

  if (!extra?._fromErrorLogger) {
    try {
      errorLogger.logError({
        module: String(action || extra?.source || "main.js"),
        error: err,
        userCommand: extra?.userCommand || errorLogger.getLastUserCommand(),
        source: extra?.source || "main.js",
      });
    } catch { /* non-fatal */ }
  }

  return entry;
}

errorLogger.installGlobalHandlers({
  onGlobalError: (action, err) => {
    logBackendError(action, err, { source: "process", _fromErrorLogger: true });
  },
});

let secretsStore = null;
function getSecretsStore() {
  if (!secretsStore) {
    secretsStore = createSecretsStore({
      filePath: APP_PATHS.secrets,
      safeStorage,
      onError: (a, e) => logBackendError(a, e, { source: "secretsStore" }),
    });
  }
  return secretsStore;
}

export function getUserDataDir() {
  return getConfigUserDataDir();
}

export function getUserEnvFile() {
  return APP_PATHS.legacyEnv;
}

export function readStoredApiKey() {
  const fromSecrets = getSecretsStore().getSecret("GEMINI_API_KEY");
  if (API_KEY_RE.test(fromSecrets)) return fromSecrets;
  const envKey = String(process.env.GEMINI_API_KEY || "").trim();
  return API_KEY_RE.test(envKey) ? envKey : "";
}

export function readStoredTavilyKey() {
  const fromSecrets = getSecretsStore().getSecret("TAVILY_API_KEY");
  if (fromSecrets) return fromSecrets;
  return String(process.env.TAVILY_API_KEY || "").trim();
}

export function saveStoredTavilyKey(key) {
  const clean = String(key || "").trim();
  if (!clean || clean.length < 10 || /[\r\n\0]/.test(clean)) return false;
  return getSecretsStore().setSecret("TAVILY_API_KEY", clean);
}

export function saveStoredApiKey(key) {
  const clean = String(key || "").trim();
  if (/[\r\n\0]/.test(clean) || !API_KEY_RE.test(clean)) {
    logBackendError("saveStoredApiKey", new Error("Rejected invalid GEMINI_API_KEY format."));
    return false;
  }
  return getSecretsStore().setSecret("GEMINI_API_KEY", clean);
}

function isAllowedAppNavigation(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== "file:") return false;
    const resolved = path.resolve(fileURLToPath(u));
    const publicDir = path.resolve(path.join(__dirname, "public"));
    const rel = path.relative(publicDir, resolved);
    return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export function registerFirstAvailableShortcut(label, candidates = [], callback, shortcutApi = globalShortcut) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!shortcutApi || typeof shortcutApi.register !== "function") {
    return { ok: false, accelerator: null, tried: [...list], label };
  }
  const tried = [];
  for (const rawAcc of list) {
    const acc = String(rawAcc || "").trim();
    if (!acc) continue;
    tried.push(acc);
    try {
      if (typeof shortcutApi.isRegistered === "function" && shortcutApi.isRegistered(acc)) {
        continue;
      }
      if (shortcutApi.register(acc, callback)) {
        return { ok: true, accelerator: acc, tried, label };
      }
    } catch { /* try next fallback accelerator */ }
  }
  return { ok: false, accelerator: null, tried, label };
}

function createWindow() {
  if (session?.defaultSession) {
    const ALLOWED_PERMS = new Set(["media", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
    const isLocalOrigin = (wc, requestingOrigin) => {
      const url = requestingOrigin || wc?.getURL?.() || "";
      return url === "" || url.startsWith("file://");
    };
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      ALLOWED_PERMS.has(permission) && isLocalOrigin(wc, requestingOrigin)
    );
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      cb(ALLOWED_PERMS.has(permission) && isLocalOrigin(wc, details?.requestingUrl));
    });
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: ["https://ipwho.is/*", "https://*.open-meteo.com/*"] },
      (details, callback) => {
        const headers = { ...(details.responseHeaders || {}) };
        delete headers["access-control-allow-origin"];
        delete headers["Access-Control-Allow-Origin"];
        headers["Access-Control-Allow-Origin"] = ["*"];
        callback({ responseHeaders: headers });
      }
    );
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: "Delshiv AI — Real-Time Voice & Fast Flash Neural Core",
    icon: path.join(__dirname, "assets", "icon.ico"),
    backgroundColor: "#04080e",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  Menu.setApplicationMenu(null);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => logBackendError(`shell.openExternal (${url})`, err));
    } else {
      logBackendError("setWindowOpenHandler", new Error(`Blocked unsafe external URL scheme: ${String(url || "").slice(0, 120)}`));
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (evt, url) => {
    if (isAllowedAppNavigation(url)) return;
    evt.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch((err) => logBackendError(`will-navigate openExternal (${url})`, err));
    } else {
      logBackendError("webContents.will-navigate", new Error(`Blocked navigation to unsafe URL: ${String(url || "").slice(0, 120)}`));
    }
  });

  win.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL) => {
    logBackendError(
      "webContents.did-fail-load",
      new Error(`Load failed (${errorCode}): ${errorDescription} [${String(validatedURL || "unknown URL").split("?")[0]}]`)
    );
  });

  win.webContents.on("preload-error", (_evt, preloadPath, err) => {
    logBackendError(`webContents.preload-error (${preloadPath || "preload.cjs"})`, err);
  });

  win.webContents.on("render-process-gone", (_evt, details) => {
    logBackendError(
      "webContents.render-process-gone",
      new Error(`Renderer process gone: reason=${details?.reason || "unknown"}, exitCode=${details?.exitCode ?? "?"}`)
    );
  });

  win.loadFile(path.join(__dirname, "public", "index.html"))
    .catch((err) => logBackendError("win.loadFile", err));

  win.once("ready-to-show", () => {
    if (win) {
      win.show();
      win.focus();
    }
    try {
      if (globalShortcut && typeof globalShortcut.register === "function") {
        const voiceReg = registerFirstAvailableShortcut(
          "Voice Listening",
          ["CommandOrControl+Shift+Space", "CommandOrControl+Shift+D", "Alt+Shift+V"],
          () => {
            if (win && !win.isDestroyed()) {
              if (win.isMinimized()) win.restore();
              win.show();
              win.focus();
              sendToRenderer("delshiv:trigger-voice-listening");
            }
          }
        );
        if (!voiceReg.ok) {
          logBackendError(
            "globalShortcut.register",
            new Error(`Voice Listening shortcut conflict: all candidates are already in use (${voiceReg.tried.join(", ")}).`)
          );
        }

        const barReg = registerFirstAvailableShortcut(
          "Quick Bar",
          ["CommandOrControl+Alt+Space", "CommandOrControl+Shift+K", "Alt+Shift+Space", "CommandOrControl+Alt+K"],
          () => {
            toggleQuickBar();
          }
        );
        if (!barReg.ok) {
          logBackendError(
            "globalShortcut.register",
            new Error(`Quick Bar shortcut conflict: all candidates are already in use (${barReg.tried.join(", ")}).`)
          );
        }
      }
    } catch (err) {
      logBackendError("globalShortcut.register", err);
    }
  });

  win.on("closed", () => {
    win = null;
    app.quit();
  });
}

let cachedCountry = { at: 0, code: "IN", name: "India" };
const newsCache = new Map();
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_NEWS_CACHE_ENTRIES = 50;

function decodeRss(s) {
  return decodeHtmlEntities(s).trim();
}

function parseRssItems(xml) {
  const src = String(xml || "");
  const items = [...src.matchAll(/<item(?:\s+[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => {
    const b = m[1];
    const title = decodeRss((b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = decodeRss((b.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const source = decodeRss((b.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1]);
    const pubDate = ((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "").trim();
    const cleanTitle = source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title;
    return { title: cleanTitle, link, source: source || "Live News", pubDate };
  }).filter((x) => x.title);
  if (items.length) return items;

  // Atom <entry> fallback
  return [...src.matchAll(/<entry(?:\s+[^>]*)?>([\s\S]*?)<\/entry>/gi)].map((m) => {
    const b = m[1];
    const title = decodeRss((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = decodeRss((b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1]);
    const pubDate = ((b.match(/<(?:updated|published)>([\s\S]*?)<\/(?:updated|published)>/i) || [])[1] || "").trim();
    return { title, link, source: "Live News", pubDate };
  }).filter((x) => x.title);
}

async function fetchNewsWithFallback(query = "") {
  const country = await getAppCountry();
  const cc = country.code || "IN";
  const q = String(query || "").trim();
  const cacheKey = `${cc}:${q.toLowerCase()}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < NEWS_CACHE_TTL_MS && cached.items.length) {
    return { country, cc, items: cached.items, cached: true };
  }

  const urls = q
    ? [
        `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-${cc}&gl=${cc}&ceid=${cc}:en`,
        `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`,
      ]
    : [
        `https://news.google.com/rss/headlines/section/topic/NATION?hl=en-${cc}&gl=${cc}&ceid=${cc}:en`,
        "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        `https://www.bing.com/news/search?q=${encodeURIComponent(cc === "IN" ? "India top news" : "top news")}&format=rss`,
      ];

  const errors = [];
  let items = [];
  for (const url of urls) {
    try {
      const list = await fetchRss(url);
      if (list.length) {
        items = list;
        break;
      }
    } catch (err) {
      errors.push(`${new URL(url).hostname}: ${err.message}`);
    }
  }

  if (!items.length && cached && cached.items.length) {
    return { country, cc, items: cached.items, stale: true };
  }
  if (!items.length) {
    throw new Error(`All RSS feeds failed: ${errors.join(" | ")}`);
  }

  const seen = new Set();
  items = items.filter((it) => {
    const k = it.title.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  items.sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
  if (newsCache.size >= MAX_NEWS_CACHE_ENTRIES) {
    const firstKey = newsCache.keys().next().value;
    if (firstKey !== undefined) newsCache.delete(firstKey);
  }
  newsCache.set(cacheKey, { at: Date.now(), items });
  return { country, cc, items };
}

async function fetchRss(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
  return parseRssItems(await res.text());
}

async function getAppCountry() {
  if (cachedCountry.at && Date.now() - cachedCountry.at < 60 * 60 * 1000) return cachedCountry;
  try {
    const r = await fetch("https://ipwho.is/", { signal: AbortSignal.timeout(4500) });
    if (!r.ok) throw new Error(`ipwho.is HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.success && j.country_code) {
      cachedCountry = {
        at: Date.now(),
        code: String(j.country_code).toUpperCase(),
        name: String(j.country || j.country_code),
      };
    } else if (j && j.success === false) {
      throw new Error(j.message || "ipwho.is lookup returned success=false");
    }
  } catch (err) {
    logBackendError("getAppCountry (ipwho.is)", err);
  }
  return cachedCountry;
}

// ─────────────────────────────────────────────────────────────
//  1. POWERSHELL / TERMINAL COMMAND EXECUTION (runCommand)
// ─────────────────────────────────────────────────────────────
export async function runCommandTool(opts = {}) {
  const o = typeof opts === "string" ? { command: opts } : (opts && typeof opts === "object" ? opts : {});
  const command = String(o.command || o.cmd || o.target || "").trim();
  const cwd = o.cwd ? path.resolve(String(o.cwd)) : __dirname;
  const timeoutMs = Math.min(60000, Math.max(1000, Number(o.timeoutMs) || 15000));
  const shellName = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const actionName = `runCommand (${command.slice(0, 60) || "empty"})`;

  if (!command) {
    const err = new Error("runCommand requires a non-empty command string.");
    const logEntry = logBackendError(actionName, err, { source: "main.js:runCommand" });
    return { ok: false, action: actionName, command: "", stdout: "", stderr: "", exitCode: 1, error: err.message, logEntry };
  }

  const t0 = Date.now();
  return new Promise((resolve) => {
    const onDone = (err, stdout, stderr) => {
      const rawStderr = String(stderr || "");
      const outStr = String(stdout || "").trim();
      const errStr = cleanPowershellStderr(rawStderr);
      const durationMs = Date.now() - t0;
      const nonTerminatingErr = !err && rawStderr.includes('<S S="Error">') && !outStr;

      if (err || nonTerminatingErr) {
        const exitCode = typeof err?.code === "number" ? err.code : 1;
        const detailMsg = errStr
          ? `Command failed (exit code ${exitCode}): ${errStr}`
          : `Command failed (exit code ${exitCode}): ${err?.message || "PowerShell error"}`;
        const wrappedErr = new Error(detailMsg);
        const cleanErrStack = String(err?.stack || "")
          .replace(/#< CLIXML[\s\S]*?<\/Objs>/g, "")
          .replace(/-EncodedCommand\s+[A-Za-z0-9+/=]+/g, "-EncodedCommand <base64>")
          .trim();
        wrappedErr.stack = [
          `Command: ${command}`,
          `Working Directory: ${cwd}`,
          `Exit Code: ${exitCode} (${durationMs}ms)`,
          errStr ? `STDERR:\n${errStr}` : "",
          outStr ? `STDOUT:\n${outStr}` : "",
          cleanErrStack,
        ]
          .filter(Boolean)
          .join("\n");

        const logEntry = o.quiet ? null : logBackendError(actionName, wrappedErr, { source: "main.js:runCommand" });
        resolve({
          ok: false,
          action: actionName,
          command,
          cwd,
          stdout: outStr,
          stderr: errStr,
          exitCode,
          durationMs,
          error: detailMsg,
          logEntry,
        });
        return;
      }

      resolve({
        ok: true,
        action: actionName,
        command,
        cwd,
        stdout: outStr,
        stderr: errStr,
        exitCode: 0,
        durationMs,
      });
    };

    if (process.platform === "win32") {
      // Encode as UTF-16LE Base64 so Unicode paths (e.g. C:\Users\...\문서\Desktop) are never mangled to ??
      const psScript = [
        "$ProgressPreference = 'SilentlyContinue';",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8;",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "$OutputEncoding = [System.Text.Encoding]::UTF8;",
        command,
      ].join("\n");
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand", encoded],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        onDone
      );
      return;
    }

    exec(
      command,
      {
        cwd,
        shell: shellName,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      onDone
    );
  });
}

// ─────────────────────────────────────────────────────────────
//  2. FILE & FOLDER MANAGEMENT TOOLS (readFile, writeFile, editFile, globFiles, createFolder)
// ─────────────────────────────────────────────────────────────
export function getDesktopDir() {
  try {
    if (app && typeof app.getPath === "function") {
      const p = app.getPath("desktop");
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  const parentDir = path.dirname(__dirname);
  if (path.basename(parentDir).toLowerCase() === "desktop" && fs.existsSync(parentDir)) {
    return parentDir;
  }
  const stdDesktop = path.join(os.homedir(), "Desktop");
  if (fs.existsSync(stdDesktop)) return stdDesktop;
  return parentDir;
}

function getSpecialUserDir(kind) {
  const k = kind.toLowerCase();
  if (k === "desktop") return getDesktopDir();
  const map = { downloads: "downloads", download: "downloads", documents: "documents", document: "documents", pictures: "pictures", picture: "pictures", videos: "videos", video: "videos", music: "music" };
  const electronKey = map[k];
  if (!electronKey) return null;
  try {
    if (app && typeof app.getPath === "function") {
      const p = app.getPath(electronKey);
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* fallback to homedir */ }
  const folder = electronKey[0].toUpperCase() + electronKey.slice(1);
  return path.join(os.homedir(), folder);
}

function getAllSpecialUserDirs() {
  return {
    desktop: getDesktopDir(),
    downloads: getSpecialUserDir("downloads"),
    documents: getSpecialUserDir("documents"),
    pictures: getSpecialUserDir("pictures"),
    videos: getSpecialUserDir("videos"),
    music: getSpecialUserDir("music"),
  };
}

function resolveFilePath(rawPath, baseDir = __dirname) {
  const clean = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!clean) {
    throw new Error("File path is required and cannot be empty.");
  }
  if (/^~([\\/]|$)/.test(clean)) {
    const sub = clean.replace(/^~[\\/]?/, "");
    return sub ? path.join(os.homedir(), sub) : os.homedir();
  }
  const m = clean.match(/^(desktop|downloads?|documents?|pictures?|videos?|music)(?:[\\/](.*))?$/i);
  if (m) {
    const base = getSpecialUserDir(m[1]);
    return m[2] ? path.join(base, m[2]) : base;
  }
  return path.isAbsolute(clean) ? path.normalize(clean) : path.resolve(baseDir, clean);
}

configureSafetyPaths({
  appDir: __dirname,
  userDataDir: getUserDataDir(),
  resolvePath: resolveFilePath,
});

export async function createFolderTool(opts = {}) {
  const o = typeof opts === "string" ? { folderName: opts } : (opts && typeof opts === "object" ? opts : {});
  const rawName = String(o.folderName || o.name || o.path || o.target || "New_Folder")
    .trim()
    .replace(/^["']|["']$/g, "");
  const onDesktop =
    o.onDesktop !== undefined
      ? Boolean(o.onDesktop)
      : /desktop|डेस्कटॉप/i.test(String(o.rawText || rawName || "")) || (!rawName.includes("/") && !rawName.includes("\\"));

  const cleanFolderName =
    rawName
      .replace(/^(?:desktop[\\/]?|डेस्कटॉप\s*पर\s+|desktop\s*par\s+|(?:ek|a|folder)\s+)/gi, "")
      .replace(/[<>:"|?*]/g, "_")
      .trim() || "Delshiv_Folder";

  const baseDir = onDesktop ? getDesktopDir() : (o.cwd ? path.resolve(String(o.cwd)) : __dirname);
  let targetDir = path.isAbsolute(rawName) ? path.normalize(rawName) : path.resolve(baseDir, cleanFolderName);
  const actionName = `createFolder (${targetDir})`;

  try {
    if (!path.isAbsolute(rawName)) {
      const rel = path.relative(path.resolve(baseDir), targetDir);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Refusing path traversal outside base directory: ${rawName}`);
      }
    }
    if (isProtectedPath(targetDir, o.cwd)) {
      return { ok: false, action: actionName, blocked: true, error: `Refusing to create folder in protected location: ${targetDir}` };
    }
    if (fs.existsSync(targetDir) && cleanFolderName === "Delshiv_Folder") {
      targetDir = path.join(baseDir, `Delshiv_Folder_${Date.now().toString().slice(-4)}`);
    }
    await fs.promises.mkdir(targetDir, { recursive: true });
    const stat = await fs.promises.stat(targetDir);
    if (!stat.isDirectory()) {
      throw new Error(`Failed to verify created directory at ${targetDir}`);
    }
    return {
      ok: true,
      action: actionName,
      folderPath: targetDir,
      message: `Folder created successfully at: ${targetDir}`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:createFolder" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function deletePathTool(opts = {}) {
  const o = typeof opts === "string" ? { targetPath: opts } : (opts && typeof opts === "object" ? opts : {});
  const rawInput = o.targetPath || o.path || o.filePath || o.folderName || o.target || "";
  const cleanInput = String(rawInput || "").trim().replace(/^["']|["']$/g, "");
  const permanent = Boolean(o.permanent);
  const actionName = `deletePath (${cleanInput || "empty"})`;

  if (!cleanInput) {
    const err = new Error("deletePath requires a target file or folder path.");
    const logEntry = logBackendError(actionName, err, { source: "main.js:deletePath" });
    return { ok: false, action: actionName, error: err.message, logEntry };
  }

  try {
    const resolved = resolveFilePath(cleanInput, o.cwd);
    if (isProtectedPath(resolved, o.cwd)) {
      return { ok: false, action: actionName, blocked: true, error: `Blocked protected system or security path: ${resolved}` };
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }

    if (!permanent) {
      if (!shell || typeof shell.trashItem !== "function") {
        throw new Error("Recycle Bin API is unavailable; pass permanent=true explicitly to delete permanently.");
      }
      await shell.trashItem(resolved);
      return {
        ok: true,
        action: actionName,
        deletedPath: resolved,
        method: "trash",
        message: `Moved to Recycle Bin: ${resolved}`,
      };
    }

    await fs.promises.rm(resolved, { recursive: true, force: true });
    return {
      ok: true,
      action: actionName,
      deletedPath: resolved,
      method: "rm",
      message: `Deleted permanently: ${resolved}`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:deletePath" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;

export async function readFileTool(opts = {}) {
  const o = typeof opts === "string" ? { filePath: opts } : (opts && typeof opts === "object" ? opts : {});
  const rawPath = o.filePath || o.path || o.target || "";
  const actionName = `readFile (${rawPath || "empty"})`;
  try {
    const resolved = resolveFilePath(rawPath, o.cwd);
    if (isProtectedPath(resolved, o.cwd)) {
      return { ok: false, action: actionName, blocked: true, error: `Refusing to read protected system or security file: ${resolved}` };
    }
    const stat = await fs.promises.stat(resolved);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${resolved}`);
    }
    if (stat.size > MAX_READ_FILE_BYTES) {
      throw new Error(`File exceeds 5 MB read limit (${Math.round(stat.size / 1048576)} MB): ${resolved}`);
    }
    const content = await fs.promises.readFile(resolved, { encoding: o.encoding || "utf-8" });
    const lines = content.split(/\r?\n/);
    const startLine = Math.max(1, Number(o.startLine) || 1);
    const endLine = Math.min(lines.length, Number(o.endLine) || lines.length);
    const sliced =
      o.startLine || o.endLine ? lines.slice(startLine - 1, endLine).join("\n") : content;

    return {
      ok: true,
      action: actionName,
      filePath: resolved,
      sizeBytes: stat.size,
      totalLines: lines.length,
      content: sliced,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:readFile" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function writeFileTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const rawPath = o.filePath || o.path || o.target || "";
  const actionName = `writeFile (${rawPath || "empty"})`;
  try {
    const resolved = resolveFilePath(rawPath, o.cwd);
    if (isProtectedPath(resolved, o.cwd)) {
      return { ok: false, action: actionName, blocked: true, error: `Refusing to write protected location: ${resolved}` };
    }
    const content = String(o.content ?? "");
    const append = Boolean(o.append);
    const overwrite = o.overwrite !== undefined ? Boolean(o.overwrite) : true;

    if (!append && !overwrite && fs.existsSync(resolved)) {
      throw new Error(`File already exists and overwrite=false: ${resolved}`);
    }

    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    if (append) {
      await fs.promises.appendFile(resolved, content, "utf-8");
    } else {
      atomicWriteText(resolved, content);
    }

    const stat = await fs.promises.stat(resolved);
    return {
      ok: true,
      action: actionName,
      filePath: resolved,
      sizeBytes: stat.size,
      appended: append,
      message: `${append ? "Appended to" : "Wrote"} ${resolved} (${stat.size} bytes)`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:writeFile" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function editFileTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const rawPath = o.filePath || o.path || "";
  const actionName = `editFile (${rawPath || "empty"})`;
  try {
    const resolved = resolveFilePath(rawPath, o.cwd);
    if (isProtectedPath(resolved, o.cwd)) {
      return { ok: false, action: actionName, blocked: true, error: `Refusing to edit protected location: ${resolved}` };
    }
    const targetText = String(o.target ?? o.find ?? "");
    const replacementText = String(o.replacement ?? o.replace ?? "");

    if (!targetText) {
      throw new Error("editFile requires a non-empty 'target' string to replace.");
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }

    const existing = await fs.promises.readFile(resolved, "utf-8");
    if (!existing.includes(targetText)) {
      throw new Error(`Target string (${targetText.slice(0, 60)}) not found in ${resolved}`);
    }

    const occurrences = existing.split(targetText).length - 1;
    const updated = existing.split(targetText).join(replacementText);
    atomicWriteText(resolved, updated);

    return {
      ok: true,
      action: actionName,
      filePath: resolved,
      replacements: occurrences,
      message: `Replaced ${occurrences} occurrence(s) in ${resolved}`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:editFile" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

function globToRegExp(globPattern) {
  const clean = String(globPattern || "*").trim().replace(/\\/g, "/");
  let regexStr = "^";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "*") {
      if (clean[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (c === "?") {
      regexStr += "[^/]";
    } else if (".+^$()|[]{}\\".includes(c)) {
      regexStr += "\\" + c;
    } else {
      regexStr += c;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "i");
}

export async function globFilesTool(opts = {}) {
  const o = typeof opts === "string" ? { pattern: opts } : (opts && typeof opts === "object" ? opts : {});
  const pattern = String(o.pattern || o.query || o.target || "*").trim() || "*";
  const baseDir = o.cwd ? resolveFilePath(o.cwd) : __dirname;
  const maxResults = Math.min(500, Math.max(1, Number(o.maxResults) || 150));
  const actionName = `globFiles (${pattern})`;

  try {
    const stat = await fs.promises.stat(baseDir);
    if (!stat.isDirectory()) {
      throw new Error(`Base path is not a directory: ${baseDir}`);
    }

    const hasSlash = pattern.includes("/") || pattern.includes("\\");
    const matcher = globToRegExp(hasSlash ? pattern : `**/${pattern}`);
    const nameMatcher = globToRegExp(pattern);
    const matches = [];
    const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next"]);
    const visitedDirs = new Set();

    async function walk(dir, depth = 0) {
      if (matches.length >= maxResults || depth > 12) return;
      let realDir;
      try {
        realDir = await fs.promises.realpath(dir);
      } catch {
        return;
      }
      if (visitedDirs.has(realDir)) return;
      visitedDirs.add(realDir);

      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= maxResults) break;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) {
            await walk(fullPath, depth + 1);
          }
        } else if (matcher.test(relPath) || (!hasSlash && nameMatcher.test(entry.name))) {
          matches.push({
            path: fullPath,
            relativePath: relPath,
            name: entry.name,
          });
        }
      }
    }

    await walk(baseDir, 0);
    return {
      ok: true,
      action: actionName,
      baseDir,
      pattern,
      count: matches.length,
      files: matches,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:globFiles" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  3. WEB SEARCH & BROWSER INTEGRATION (webSearch, openUrl)
// ─────────────────────────────────────────────────────────────
const KNOWN_WEB_TARGETS = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  github: "https://github.com",
  whatsapp: "https://web.whatsapp.com",
  instagram: "https://www.instagram.com",
  facebook: "https://www.facebook.com",
  twitter: "https://x.com",
  x: "https://x.com",
  linkedin: "https://www.linkedin.com",
  chatgpt: "https://chatgpt.com",
  netflix: "https://www.netflix.com",
  amazon: "https://www.amazon.in",
  flipkart: "https://www.flipkart.com",
};

export async function openUrlTool(opts = {}) {
  const o = typeof opts === "string" ? { url: opts } : (opts && typeof opts === "object" ? opts : {});
  const raw = String(o.url || o.target || "").trim();
  const actionName = `openUrl (${raw || "empty"})`;
  try {
    if (!raw) {
      throw new Error("openUrl requires a non-empty URL or site name.");
    }
    const lower = raw.toLowerCase();
    let finalUrl = KNOWN_WEB_TARGETS[lower] || raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(finalUrl)) {
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(finalUrl)) {
        finalUrl = `https://${finalUrl}`;
      } else {
        throw new Error(`Invalid URL format: "${raw}". Expected http(s):// or a valid domain.`);
      }
    }
    if (!isSafeExternalUrl(finalUrl)) {
      throw new Error(`Blocked unsafe URL scheme in openUrl: "${raw}". Only http(s) URLs are allowed.`);
    }
    await shell.openExternal(finalUrl);
    return {
      ok: true,
      action: actionName,
      url: finalUrl,
      message: `Opened ${finalUrl} in browser.`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:openUrl" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function webSearchTool(opts = {}) {
  const query = String(
    typeof opts === "string" ? opts : opts.query || opts.target || opts.q || ""
  ).trim();
  const openInBrowser = Boolean(opts?.openInBrowser);
  const actionName = `webSearch (${query || "empty"})`;

  try {
    if (!query) {
      throw new Error("webSearch requires a non-empty search query.");
    }

    const country = await getAppCountry();
    const cc = country.code || "IN";
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-${cc}&gl=${cc}&ceid=${cc}:en`;
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const [rssRes, ddgRes] = await Promise.allSettled([
      fetchRss(rssUrl),
      fetch(ddgUrl, { signal: AbortSignal.timeout(6000) }).then((r) => {
        if (!r.ok) throw new Error(`DuckDuckGo HTTP ${r.status}`);
        return r.json();
      }),
    ]);

    const results = [];
    if (ddgRes.status === "fulfilled" && ddgRes.value) {
      const d = ddgRes.value;
      if (d.AbstractText) {
        results.push({
          title: d.Heading || query,
          snippet: d.AbstractText,
          url: d.AbstractURL || "",
          source: d.AbstractSource || "DuckDuckGo Instant Answer",
        });
      }
      if (Array.isArray(d.RelatedTopics)) {
        for (const t of d.RelatedTopics.slice(0, 5)) {
          if (t && t.Text && t.FirstURL) {
            results.push({
              title: t.Text.split(" - ")[0] || t.Text.slice(0, 80),
              snippet: t.Text,
              url: t.FirstURL,
              source: "DuckDuckGo",
            });
          }
        }
      }
    }

    if (rssRes.status === "fulfilled" && Array.isArray(rssRes.value)) {
      for (const item of rssRes.value.slice(0, 8)) {
        results.push({
          title: item.title,
          snippet: `${item.title} (${item.source})`,
          url: item.link,
          source: item.source,
          pubDate: item.pubDate,
        });
      }
    }

    if (openInBrowser) {
      await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
    }

    if (!results.length && rssRes.status === "rejected" && ddgRes.status === "rejected") {
      throw new Error(
        `Web search failed: ${rssRes.reason?.message || rssRes.reason} | ${ddgRes.reason?.message || ddgRes.reason}`
      );
    }

    return {
      ok: true,
      action: actionName,
      query,
      count: results.length,
      results,
      openedBrowser: openInBrowser,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:webSearch" });
    return { ok: false, action: actionName, query, results: [], error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  4. NOTES & TASKS MANAGEMENT TOOLS (manageNotes, manageTasks)
// ─────────────────────────────────────────────────────────────
function getNotesTasksFilePath() {
  return APP_PATHS.notesTasks;
}

function readNotesTasksStore() {
  const file = getNotesTasksFilePath();
  const parsed = readJsonSafe(file, { notes: [], tasks: [] }, (a, e) => logBackendError(a, e, { source: "notes_tasks" }));
  return {
    notes: Array.isArray(parsed?.notes) ? parsed.notes : [],
    tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
  };
}

function writeNotesTasksStore(store) {
  atomicWriteJson(getNotesTasksFilePath(), store);
}

export async function manageNotesTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || o.op || "list").toLowerCase().trim();
  const actionName = `manageNotes (${operation})`;
  try {
    const store = readNotesTasksStore();

    if (operation === "list" || operation === "get") {
      return { ok: true, action: actionName, notes: store.notes };
    }

    if (operation === "add" || operation === "create") {
      const content = String(o.content || o.text || o.target || "").trim();
      const title = String(o.title || content.slice(0, 48) || "").trim();
      if (!content) {
        throw new Error("Cannot create an empty note. Provide 'content' or 'text'.");
      }
      const note = {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title,
        content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.notes.unshift(note);
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, note, notes: store.notes, message: `Note saved: "${title}"` };
    }

    if (operation === "update" || operation === "edit") {
      const id = String(o.id || "").trim();
      const content = String(o.content || o.text || "").trim();
      if (!id || !content) {
        throw new Error("Note 'id' and 'content' are required for update.");
      }
      const target = store.notes.find((n) => n.id === id || n.title.toLowerCase() === id.toLowerCase());
      if (!target) {
        throw new Error(`Note with id/title "${id}" not found.`);
      }
      target.content = content;
      if (o.title) target.title = String(o.title).trim();
      target.updatedAt = new Date().toISOString();
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, note: target, notes: store.notes, message: `Updated note "${target.title}"` };
    }

    if (operation === "delete" || operation === "remove") {
      const id = String(o.id || o.target || "").trim();
      if (!id) {
        throw new Error("Note 'id' or title is required for delete.");
      }
      const idx = store.notes.findIndex((n) => n.id === id || n.title.toLowerCase() === id.toLowerCase());
      if (idx === -1) {
        throw new Error(`Note "${id}" not found.`);
      }
      const [removed] = store.notes.splice(idx, 1);
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, removed, notes: store.notes, message: `Deleted note "${removed.title}"` };
    }

    if (operation === "clear") {
      store.notes = [];
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, notes: [], message: "Cleared all notes." };
    }

    throw new Error(`Unsupported notes operation: "${operation}". Valid operations: list, add, update, delete, clear.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:manageNotes" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  SCHEDULER TOOL (scheduleTask) — persistent reminders / recurring jobs
// ─────────────────────────────────────────────────────────────
let scheduler = null;

function showDesktopNotification(title, body) {
  try {
    if (Notification && Notification.isSupported()) {
      new Notification({ title, body: String(body || "").slice(0, 400) }).show();
    }
  } catch (err) {
    logBackendError("showDesktopNotification", err);
  }
}

async function handleScheduledTaskDue(task, { missedByMs = 0 } = {}) {
  const late = missedByMs > 2 * 60 * 1000 ? " (missed while app was closed)" : "";
  const payload = task.actionPayload || {};
  if (payload.type === "briefing") {
    const text = await generateBriefing();
    showDesktopNotification("☀️ Daily Briefing", text);
    sendToRenderer("delshiv:scheduler-fired", { task, ok: true, summary: text.replace(/\n/g, " • ") });
    return;
  }
  if (payload.type === "macro") {
    const out = await runMacroByName(payload.macro, { fromScheduler: true });
    const summary = out.failed ? `${out.failed}/${out.results.length} step(s) failed` : `ran ${out.results.length} step(s)`;
    showDesktopNotification(`Macro: ${out.macro.name}${late}`, summary);
    sendToRenderer("delshiv:scheduler-fired", { task, ok: out.failed === 0, summary });
    return;
  }
  if (payload.type === "command" && payload.command) {
    const risk = classifyRisk("runCommand", { command: payload.command });
    if (risk.level === "block") {
      const msg = `Blocked scheduled command for safety: ${risk.reason}`;
      showDesktopNotification(`Blocked: ${task.taskName}`, msg);
      sendToRenderer("delshiv:scheduler-fired", { task, ok: false, summary: msg });
      return;
    }
    const res = await runCommandTool({ command: payload.command, timeoutMs: 60000 });
    activityLog?.record({ tool: "scheduleTask(command)", payload: { command: payload.command }, decision: risk.level === "confirm" ? "scheduled-confirmed" : "auto", ok: Boolean(res?.ok), error: res?.error, ms: res?.durationMs || 0 });
    const summary = res.ok ? (String(res.stdout || "").trim().slice(0, 200) || "Completed.") : `Failed: ${res.error || res.stderr || "unknown error"}`;
    showDesktopNotification(`Scheduled: ${task.taskName}${late}`, summary);
    sendToRenderer("delshiv:scheduler-fired", { task, ok: res.ok, summary });
    return;
  }
  showDesktopNotification(`⏰ ${task.taskName}${late}`, payload.text || task.taskName);
  sendToRenderer("delshiv:scheduler-fired", { task, ok: true, summary: payload.text || task.taskName });
}

export async function scheduleTaskTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || o.op || "list").toLowerCase().trim();
  const actionName = `scheduleTask (${operation})`;
  try {
    if (!scheduler) throw new Error("Scheduler is not running yet.");
    if (operation === "now") {
      return { ok: true, action: actionName, ...scheduler.now() };
    }
    if (operation === "list") {
      const tasks = scheduler.list();
      return { ok: true, action: actionName, tasks, message: tasks.length ? `${tasks.length} scheduled task(s).` : "No scheduled tasks." };
    }
    if (operation === "add" || operation === "create") {
      const task = scheduler.add({
        taskName: o.taskName || o.title || o.name,
        scheduleType: o.scheduleType,
        cronOrDelay: o.cronOrDelay ?? o.cron ?? o.delay ?? o.runAt,
        actionPayload: o.actionPayload,
      });
      return {
        ok: true,
        action: actionName,
        task,
        tasks: scheduler.list(),
        message: `Scheduled "${task.taskName}" (${task.scheduleType}) — next run ${new Date(task.nextRunAt).toLocaleString()}.`,
      };
    }
    if (operation === "cancel" || operation === "delete" || operation === "remove") {
      const removed = scheduler.cancel(o.id || o.taskName || o.target);
      return { ok: true, action: actionName, removed, tasks: scheduler.list(), message: `Cancelled "${removed.taskName}".` };
    }
    throw new Error(`Unsupported schedule operation "${operation}". Valid: add, list, cancel, now.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:scheduleTask" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  REPORT GENERATOR TOOL (generateReport)
// ─────────────────────────────────────────────────────────────
function collectGitCommits(days) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["log", `--since=${days} days ago`, "--pretty=format:%h|%ad|%s", "--date=short", "-n", "100"],
      { cwd: __dirname, timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const gap = /ENOENT/.test(String(err.code || err.message)) ? "git is not installed" : "project folder is not a git repository";
          return resolve({ git: null, gitGap: gap });
        }
        const commits = String(stdout || "").split(/\r?\n/).filter(Boolean).map((l) => {
          const [hash, date, ...rest] = l.split("|");
          return { hash, date, subject: rest.join("|") };
        });
        resolve({ git: { commits } });
      }
    );
  });
}

export async function generateReportTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const actionName = "generateReport";
  try {
    const audience = String(o.audience || "technical").toLowerCase().trim();
    if (!AUDIENCES.includes(audience)) throw new Error(`audience must be one of: ${AUDIENCES.join(", ")}`);
    const format = String(o.format || "both").toLowerCase().trim();
    if (!["markdown", "html", "both"].includes(format)) throw new Error('format must be "markdown", "html" or "both"');
    const days = Math.min(365, Math.max(1, Math.floor(Number(o.days) || 7)));

    let store = { notes: [], tasks: [] };
    let storeGap = null;
    try {
      store = readNotesTasksStore();
    } catch (err) {
      storeGap = err.message;
      logBackendError(actionName, err, { source: "main.js:generateReport" });
    }
    const gitData = await collectGitCommits(days);
    const data = {
      tasks: store.tasks,
      notes: store.notes,
      schedule: scheduler ? scheduler.list() : [],
      errors: errorLogs,
      behavior: behavior ? behavior.getSummary() : null,
      rawNotes: o.notes,
      ...gitData,
    };
    const { markdown, title, metrics } = buildReportMarkdown(data, { audience, title: o.title, days });

    const dir = APP_PATHS.reportsDir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    let base = path.join(dir, `report_${audience}_${stamp}`);
    let seq = 1;
    while (fs.existsSync(`${base}.md`) || fs.existsSync(`${base}.html`)) {
      base = path.join(dir, `report_${audience}_${stamp}_${seq++}`);
    }
    const files = [];
    if (format === "markdown" || format === "both") {
      atomicWriteText(`${base}.md`, markdown);
      files.push(`${base}.md`);
    }
    if (format === "html" || format === "both") {
      atomicWriteText(`${base}.html`, markdownToHtml(markdown, title));
      files.push(`${base}.html`);
    }
    if (o.open === true || o.open === "true") {
      const target = files.find((f) => f.endsWith(".html")) || files[0];
      const openErr = await shell.openPath(target);
      if (openErr) logBackendError(`${actionName} [open]`, new Error(openErr), { source: "main.js:generateReport" });
    }
    return {
      ok: true,
      action: actionName,
      title,
      audience,
      files,
      metrics,
      markdown,
      message: `Report saved: ${files.join(", ")}${storeGap ? ` (tasks data unavailable: ${storeGap})` : ""}`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:generateReport" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  DAILY BRIEFING + WORKFLOW MACROS
// ─────────────────────────────────────────────────────────────
const BRIEFING_TASK_NAME = "Daily Briefing";

async function generateBriefing() {
  let tasks = [];
  try { tasks = readNotesTasksStore().tasks.filter((t) => t.status !== "completed"); } catch (err) { logBackendError("briefing [tasks]", err); }
  const horizon = Date.now() + 24 * 3600 * 1000;
  const upcoming = scheduler ? scheduler.list().filter((s) => s.nextRunAt <= horizon && s.taskName !== BRIEFING_TASK_NAME) : [];
  let headlines = null;
  let headlinesGap = "";
  try {
    const country = await getAppCountry();
    const cc = country.code || "IN";
    headlines = await fetchRss(`https://news.google.com/rss?hl=en-${cc}&gl=${cc}&ceid=${cc}:en`);
  } catch (err) {
    headlinesGap = /fetch failed|ENOTFOUND|network/i.test(err?.message || "") ? "offline" : "feed error";
    logBackendError("briefing [headlines]", err);
  }
  return buildBriefingText({ pendingTasks: tasks, upcoming, headlines, headlinesGap });
}

const dailyCron = (time) => {
  const m = String(time || "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error('time must be 24-hour "HH:MM", e.g. "08:30".');
  return `${Number(m[2])} ${Number(m[1])} * * *`;
};

export async function dailyBriefingTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || "now").toLowerCase().trim();
  const actionName = `dailyBriefing (${operation})`;
  try {
    if (operation === "now") {
      const text = await generateBriefing();
      return { ok: true, action: actionName, briefing: text, message: text };
    }
    if (!scheduler) throw new Error("Scheduler is not running yet.");
    const existing = scheduler.list().find((s) => s.taskName === BRIEFING_TASK_NAME);
    if (operation === "enable") {
      const cron = dailyCron(o.time || "08:00");
      if (existing) scheduler.cancel(existing.id);
      const task = scheduler.add({ taskName: BRIEFING_TASK_NAME, scheduleType: "recurring", cronOrDelay: cron, actionPayload: { type: "briefing" } });
      return { ok: true, action: actionName, task, message: `Daily briefing enabled — next at ${new Date(task.nextRunAt).toLocaleString()}.` };
    }
    if (operation === "disable") {
      if (!existing) return { ok: true, action: actionName, message: "Daily briefing was not enabled." };
      scheduler.cancel(existing.id);
      return { ok: true, action: actionName, message: "Daily briefing disabled." };
    }
    if (operation === "status") {
      return { ok: true, action: actionName, enabled: Boolean(existing), message: existing ? `Enabled — next at ${existing.nextRun}.` : "Not enabled." };
    }
    throw new Error(`Unsupported operation "${operation}". Valid: now, enable, disable, status.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:dailyBriefing" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

async function runMacroByName(name) {
  if (!macroStore) throw new Error("Macro store is not initialised.");
  const macro = macroStore.get(name);
  if (!macro) throw new Error(`Macro "${name}" not found.`);
  const results = [];
  for (const step of macro.steps) {
    const [kind, ...rest] = step.split(":");
    const value = rest.join(":");
    const res = kind === "url"
      ? await executeToolRaw({ tool: "openUrl", url: value })
      : await executeToolRaw({ tool: "open_app", target: value });
    results.push({ step, ok: Boolean(res?.ok), error: res?.ok ? undefined : res?.error });
    await new Promise((r) => setTimeout(r, 700));
  }
  return { macro, results, failed: results.filter((r) => !r.ok).length };
}

export async function workflowMacroTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || "list").toLowerCase().trim();
  const actionName = `workflowMacro (${operation})`;
  try {
    if (!macroStore) throw new Error("Macro store is not initialised.");
    if (operation === "list") {
      const macros = macroStore.list();
      return { ok: true, action: actionName, macros, message: macros.length ? `${macros.length} macro(s): ${macros.map((m) => m.name).join(", ")}` : "No macros saved yet." };
    }
    if (operation === "create") {
      const steps = Array.isArray(o.steps) ? o.steps : String(o.steps || "").split(/\r?\n|;;/).map((s) => s.trim()).filter(Boolean);
      const macro = macroStore.create(o.name, steps);
      return { ok: true, action: actionName, macro, message: `Macro "${macro.name}" saved with ${macro.steps.length} step(s).` };
    }
    if (operation === "run") {
      const out = await runMacroByName(o.name);
      return {
        ok: out.failed === 0,
        action: actionName,
        ...out,
        message: out.failed ? `Macro "${out.macro.name}": ${out.failed}/${out.results.length} step(s) failed.` : `Macro "${out.macro.name}" ran ${out.results.length} step(s).`,
        error: out.failed ? out.results.filter((r) => !r.ok).map((r) => `${r.step}: ${r.error}`).join(" | ") : undefined,
      };
    }
    if (operation === "delete") {
      const removed = macroStore.remove(o.name);
      return { ok: true, action: actionName, message: `Deleted macro "${removed.name}".` };
    }
    if (operation === "schedule") {
      if (!scheduler) throw new Error("Scheduler is not running yet.");
      const macro = macroStore.get(o.name);
      if (!macro) throw new Error(`Macro "${o.name}" not found.`);
      const task = scheduler.add({ taskName: `Macro: ${macro.name}`, scheduleType: "recurring", cronOrDelay: dailyCron(o.time), actionPayload: { type: "macro", macro: macro.name } });
      return { ok: true, action: actionName, task, message: `Macro "${macro.name}" will run daily — next at ${new Date(task.nextRunAt).toLocaleString()}.` };
    }
    throw new Error(`Unsupported operation "${operation}". Valid: list, create, run, delete, schedule.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:workflowMacro" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

let lastQuickBarShownAt = 0;

function showQuickBar() {
  if (!quickBarWin || quickBarWin.isDestroyed()) return;
  lastQuickBarShownAt = Date.now();
  quickBarWin.setAlwaysOnTop(true, "screen-saver");
  quickBarWin.center();
  quickBarWin.show();
  try { app.focus({ steal: true }); } catch { /* ignore */ }
  quickBarWin.focus();
}

function toggleQuickBar() {
  try {
    if (quickBarWin && !quickBarWin.isDestroyed()) {
      if (quickBarWin.isVisible()) { quickBarWin.hide(); return; }
      showQuickBar();
      return;
    }
    quickBarWin = new BrowserWindow({
      width: 640,
      height: 82,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-quickbar.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    quickBarWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    quickBarWin.webContents.on("will-navigate", (evt, url) => {
      if (!isAllowedAppNavigation(url)) evt.preventDefault();
    });
    quickBarWin.loadFile(path.join(__dirname, "public", "quickbar.html")).catch((err) => logBackendError("quickBarWin.loadFile", err));
    quickBarWin.once("ready-to-show", () => showQuickBar());
    quickBarWin.on("blur", () => {
      if (Date.now() - lastQuickBarShownAt < 250) return;
      if (quickBarWin && !quickBarWin.isDestroyed()) quickBarWin.hide();
    });
    quickBarWin.on("closed", () => {
      quickBarWin = null;
    });
  } catch (err) {
    logBackendError("toggleQuickBar", err);
  }
}

export async function organizeFilesTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || "plan").toLowerCase().trim();
  const actionName = `organizeFiles (${operation})`;
  try {
    const dir = resolveTargetDir(o.path, getAllSpecialUserDirs());
    if (operation === "plan") {
      const plan = planOrganize(dir);
      const cats = Object.entries(plan.summary).map(([k, v]) => `${k}: ${v}`).join(", ");
      return { ok: true, action: actionName, ...plan, message: plan.moves.length ? `Plan for ${dir}: ${plan.moves.length} file(s) (${cats}).` : `Nothing to organize in ${dir}.` };
    }
    if (operation === "duplicates") {
      const groups = await findDuplicates(dir);
      return { ok: true, action: actionName, dir, groups, message: groups.length ? `Found ${groups.length} duplicate group(s) in ${dir}.` : `No duplicate files found in ${dir}.` };
    }
    if (operation === "apply") {
      let dupFiles = [];
      if (o.separateDuplicates) {
        const groups = await findDuplicates(dir);
        dupFiles = groups.flatMap((g) => g.duplicates);
      }
      const res = applyOrganize(dir, { moveDuplicates: dupFiles });
      return { ok: res.errors.length === 0, action: actionName, dir, ...res, message: `Organized ${res.moved} file(s) in ${dir}${res.errors.length ? ` (${res.errors.length} error(s))` : ""}.` };
    }
    if (operation === "undo") {
      const res = undoOrganize(dir);
      return { ok: res.errors.length === 0, action: actionName, dir, ...res, message: `Restored ${res.restored} file(s) in ${dir}.` };
    }
    throw new Error(`Unsupported organizeFiles operation "${operation}". Valid: plan, duplicates, apply, undo.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:organizeFiles" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function memoryTool(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const operation = String(o.operation || "list").toLowerCase().trim();
  const actionName = `memory (${operation})`;
  try {
    if (memoryDb) {
      if (operation === "viewer") {
        sendToRenderer("delshiv:open-memory-viewer");
        return { ok: true, action: actionName, items: memoryDb.listFacts(50), message: "Opened Memory Viewer." };
      }
      if (operation === "remember" || operation === "add" || operation === "save") {
        const res = memoryDb.saveOrUpdateFact({
          fact: o.text || o.fact || o.target,
          category: o.category || "general",
          importance: o.importance || 4,
        });
        if (res.skipped) throw new Error("Cannot save empty or sensitive info (passwords/OTPs/keys/cards).");
        return {
          ok: true,
          action: actionName,
          item: res.item,
          message: res.duplicate ? `Already remembered: "${res.item.fact}"` : res.updated ? `Updated memory: "${res.item.fact}"` : `Remembered: "${res.item.fact}"`,
        };
      }
      if (operation === "recall" || operation === "search") {
        const items = memoryDb.retrieveRelevantMemories(o.query || o.text || o.target || "", Number(o.limit) || 6);
        return { ok: true, action: actionName, items, message: items.length ? `Found ${items.length} relevant memory item(s).` : "No matching memories found." };
      }
      if (operation === "list") {
        const items = memoryDb.listFacts(Number(o.limit) || 30);
        return { ok: true, action: actionName, items, message: items.length ? `${items.length} saved memor(ies).` : "No memories saved yet." };
      }
      if (operation === "edit" || operation === "update") {
        const item = memoryDb.updateFact(o.id, { fact: o.text || o.fact, category: o.category, importance: o.importance });
        return { ok: true, action: actionName, item, message: `Updated memory #${item.id}: "${item.fact}"` };
      }
      if (operation === "forget" || operation === "delete") {
        const removed = memoryDb.deleteFact(o.id || o.query || o.text || o.target);
        return { ok: true, action: actionName, removed, message: `Forgot: "${removed.fact}"` };
      }
      throw new Error(`Unsupported memory operation "${operation}". Valid: remember, recall, list, edit, forget, viewer.`);
    }
    if (!memoryStore) throw new Error("Memory store is not initialised.");
    if (operation === "remember" || operation === "add" || operation === "save") {
      const { item, duplicate } = memoryStore.remember(o.text || o.fact || o.target, o.tags);
      return { ok: true, action: actionName, item, duplicate, message: duplicate ? `Already remembered: "${item.text}"` : `Remembered: "${item.text}"` };
    }
    if (operation === "recall" || operation === "search") {
      const items = memoryStore.recall(o.query || o.text || o.target || "", Number(o.limit) || 6);
      return { ok: true, action: actionName, items, message: items.length ? `Found ${items.length} memory item(s).` : "No matching memories found." };
    }
    if (operation === "list") {
      const items = memoryStore.list(Number(o.limit) || 20);
      return { ok: true, action: actionName, items, message: items.length ? `${items.length} saved memor(ies).` : "No memories saved yet." };
    }
    if (operation === "forget" || operation === "delete") {
      const removed = memoryStore.forget(o.id || o.query || o.text || o.target);
      return { ok: true, action: actionName, removed, message: `Forgot: "${removed.text}"` };
    }
    throw new Error(`Unsupported memory operation "${operation}". Valid: remember, recall, list, forget.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:memory" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function systemHealthTool(opts = {}) {
  const op = String(opts.operation || "summary").toLowerCase().trim();
  const actionName = `systemHealth (${op})`;
  try {
    if (op === "summary") {
      const h = await getSystemHealthSummary();
      const bat = h.battery ? ` | Battery ${h.battery.percent}%${h.battery.charging ? " (charging)" : ""}` : "";
      return { ok: true, action: actionName, ...h, message: `CPU ${h.cpuPercent ?? "?"}% | RAM ${h.ram.usedGb}/${h.ram.totalGb} GB (${h.ram.usedPercent}%)${bat}` };
    }
    if (op === "processes") {
      const processes = await listProcesses(opts.limit);
      return { ok: true, action: actionName, processes, message: `Top ${processes.length} process(es) by RAM.` };
    }
    if (op === "kill") {
      const res = await killProcess({ pid: opts.pid, processName: opts.processName || opts.target });
      return { ok: true, action: actionName, ...res, message: `Stopped ${res.killed}.` };
    }
    throw new Error(`Unsupported systemHealth operation "${op}". Valid: summary, processes, kill.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:systemHealth" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function networkToolsTool(opts = {}) {
  const op = String(opts.operation || "ports").toLowerCase().trim();
  const actionName = `networkTools (${op})`;
  try {
    if (op === "ports") {
      const ports = await listListeningPorts(opts.port);
      return { ok: true, action: actionName, ports, message: ports.length ? `${ports.length} listening port(s).` : "No matching listening ports." };
    }
    if (op === "ping") {
      const res = await pingHost(opts.host || opts.target || "8.8.8.8");
      return { ok: true, action: actionName, ...res, message: `${res.host} reachable (avg ${res.avgMs} ms).` };
    }
    if (op === "free_port") {
      const res = await freePort(opts.port || opts.target);
      return { ok: true, action: actionName, ...res, message: `Freed port ${res.port} (stopped PID ${res.killedPids.join(", ")}).` };
    }
    throw new Error(`Unsupported networkTools operation "${op}". Valid: ports, ping, free_port.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:networkTools" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function ruleEngineTool(opts = {}) {
  const op = String(opts.operation || "list").toLowerCase().trim();
  const actionName = `ruleEngine (${op})`;
  try {
    if (!ruleEngine) throw new Error("Rule engine is not initialised.");
    if (op === "list") {
      const rules = ruleEngine.list();
      return { ok: true, action: actionName, rules, message: rules.length ? `${rules.length} rule(s).` : "No automation rules configured." };
    }
    if (op === "add" || op === "create") {
      const rule = ruleEngine.add(opts);
      return { ok: true, action: actionName, rule, rules: ruleEngine.list(), message: `Rule "${rule.name}" added (${rule.trigger}).` };
    }
    if (op === "toggle") {
      const rule = ruleEngine.toggle(opts.id || opts.name || opts.target, opts.enabled);
      return { ok: true, action: actionName, rule, rules: ruleEngine.list(), message: `Rule "${rule.name}" ${rule.enabled ? "enabled" : "disabled"}.` };
    }
    if (op === "delete" || op === "remove") {
      const removed = ruleEngine.remove(opts.id || opts.name || opts.target);
      return { ok: true, action: actionName, removed, rules: ruleEngine.list(), message: `Deleted rule "${removed.name}".` };
    }
    throw new Error(`Unsupported ruleEngine operation "${op}". Valid: list, add, toggle, delete.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:ruleEngine" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

function runCmdExe(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/d", "/s", "/c", String(command || "")], { cwd: __dirname, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || "").trim(), stdout: String(stdout || "") });
      resolve({ ok: true, stdout: String(stdout || "").trim(), message: String(stdout || "").trim() || "CMD executed." });
    });
  });
}

function findFileRecursive(dirs, rawName, maxDepth = 3) {
  const base = path.basename(String(rawName || "").trim());
  if (!base) return null;
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const targetNorm = norm(base);
  const queue = dirs.filter((d) => d && fs.existsSync(d)).map((d) => ({ dir: d, depth: 0 }));
  const seen = new Set();

  while (queue.length) {
    const { dir, depth } = queue.shift();
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile()) {
        if (e.name.toLowerCase() === base.toLowerCase() || norm(e.name) === targetNorm) {
          return path.join(dir, e.name);
        }
      }
    }
    for (const e of entries) {
      if (e.isFile() && norm(e.name).includes(targetNorm)) return path.join(dir, e.name);
      if (e.isDirectory() && depth < maxDepth && !/^(node_modules|\.git|appdata|\$recycle\.bin|windows)$/i.test(e.name)) {
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

async function searchWindowsIndexForFile(rawName) {
  const base = path.basename(String(rawName || "").trim()).replace(/[^a-z0-9 ._\-\u0900-\u097F]/gi, "");
  if (!base || base.length < 2) return null;
  const ps = `
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$rs = $c.Execute("SELECT TOP 1 System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName LIKE '%${base.replace(/'/g, "''")}%'")
if (-not $rs.EOF) { $rs.Fields.Item(0).Value }
$rs.Close(); $c.Close()`;
  const r = await runCommandTool({ command: ps, quiet: true, timeoutMs: 8000 });
  const found = r.ok ? String(r.stdout || "").trim().split(/\r?\n/)[0] : "";
  return found && fs.existsSync(found) ? found : null;
}

export async function openFileOnPcTool(opts = {}) {
  const raw = String(opts.filePath || opts.path || opts.target || "").trim();
  const actionName = `openFile (${raw.slice(0, 50)})`;
  try {
    if (!raw) throw new Error("Provide a file path or filename to open.");
    let targetPath = null;

    // 1. Direct / special folder resolution
    try {
      const direct = resolveFilePath(raw);
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) targetPath = direct;
    } catch { /* ignore */ }

    // 2. Recursive search across all Windows user folders + OneDrive + project dir
    if (!targetPath) {
      const searchDirs = [
        getDesktopDir(),
        getSpecialUserDir("downloads"),
        getSpecialUserDir("documents"),
        getSpecialUserDir("pictures"),
        getSpecialUserDir("videos"),
        getSpecialUserDir("music"),
        path.join(os.homedir(), "OneDrive"),
        os.homedir(),
        __dirname,
      ];
      targetPath = findFileRecursive(searchDirs, raw, 3);
    }

    // 3. Windows 11 Search Index across the entire PC (C:, D:, etc.)
    if (!targetPath) {
      targetPath = await searchWindowsIndexForFile(raw);
    }

    if (!targetPath) throw new Error(`File "${raw}" could not be found anywhere on this PC.`);
    if (isProtectedPath(targetPath)) {
      return { ok: false, action: actionName, blocked: true, error: `Blocked for safety: "${targetPath}" is inside a protected system or application location.` };
    }
    const resolvedRisk = classifyRisk("openFile", { filePath: targetPath });
    if (resolvedRisk.level === "block") {
      return { ok: false, action: actionName, blocked: true, error: `Blocked for safety: ${resolvedRisk.reason}` };
    }
    if (resolvedRisk.level === "confirm" && opts.confirmed !== true && opts.confirmed !== "true") {
      return {
        ok: false,
        needsConfirmation: true,
        action: actionName,
        reason: resolvedRisk.reason,
        detail: resolvedRisk.detail,
        error: `CONFIRMATION_REQUIRED: Ask BOSS in voice/chat: "Kya main ye file open karun — ${path.basename(targetPath)} (${resolvedRisk.reason})?" Call again with confirmed=true ONLY after BOSS confirms Yes/Haan/Kar do.`,
      };
    }

    // Open with Windows default application
    const openErr = await shell.openPath(targetPath);
    if (openErr) {
      const ps = await runCommandTool({ command: `Start-Process -FilePath '${targetPath.replace(/'/g, "''")}'`, quiet: true });
      if (!ps.ok) throw new Error(openErr);
    }
    return { ok: true, action: actionName, filePath: targetPath, message: `Opened "${path.basename(targetPath)}" (${targetPath}).` };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:openFile" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function smartExecuteTool(opts = {}) {
  const goal = String(opts.goal || opts.target || opts.command || "task").trim();
  const kind = String(opts.kind || "auto").toLowerCase().trim();
  const target = String(opts.target || "").trim();
  const command = String(opts.command || "").trim();
  const actionName = `smartExecute (${goal.slice(0, 50)})`;

  if (pinGuard && pinGuard.needsUnlock() && isSensitiveForPin("smartExecute", opts)) {
    return {
      ok: false,
      pinRequired: true,
      action: actionName,
      error: "PIN lock is active. Unlock with pinLock (operation: 'unlock', pin: '...') first.",
    };
  }

  // Safety check up front for file paths so protected paths are rejected immediately without trying 4 fallback strategies
  const candidatePath = target || (kind === "read_file" || kind === "find_file" ? goal : "");
  if (candidatePath && isProtectedPath(candidatePath)) {
    return {
      ok: false,
      action: actionName,
      blocked: true,
      error: `Refusing to access protected system or security file: ${candidatePath}`,
    };
  }

  // Safety check up front for command strings so destructive commands still respect safety-guard
  const riskCommand = command || (kind === "cmd" || kind === "runcommand" || kind === "powershell" ? target : "");
  if (riskCommand) {
    const risk = classifyRisk("runCommand", { command: riskCommand });
    if (risk.level === "block") return { ok: false, action: actionName, blocked: true, error: `Blocked for safety: ${risk.reason}` };
    if (risk.level === "confirm" && opts.confirmed !== true && opts.confirmed !== "true") {
      return {
        ok: false,
        needsConfirmation: true,
        action: actionName,
        reason: risk.reason,
        detail: risk.detail,
        error: `CONFIRMATION_REQUIRED: Ask BOSS in voice/chat: "Kya main ye karun — ${risk.reason} (${risk.detail})?" Call again with confirmed=true ONLY after BOSS confirms Yes/Haan/Kar do.`,
      };
    }
  }

  const userDirs = [getDesktopDir(), getSpecialUserDir("downloads"), getSpecialUserDir("documents"), __dirname];
  const strategies = buildSmartStrategies({
    kind,
    target,
    command,
    handlers: {
      desktopDir: getDesktopDir(),
      openApp: (name) => executeToolRaw({ tool: "open_app", target: name }),
      execAppWithFile: async (exe, fileArg) => {
        const resolved = resolveFilePath(fileArg);
        if (isProtectedPath(resolved)) return { ok: false, blocked: true, error: `Blocked for safety: ${resolved}` };
        return await new Promise((resolve) => {
          let settled = false;
          try {
            const child = spawn(String(exe), [resolved], { detached: true, stdio: "ignore", windowsHide: false });
            child.once("spawn", () => {
              if (settled) return;
              settled = true;
              try { child.unref(); } catch { /* ignore */ }
              resolve({ ok: true, message: `Launched ${path.basename(String(exe))} with ${path.basename(resolved)}` });
            });
            child.once("error", (err) => {
              if (settled) return;
              settled = true;
              resolve({ ok: false, error: err?.message || `Failed to launch ${exe}` });
            });
          } catch (err) {
            if (!settled) resolve({ ok: false, error: err?.message || `Failed to launch ${exe}` });
          }
        });
      },
      openAppWithFile: async (exe, fileArg) => {
        const resolved = resolveFilePath(fileArg);
        if (isProtectedPath(resolved)) return { ok: false, blocked: true, error: `Blocked for safety: ${resolved}` };
        return await runCommandTool({ command: `Start-Process '${exe.replace(/'/g, "''")}' -ArgumentList '"${resolved.replace(/'/g, "''")}"'`, quiet: true });
      },
      openFileDefault: async (fileArg) => {
        const resolved = resolveFilePath(fileArg);
        if (isProtectedPath(resolved)) return { ok: false, blocked: true, error: `Blocked for safety: ${resolved}` };
        if (!fs.existsSync(resolved)) return { ok: false, error: `File not found: ${resolved}` };
        const err = await shell.openPath(resolved);
        return err ? { ok: false, error: err } : { ok: true, message: `Opened ${resolved}` };
      },
      fuzzyOpenFile: async (fileArg) => await openFileOnPcTool({ target: fileArg }),
      runPs: (ps) => runCommandTool({ command: ps, quiet: true }),
      runCmd: (c) => runCmdExe(c),
      readFile: (p) => readFileTool({ filePath: p }),
      findAndRead: async (p, fuzzy) => {
        const hit = fuzzy ? findFileAcrossUserDirs(p, userDirs) : userDirs.map((d) => path.join(d, path.basename(p))).find((f) => fs.existsSync(f));
        if (!hit) return { ok: false, error: `Not found in user folders: ${p}` };
        if (isProtectedPath(hit)) return { ok: false, blocked: true, error: `Blocked for safety: ${hit}` };
        return await readFileTool({ filePath: hit });
      },
      globFind: async (p) => {
        const base = path.basename(p).replace(/[*?]/g, "");
        const g = await globFilesTool({ pattern: `*${base}*`, cwd: __dirname });
        if (!g.ok || !g.files?.length) return { ok: false, error: `No glob matches for ${base}` };
        const firstPath = typeof g.files[0] === "string" ? g.files[0] : g.files[0]?.path;
        if (!firstPath) return { ok: false, error: `Invalid glob result for ${base}` };
        return await readFileTool({ filePath: firstPath });
      },
      webSearch: (q) => webSearchTool({ query: q }),
      newsSearch: async (q) => {
        const { items } = await fetchNewsWithFallback(q);
        return { ok: items.length > 0, items, message: items.slice(0, 5).map((i) => i.title).join(" | ") };
      },
      ddgSearch: (q) => webSearchTool({ query: q }),
      openUrl: (u) => openUrlTool({ url: u }),
    },
  });

  const out = await runWithStrategies(goal, strategies);
  if (!out.ok && !out.stoppedEarly && !out.blocked) {
    logBackendError(actionName, new Error(out.error), { source: "smartExecute" });
  }
  return { ...out, action: actionName };
}

function readGmailApiKey() {
  const fromSecrets = getSecretsStore().getSecret("GMAIL_API_KEY");
  if (fromSecrets) return fromSecrets;
  return String(process.env.GMAIL_API_KEY || "").trim() || readStoredApiKey();
}

async function getValidGmailAccessToken(forceRefresh = false) {
  const sess = currentAuthSession || loadAuthSession();
  if (!sess || !sess.accessToken) {
    throw new Error("Gmail access requires Google Sign-In. Please sign in with Google once to grant Gmail permission.");
  }
  if (!forceRefresh && sess.expiresAt && Date.now() < sess.expiresAt - 60_000) {
    return sess.accessToken;
  }
  if (!sess.refreshToken) {
    if (forceRefresh) {
      throw new Error("Gmail session expired and no refresh token was saved. Please sign out and sign in once with Google (it will stay logged in permanently after this).");
    }
    return sess.accessToken;
  }
  try {
    const tokenBody = new URLSearchParams({
      client_id: getGoogleOAuthClientId(),
      grant_type: "refresh_token",
      refresh_token: sess.refreshToken,
    });
    const clientSecret = getGoogleOAuthClientSecret();
    if (clientSecret) tokenBody.set("client_secret", clientSecret);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (res.ok && data?.access_token) {
      sess.accessToken = data.access_token;
      if (data.refresh_token) sess.refreshToken = data.refresh_token;
      sess.expiresAt = Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000;
      saveAuthSession(sess);
      return sess.accessToken;
    }
    if (forceRefresh) {
      throw new Error(data?.error_description || data?.error || "Refresh token rejected by Google. Please sign in once again.");
    }
  } catch (err) {
    logBackendError("gmail-token-refresh", err);
    if (forceRefresh) throw err;
  }
  return sess.accessToken;
}

export async function readGmailTool(opts = {}) {
  const op = String(opts.operation || (opts.id ? "read" : "list")).toLowerCase().trim();
  const actionName = `readGmail (${op})`;
  const runWithToken = async (accessToken) => {
    const apiKey = readGmailApiKey();
    if (op === "read") {
      let msgId = String(opts.id || opts.messageId || opts.target || "").trim();
      if (!/^[0-9a-f]{10,32}$/i.test(msgId)) {
        const idx = /^\d+$/.test(msgId) ? Math.max(0, Number(msgId) - 1) : 0;
        const q = /unread/i.test(msgId) ? "is:unread" : (/^(|latest|recent|first|last|\d+)$/i.test(msgId) ? "" : msgId);
        const list = await listGmailMessages({ accessToken, apiKey, query: q, maxResults: Math.max(5, idx + 1) });
        if (!list.length) throw new Error(q ? `No emails found matching "${q}".` : "Inbox is empty.");
        msgId = (list[idx] || list[0]).id;
      }
      const mail = await readGmailMessage({ accessToken, apiKey, id: msgId });
      return { ok: true, action: actionName, mail, message: `From: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.body}` };
    }
    const q = op === "unread" ? "is:unread" : String(opts.query || opts.q || "").trim();
    const messages = await listGmailMessages({ accessToken, apiKey, query: q, maxResults: opts.maxResults || opts.limit || 10 });
    return {
      ok: true,
      action: actionName,
      messages,
      message: messages.length ? `Fetched ${messages.length} email(s).` : "No matching emails found.",
    };
  };

  try {
    let accessToken = await getValidGmailAccessToken(false);
    try {
      return await runWithToken(accessToken);
    } catch (err) {
      if (err?.status === 401) {
        accessToken = await getValidGmailAccessToken(true);
        return await runWithToken(accessToken);
      }
      throw err;
    }
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:readGmail" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function clipboardHistoryTool(opts = {}) {
  const op = String(opts.operation || "list").toLowerCase().trim();
  const actionName = `clipboardHistory (${op})`;
  try {
    if (!clipboardHistory) throw new Error("Clipboard history is not initialised.");
    if (op === "list") {
      const items = clipboardHistory.list(opts.limit);
      return { ok: true, action: actionName, items, message: items.length ? `${items.length} recent clipboard item(s).` : "Clipboard history is empty." };
    }
    if (op === "search") {
      const items = clipboardHistory.search(opts.query || opts.target || "", opts.limit);
      return { ok: true, action: actionName, items, message: items.length ? `Found ${items.length} matching clipboard item(s).` : "No matching clipboard items." };
    }
    if (op === "restore" || op === "copy") {
      const item = clipboardHistory.getByIndexOrId(opts.id || opts.index || "1");
      if (!item) throw new Error("Clipboard history item not found.");
      clipboard.writeText(item.text);
      return { ok: true, action: actionName, item, message: `Copied back to clipboard: "${item.text.slice(0, 80)}"` };
    }
    if (op === "clear") {
      clipboardHistory.clear();
      return { ok: true, action: actionName, items: [], message: "Clipboard history cleared." };
    }
    throw new Error(`Unsupported clipboardHistory operation "${op}". Valid: list, search, restore, clear.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:clipboardHistory" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function focusModeTool(opts = {}) {
  const op = String(opts.operation || "status").toLowerCase().trim();
  const actionName = `focusMode (${op})`;
  try {
    if (!focusManager) throw new Error("Focus manager is not initialised.");
    if (op === "start") {
      const res = focusManager.start({ minutes: opts.minutes, label: opts.label || opts.target });
      return { ok: true, action: actionName, ...res };
    }
    if (op === "stop") return { ok: true, action: actionName, ...focusManager.stop() };
    if (op === "status") return { ok: true, action: actionName, ...focusManager.status() };
    throw new Error(`Unsupported focusMode operation "${op}". Valid: start, stop, status.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:focusMode" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function pinLockTool(opts = {}) {
  const op = String(opts.operation || "status").toLowerCase().trim();
  const actionName = `pinLock (${op})`;
  try {
    if (!pinGuard) throw new Error("PIN guard is not initialised.");
    if (op === "status") return { ok: true, action: actionName, ...pinGuard.status() };
    if (op === "set") return { ok: true, action: actionName, ...pinGuard.setPin(opts.pin, opts.currentPin) };
    if (op === "unlock" || op === "verify") {
      const ok = pinGuard.verify(opts.pin);
      if (!ok) throw new Error("Incorrect PIN.");
      return { ok: true, action: actionName, unlocked: true, message: "Unlocked sensitive tools for 5 minutes." };
    }
    if (op === "lock") return { ok: true, action: actionName, ...pinGuard.lockNow() };
    if (op === "disable") return { ok: true, action: actionName, ...pinGuard.disable(opts.pin || opts.currentPin) };
    throw new Error(`Unsupported pinLock operation "${op}". Valid: status, set, unlock, lock, disable.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:pinLock" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function managePluginsTool(opts = {}) {
  const op = String(opts.operation || "list").toLowerCase().trim();
  const actionName = `managePlugins (${op})`;
  try {
    if (!pluginLoader) throw new Error("Plugin loader is not initialised.");
    if (op === "reload") {
      const r = await pluginLoader.reload();
      return { ok: true, action: actionName, ...r, message: `Loaded ${r.loaded.length} plugin(s).` };
    }
    if (op === "list") {
      const plugins = pluginLoader.list();
      return { ok: true, action: actionName, plugins, message: plugins.length ? `${plugins.length} plugin(s) loaded.` : "No plugins found in plugins/ folder." };
    }
    if (op === "run") {
      return await pluginLoader.run(opts.name || opts.target, opts.args || opts);
    }
    throw new Error(`Unsupported managePlugins operation "${op}". Valid: list, reload, run.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:managePlugins" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

export async function manageTasksTool(opts = {}) {
  const operation = String(opts.operation || opts.op || "list").toLowerCase().trim();
  const actionName = `manageTasks (${operation})`;
  try {
    const store = readNotesTasksStore();

    if (operation === "list" || operation === "get") {
      return { ok: true, action: actionName, tasks: store.tasks };
    }

    if (operation === "add" || operation === "create") {
      const title = String(opts.title || opts.text || opts.target || "").trim();
      if (!title) {
        throw new Error("Cannot create an empty task. Provide a task 'title'.");
      }
      const task = {
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title,
        status: "pending",
        priority: String(opts.priority || "normal"),
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      store.tasks.unshift(task);
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, task, tasks: store.tasks, message: `Task added: "${title}"` };
    }

    if (operation === "complete" || operation === "done" || operation === "toggle") {
      const id = String(opts.id || opts.target || "").trim();
      if (!id) {
        throw new Error("Task 'id' or title is required to complete a task.");
      }
      const task = store.tasks.find(
        (t) => t.id === id || t.title.toLowerCase().includes(id.toLowerCase())
      );
      if (!task) {
        throw new Error(`Task "${id}" not found.`);
      }
      task.status = operation === "toggle" && task.status === "completed" ? "pending" : "completed";
      task.completedAt = task.status === "completed" ? new Date().toISOString() : null;
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, task, tasks: store.tasks, message: `Task "${task.title}" marked ${task.status}.` };
    }

    if (operation === "delete" || operation === "remove") {
      const id = String(opts.id || opts.target || "").trim();
      if (!id) {
        throw new Error("Task 'id' or title is required for delete.");
      }
      const idx = store.tasks.findIndex(
        (t) => t.id === id || t.title.toLowerCase().includes(id.toLowerCase())
      );
      if (idx === -1) {
        throw new Error(`Task "${id}" not found.`);
      }
      const [removed] = store.tasks.splice(idx, 1);
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, removed, tasks: store.tasks, message: `Deleted task "${removed.title}"` };
    }

    if (operation === "clear") {
      store.tasks = [];
      writeNotesTasksStore(store);
      return { ok: true, action: actionName, tasks: [], message: "Cleared all tasks." };
    }

    throw new Error(`Unsupported tasks operation: "${operation}". Valid operations: list, add, complete, toggle, delete, clear.`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:manageTasks" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// ─────────────────────────────────────────────────────────────
//  5. SYSTEM CONTROL & UNIFIED DESKTOP TOOL DISPATCHER
// ─────────────────────────────────────────────────────────────
export async function systemControlTool(opts = {}) {
  const commandType = String(opts.operation || opts.commandType || opts.target || "").toLowerCase().trim();
  const actionName = `systemControl (${commandType || "unknown"})`;

  try {
    if (commandType === "volume_up") {
      const res = await runCommandTool({
        command: "$w = New-Object -ComObject WScript.Shell; 1..5 | ForEach-Object { $w.SendKeys([char]175) }",
      });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "System volume increased." };
    }
    if (commandType === "volume_down") {
      const res = await runCommandTool({
        command: "$w = New-Object -ComObject WScript.Shell; 1..5 | ForEach-Object { $w.SendKeys([char]174) }",
      });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "System volume decreased." };
    }
    if (commandType === "volume_mute") {
      const res = await runCommandTool({
        command: "$w = New-Object -ComObject WScript.Shell; $w.SendKeys([char]173)",
      });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "System audio mute toggled." };
    }
    if (commandType === "take_screenshot") {
      const fileName = `Delshiv_Screenshot_${Date.now()}.png`;
      const outPath = path.join(getDesktopDir(), fileName);
      const psPath = outPath.replace(/'/g, "''");
      const psScript = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DelshivDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction SilentlyContinue; try { [DelshivDpi]::SetProcessDPIAware() | Out-Null } catch {}; Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); try { $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); $bmp.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $g.Dispose(); $bmp.Dispose() }; Write-Output '${psPath}'`;
      const res = await runCommandTool({ command: psScript, quiet: true });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, filePath: outPath, message: `Screenshot saved to Desktop: ${fileName}` };
    }
    if (commandType === "lock_pc") {
      const res = await runCommandTool({ command: "rundll32.exe user32.dll,LockWorkStation" });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "Workstation locked." };
    }
    if (commandType === "shutdown_pc") {
      const res = await runCommandTool({
        command: 'shutdown /s /t 60 /c "Delshiv AI scheduled system shutdown in 60 seconds (run shutdown /a to cancel)."',
      });
      if (!res.ok) throw new Error(res.error);
      return {
        ok: true,
        action: actionName,
        message: "PC shutdown scheduled in 60 seconds. Say 'cancel shutdown' to abort.",
      };
    }
    if (commandType === "cancel_shutdown") {
      const res = await runCommandTool({ command: "shutdown /a" });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "Scheduled PC shutdown cancelled." };
    }
    if (commandType === "restart_pc") {
      const res = await runCommandTool({
        command: 'shutdown /r /t 60 /c "Delshiv AI scheduled system restart in 60 seconds."',
      });
      if (!res.ok) throw new Error(res.error);
      return {
        ok: true,
        action: actionName,
        message: "PC restart scheduled in 60 seconds. Say 'cancel shutdown' to abort.",
      };
    }
    if (commandType === "minimize_windows" || commandType === "show_desktop") {
      const res = await runCommandTool({
        command: "(New-Object -ComObject Shell.Application).MinimizeAll()",
      });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "Minimized all windows to show Desktop." };
    }
    if (commandType === "restore_windows" || commandType === "unminimize_windows") {
      const res = await runCommandTool({
        command: "(New-Object -ComObject Shell.Application).UndoMinimizeAll()",
      });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "Restored minimized windows." };
    }
    if (commandType === "bluetooth_on" || commandType === "bluetooth_off") {
      const r = await setRadioState("Bluetooth", commandType === "bluetooth_on", (u) => shell.openExternal(u));
      return { ok: true, action: actionName, message: r.message };
    }
    if (commandType === "wifi_on" || commandType === "wifi_off") {
      const r = await setRadioState("WiFi", commandType === "wifi_on", (u) => shell.openExternal(u));
      return { ok: true, action: actionName, message: r.message };
    }
    if (commandType === "brightness_up") {
      const r = await setBrightness(15, true);
      return { ok: true, action: actionName, ...r };
    }
    if (commandType === "brightness_down") {
      const r = await setBrightness(-15, true);
      return { ok: true, action: actionName, ...r };
    }
    if (commandType === "set_brightness") {
      const lvl = opts.value ?? opts.level ?? opts.target;
      if (lvl === undefined || lvl === "") throw new Error("Provide brightness value (0-100).");
      const r = await setBrightness(Number(lvl), false);
      return { ok: true, action: actionName, ...r };
    }
    if (commandType === "dark_mode_on" || commandType === "dark_mode_off") {
      const r = await setDarkMode(commandType === "dark_mode_on");
      return { ok: true, action: actionName, ...r };
    }
    if (commandType === "power_saver" || commandType === "power_balanced" || commandType === "power_high") {
      const map = { power_saver: "power_saver", power_balanced: "balanced", power_high: "high_performance" };
      const r = await setPowerPlan(map[commandType]);
      return { ok: true, action: actionName, ...r };
    }
    if (commandType === "sleep_pc") {
      const res = await runCommandTool({ command: "rundll32.exe powrprof.dll,SetSuspendState 0,1,0" });
      if (!res.ok) throw new Error(res.error);
      return { ok: true, action: actionName, message: "PC entering sleep mode." };
    }
    if (commandType === "open_settings") {
      const page = String(opts.page || opts.target || "main").toLowerCase().trim();
      const uri = SETTINGS_URIS[page] || SETTINGS_URIS.main;
      await shell.openExternal(uri);
      return { ok: true, action: actionName, uri, message: `Opened Windows Settings (${page}).` };
    }

    throw new Error(`Unsupported or unimplemented system control command: "${commandType}"`);
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:systemControl" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

const KNOWN_WINDOWS_APPS = {
  notepad: "Start-Process notepad.exe",
  calculator: "Start-Process calc.exe",
  calc: "Start-Process calc.exe",
  paint: "Start-Process mspaint.exe",
  mspaint: "Start-Process mspaint.exe",
  cmd: "Start-Process cmd.exe",
  terminal: "Start-Process cmd.exe",
  powershell: "Start-Process powershell.exe",
  explorer: "Start-Process explorer.exe",
  "file explorer": "Start-Process explorer.exe",
  desktop: () => `Start-Process explorer.exe -ArgumentList '"${getDesktopDir().replace(/'/g, "''")}"'`,
  "task manager": "Start-Process taskmgr.exe",
  taskmgr: "Start-Process taskmgr.exe",
  "control panel": "Start-Process control.exe",
  settings: "Start-Process ms-settings:",
  camera: "Start-Process microsoft.windows.camera:",
  chrome: "Start-Process chrome",
  "google chrome": "Start-Process chrome",
  edge: "Start-Process msedge",
  "microsoft edge": "Start-Process msedge",
  vscode: "Start-Process code",
  "vs code": "Start-Process code",
  whatsapp: "Start-Process whatsapp:",
  "whatsapp desktop": "Start-Process whatsapp:",
  spotify: "Start-Process spotify:",
  telegram: "Start-Process tg:",
  discord: "Start-Process discord:",
  store: "Start-Process ms-windows-store:",
  "microsoft store": "Start-Process ms-windows-store:",
  photos: "Start-Process ms-photos:",
  clock: "Start-Process ms-clock:",
  mail: "Start-Process outlookmail:",
  word: "Start-Process winword",
  excel: "Start-Process excel",
  powerpoint: "Start-Process powerpnt",
  outlook: "Start-Process outlook",
};

export async function captureScreenTool() {
  const actionName = "readScreen (Capture Screen)";
  try {
    if (!desktopCapturer || typeof desktopCapturer.getSources !== "function") {
      throw new Error("Electron desktopCapturer is unavailable.");
    }
    const primarySize =
      screen && typeof screen.getPrimaryDisplay === "function"
        ? screen.getPrimaryDisplay().size
        : { width: 1280, height: 720 };
    const thumbW = Math.min(1600, Math.max(1024, primarySize.width || 1280));
    const thumbH = Math.min(900, Math.max(576, primarySize.height || 720));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
    if (!sources || !sources.length) {
      throw new Error("No display screen source found for capture.");
    }
    const src = sources[0];
    const jpegBuf = src.thumbnail.toJPEG(70);
    if (!jpegBuf || !jpegBuf.length) {
      throw new Error("Captured screen thumbnail was empty.");
    }
    return {
      ok: true,
      action: actionName,
      screenName: src.name || "Primary Display",
      mimeType: "image/jpeg",
      imageBase64: jpegBuf.toString("base64"),
      bytes: jpegBuf.length,
      message: `Captured screen (${src.name || "Primary Display"}, ${jpegBuf.length} bytes).`,
    };
  } catch (err) {
    const logEntry = logBackendError(actionName, err, { source: "main.js:readScreen" });
    return { ok: false, action: actionName, error: err?.message || String(err), logEntry };
  }
}

// Every tool call passes through here: risk check → (optional) user confirmation → execute → activity log.
async function handleToolOrCommandExecution(payload = {}) {
  const tool = String(payload.tool || payload.action || "execute_command").trim();
  const userCommand = String(payload.rawText || payload.command || payload.query || payload.target || payload.filePath || "").trim();
  if (userCommand) errorLogger.setLastUserCommand(userCommand);
  const started = Date.now();
  let decision = "auto";
  try {
    if (pinGuard && pinGuard.needsUnlock() && isSensitiveForPin(tool, payload)) {
      const msg = "PIN lock is active. Unlock with pinLock (operation: 'unlock', pin: '...') first.";
      activityLog?.record({ tool, payload, decision: "pin-locked", ok: false, error: msg, ms: Date.now() - started });
      return { ok: false, pinRequired: true, action: tool, error: msg };
    }
    const risk = classifyRisk(tool, payload);
    if (risk.level === "block") {
      const err = new Error(`Blocked for safety: ${risk.reason} (${risk.detail}).`);
      const logEntry = logBackendError(`safety-guard (${tool})`, err, { source: "safety-guard", userCommand });
      activityLog?.record({ tool, payload, decision: "blocked", ok: false, error: err.message, ms: 0 });
      return { ok: false, action: tool, error: err.message, blocked: true, logEntry };
    }
    if (risk.level === "confirm") {
      if (payload.confirmed === true || payload.confirmed === "true") {
        decision = "conversational-confirmed";
      } else {
        activityLog?.record({ tool, payload, decision: "needs-confirmation", ok: false, error: "Waiting for voice/chat confirmation", ms: Date.now() - started });
        return {
          ok: false,
          needsConfirmation: true,
          action: tool,
          reason: risk.reason,
          detail: risk.detail,
          error: `CONFIRMATION_REQUIRED: Ask BOSS in voice/chat: "Kya main ye karun — ${risk.reason} (${risk.detail})?" Call this tool again with confirmed=true ONLY after BOSS says Yes/Haan/Kar do.`,
        };
      }
    }
    const wrappedExecute = errorLogger.wrapToolCall(
      tool,
      async () => await executeToolRaw(payload),
      { getUserCommand: () => userCommand }
    );
    const res = await wrappedExecute();
    activityLog?.record({ tool, payload, decision, ok: Boolean(res?.ok), error: res?.ok ? undefined : res?.error, ms: Date.now() - started });
    return res;
  } catch (err) {
    activityLog?.record({ tool, payload, decision, ok: false, error: err?.message || String(err), ms: Date.now() - started });
    const logEntry = logBackendError(`handleToolOrCommandExecution (${tool})`, err, {
      userCommand,
      _fromErrorLogger: Boolean(err?._alreadyLoggedByErrorLogger),
    });
    return { ok: false, action: tool, error: err?.message || String(err), logEntry };
  }
}

async function executeToolRaw(payload = {}) {
  const tool = String(payload.tool || payload.action || "execute_command").trim();
  const target = String(payload.target || payload.command || payload.query || payload.folderName || "").trim();
  const rawText = String(payload.rawText || target || tool).trim();
  const actionLabel = target
    ? `${tool} (${target.slice(0, 60)})`
    : `${tool}${rawText && rawText !== tool ? ` [${rawText.slice(0, 50)}]` : ""}`;

  try {
    if (behavior) behavior.recordTool(tool);
    if (tool === "readScreen" || tool === "read_screen" || tool === "captureScreen" || tool === "capture_screen") {
      return await captureScreenTool();
    }
    if (tool === "runCommand" || tool === "run_command" || tool === "powershell") {
      return await runCommandTool({ ...payload, command: payload.command || target });
    }
    if (tool === "createFolder" || tool === "create_folder") {
      return await createFolderTool({ ...payload, folderName: payload.folderName || target, rawText });
    }
    if (
      tool === "deletePath" ||
      tool === "delete_path" ||
      tool === "deleteFolder" ||
      tool === "delete_folder" ||
      tool === "deleteFile" ||
      tool === "delete_file"
    ) {
      return await deletePathTool({ ...payload, targetPath: payload.targetPath || payload.path || payload.filePath || payload.folderName || target });
    }
    if (tool === "readFile" || tool === "read_file") {
      return await readFileTool({ ...payload, filePath: payload.filePath || target });
    }
    if (tool === "writeFile" || tool === "write_file") {
      return await writeFileTool({ ...payload, filePath: payload.filePath || target });
    }
    if (tool === "editFile" || tool === "edit_file") {
      return await editFileTool({ ...payload, filePath: payload.filePath || target });
    }
    if (tool === "globFiles" || tool === "glob_files") {
      return await globFilesTool({ ...payload, pattern: payload.pattern || target });
    }
    if (tool === "webSearch" || tool === "web_search") {
      const tKey = readStoredTavilyKey();
      const q = payload.query || target;
      if (tKey) {
        try {
          return { ...(await tavilyWebSearch({ query: q, maxResults: payload.maxResults || 5, apiKey: tKey })), action: `webSearch (${q.slice(0, 50)})` };
        } catch (err) {
          logBackendError("webSearch [Tavily fallback to DDG]", err);
        }
      }
      return await webSearchTool({ ...payload, query: q });
    }
    if (tool === "fetch_page" || tool === "fetchPage") {
      return { ...(await fetchPageWithCheerio({ url: payload.url || target, maxChars: payload.maxChars || 6000 })), action: `fetch_page (${String(payload.url || target).slice(0, 50)})` };
    }
    if (tool === "youtube_transcript" || tool === "youtubeTranscript") {
      return { ...(await fetchYoutubeTranscript({ url: payload.url || target, apiKey: readStoredApiKey(), onError: (m, e) => logBackendError(`youtube_transcript [${m}]`, e) })), action: `youtube_transcript (${String(payload.url || target).slice(0, 50)})` };
    }
    if (tool === "openUrl" || tool === "open_url" || tool === "open_website") {
      return await openUrlTool({ ...payload, url: payload.url || target });
    }
    if (tool === "manageNotes" || tool === "manage_notes") {
      return await manageNotesTool(payload);
    }
    if (tool === "manageTasks" || tool === "manage_tasks") {
      return await manageTasksTool(payload);
    }
    if (tool === "dailyBriefing" || tool === "daily_briefing") {
      return await dailyBriefingTool(payload);
    }
    if (tool === "workflowMacro" || tool === "workflow_macro") {
      return await workflowMacroTool(payload);
    }
    if (tool === "organizeFiles" || tool === "organize_files") {
      return await organizeFilesTool(payload);
    }
    if (tool === "searchPastChats" || tool === "search_past_chats") {
      const items = memoryDb ? memoryDb.searchPastChats(payload.query || target || "", { limit: payload.limit || 10 }) : [];
      return { ok: true, action: "searchPastChats", items, message: items.length ? `Found ${items.length} message(s) from past chats.` : "No past chats found." };
    }
    if (tool === "memory" || tool === "longTermMemory") {
      return await memoryTool(payload);
    }
    if (tool === "queryDocument" || tool === "query_document") {
      const out = await queryDocument({
        filePath: payload.filePath || payload.path || target,
        question: payload.question || payload.query || "",
        apiKey: readStoredApiKey(),
        resolvePath: resolveFilePath,
        onModelError: (m, e) => logBackendError(`queryDocument [${m}]`, e),
      });
      return { ok: true, action: `queryDocument (${path.basename(out.file)})`, ...out, message: out.answer };
    }
    if (tool === "manageWindows" || tool === "manage_windows") {
      return await manageWindows({ operation: payload.operation || "list", target: payload.target || payload.window || target });
    }
    if (tool === "readWebPage" || tool === "read_web_page") {
      return { ...(await readWebPage({ url: payload.url || target, question: payload.question || payload.query || "", apiKey: readStoredApiKey(), onError: (m, e) => logBackendError(`readWebPage [${m}]`, e) })), action: `readWebPage (${String(payload.url || target).slice(0, 50)})` };
    }
    if (tool === "clipboardHistory" || tool === "clipboard_history") {
      return await clipboardHistoryTool(payload);
    }
    if (tool === "focusMode" || tool === "focus_mode") {
      return await focusModeTool(payload);
    }
    if (tool === "mediaControl" || tool === "media_control") {
      const q = String(payload.query || payload.song || payload.video || "").trim();
      const op = String(payload.operation || payload.action || (q ? "play_youtube" : target) || "play_pause").trim();
      if (q || /^(?:play_youtube|youtube|play_song|play_video)$/i.test(op)) {
        const res = await playYouTube(q || target, (url) => shell.openExternal(url));
        return { action: `mediaControl (play_youtube: ${q || target})`, ...res };
      }
      const res = await sendMediaKey(op);
      return { action: actionLabel, ...res };
    }
    if (tool === "pinLock" || tool === "pin_lock") {
      return await pinLockTool(payload);
    }
    if (tool === "managePlugins" || tool === "manage_plugins") {
      return await managePluginsTool(payload);
    }
    if (tool === "cleanJunk" || tool === "clean_junk") {
      const op = String(payload.operation || "scan").toLowerCase().trim();
      const res = op === "clean"
        ? await cleanJunkFiles({ includeRecycleBin: payload.includeRecycleBin !== false, includeWindowsUpdate: payload.includeWindowsUpdate === true })
        : await scanJunkFiles({ includeWindowsUpdate: payload.includeWindowsUpdate === true });
      return { action: `cleanJunk (${op})`, ...res };
    }
    if (tool === "readGmail" || tool === "read_gmail" || tool === "gmail") {
      return await readGmailTool(payload);
    }
    if (tool === "openFile" || tool === "open_file") {
      return await openFileOnPcTool(payload);
    }
    if (tool === "smartExecute" || tool === "smart_execute") {
      return await smartExecuteTool(payload);
    }
    if (tool === "systemHealth" || tool === "system_health") {
      return await systemHealthTool(payload);
    }
    if (tool === "networkTools" || tool === "network_tools") {
      return await networkToolsTool(payload);
    }
    if (tool === "ruleEngine" || tool === "rule_engine") {
      return await ruleEngineTool(payload);
    }
    if (tool === "extractTextFromImage" || tool === "ocr") {
      return await extractTextFromImage({ filePath: payload.filePath || payload.path || target, resolvePath: resolveFilePath });
    }
    if (tool === "automateInput" || tool === "automate_input") {
      return await automateInput(payload);
    }
    if (tool === "searchCode" || tool === "search_code") {
      const q = String(payload.query || payload.target || "").trim();
      const root = payload.path ? path.resolve(String(payload.path)) : __dirname;
      if (isProtectedPath(root)) {
        return { ok: false, action: `searchCode (${q.slice(0, 50)})`, blocked: true, error: `Refusing to index protected location: ${root}` };
      }
      const out = await searchCode(root, q, { limit: Number(payload.limit) || 6 });
      return {
        ok: true,
        action: `searchCode (${q.slice(0, 50)})`,
        ...out,
        message: out.results.length ? `${out.results.length} match(es) in ${out.indexedFiles} files.` : `No matches for "${q}" in ${out.indexedFiles} indexed files. Try other keywords (function names, error text).`,
      };
    }
    if (tool === "getToolActivity" || tool === "get_tool_activity") {
      const items = activityLog ? activityLog.recent(payload.limit) : [];
      return { ok: true, action: "getToolActivity", items, message: items.length ? `${items.length} recent tool action(s).` : "No tool activity recorded yet." };
    }
    if (tool === "generateReport" || tool === "generate_report") {
      return await generateReportTool(payload);
    }
    if (tool === "scheduleTask" || tool === "schedule_task") {
      return await scheduleTaskTool(payload);
    }
    if (tool === "systemControl" || tool === "system_control") {
      return await systemControlTool({ ...payload, operation: payload.operation || target });
    }

    if (tool === "youtube_search" || tool === "play_media") {
      if (!target) {
        throw new Error(`Missing search query for ${tool}`);
      }
      const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(target)}`;
      await shell.openExternal(ytUrl);
      return { ok: true, action: actionLabel, message: `Opened YouTube for: ${target}` };
    }

    if (tool === "open_app" || tool === "launch_app") {
      const key = target.toLowerCase().trim();
      if (!key) {
        throw new Error("Application name is empty.");
      }
      if (KNOWN_WEB_TARGETS[key] || /^[a-z0-9-]+\.(com|in|org|net|io|ai)$/i.test(key)) {
        return await openUrlTool({ url: KNOWN_WEB_TARGETS[key] || key });
      }
      const rawWinCmd = KNOWN_WINDOWS_APPS[key];
      const winCmd = typeof rawWinCmd === "function" ? rawWinCmd() : rawWinCmd;
      if (winCmd) {
        const cmdRes = await runCommandTool({ command: winCmd, quiet: true });
        if (!cmdRes.ok) {
          return cmdRes;
        }
        return { ok: true, action: actionLabel, message: `Launched application: ${target}` };
      }
      // Dynamic fallback for any installed Windows / Microsoft Store app via Start Menu (Get-StartApps)
      const safeApp = key.replace(/[^a-z0-9 .\-_]/gi, "");
      if (!safeApp) throw new Error(`Invalid application name: "${target}".`);
      const startAppsPs = `$a = Get-StartApps | Where-Object { $_.Name -like '*${safeApp}*' } | Select-Object -First 1; if (-not $a) { throw 'Application not found in Start Menu: ${safeApp}' }; Start-Process "shell:AppsFolder\\$($a.AppID)"; Write-Output $a.Name`;
      const dynRes = await runCommandTool({ command: startAppsPs });
      if (!dynRes.ok) {
        return dynRes;
      }
      return { ok: true, action: actionLabel, message: `Launched application: ${dynRes.stdout || target}` };
    }

    throw new Error(
      `Tool or command "${actionLabel}" is unsupported or unimplemented in the desktop backend (command: "${rawText}").`
    );
  } catch (err) {
    const entry = logBackendError(actionLabel, err, { source: "main.js:tool-executor" });
    return { ok: false, action: actionLabel, error: err?.message || String(err), logEntry: entry };
  }
}

// ─────────────────────────────────────────────────────────────
//  6. GOOGLE OAUTH 2.0 LOGIN & SUBSCRIBER WHITELIST VERIFICATION
// ─────────────────────────────────────────────────────────────
const GOOGLE_OAUTH_CLIENT_ID =
  "120849505498-ifn3t2rqv2g080fli8vl5umb51esnlgl.apps.googleusercontent.com";
const GOOGLE_CLIENT_ID_RE = /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;
const DEFAULT_WHITELIST_EMAILS = [];

let currentAuthSession = null;
let activeOAuthAbort = null;

export function getGoogleOAuthClientId() {
  const envClientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  if (envClientId) return envClientId;
  return GOOGLE_OAUTH_CLIENT_ID.trim();
}

export function getGoogleOAuthClientSecret() {
  const fromSecrets = getSecretsStore().getSecret("GOOGLE_OAUTH_CLIENT_SECRET");
  if (fromSecrets) return fromSecrets;
  return String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
}

function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

async function exchangeGoogleAuthCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const errCode = data.error || `HTTP_${res.status}`;
    const errDesc = data.error_description || "Token exchange failed.";
    if (String(errDesc).toLowerCase().includes("client_secret")) {
      throw new Error(
        `Google token exchange requires your Desktop app Client Secret (${errCode}: ${errDesc}). Add GOOGLE_OAUTH_CLIENT_SECRET=<your-secret> to .env.`
      );
    }
    throw new Error(`Google token exchange failed (${errCode}): ${errDesc}`);
  }
  return data;
}

function getAuthSessionFilePath() {
  return APP_PATHS.authSession;
}

export function readAllowedUsers() {
  const whitelistPath = path.join(__dirname, "allowed_users.json");
  try {
    if (!fs.existsSync(whitelistPath)) {
      return DEFAULT_WHITELIST_EMAILS.map((e) => e.toLowerCase());
    }
    const raw = fs.readFileSync(whitelistPath, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.allowed_emails)
        ? parsed.allowed_emails
        : DEFAULT_WHITELIST_EMAILS;
    return list.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  } catch (err) {
    logBackendError("readAllowedUsers (allowed_users.json)", err, { source: "main.js:auth" });
    return DEFAULT_WHITELIST_EMAILS.map((e) => e.toLowerCase());
  }
}

export function isEmailWhitelisted(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return false;
  const allowed = readAllowedUsers();
  return allowed.includes(clean);
}

function sanitizeUserForRenderer(user) {
  if (!user || typeof user !== "object") return null;
  return {
    sub: String(user.sub || ""),
    name: String(user.name || ""),
    email: String(user.email || ""),
    avatar: String(user.avatar || ""),
    whitelisted: Boolean(user.whitelisted),
    loggedInAt: user.loggedInAt || null,
    expiresAt: user.expiresAt || null,
  };
}

function encryptTokenValue(val) {
  const s = String(val || "");
  if (!s) return "";
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable()) {
      return { enc: true, data: safeStorage.encryptString(s).toString("base64") };
    }
  } catch (err) {
    logBackendError("encryptTokenValue", err, { source: "main.js:auth" });
  }
  return s;
}

function decryptTokenValue(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && val.enc && val.data) {
    try {
      if (safeStorage && typeof safeStorage.decryptString === "function") {
        return safeStorage.decryptString(Buffer.from(String(val.data), "base64"));
      }
    } catch (err) {
      logBackendError("decryptTokenValue", err, { source: "main.js:auth" });
    }
  }
  return "";
}

function loadAuthSession() {
  try {
    const file = getAuthSessionFilePath();
    if (!fs.existsSync(file)) {
      const allowed = readAllowedUsers();
      if (Array.isArray(allowed) && allowed.length > 0) {
        const defaultUser = {
          name: "Mr.Shivam",
          email: allowed[0],
          nickname: "CHIEF",
          avatar: "",
          authenticated: true,
        };
        saveAuthSession(defaultUser);
        return currentAuthSession;
      }
      return null;
    }
    const rawData = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!rawData || typeof rawData !== "object") return null;
    const data = {
      ...rawData,
      accessToken: decryptTokenValue(rawData.accessToken),
      refreshToken: decryptTokenValue(rawData.refreshToken),
    };
    if (data.email && isEmailWhitelisted(data.email)) {
      currentAuthSession = data;
      return currentAuthSession;
    }
    if (data.email && !isEmailWhitelisted(data.email)) {
      clearAuthSession();
    }
  } catch (err) {
    logBackendError("loadAuthSession", err, { source: "main.js:auth" });
  }
  return null;
}

function saveAuthSession(userObj) {
  currentAuthSession = userObj;
  try {
    const file = getAuthSessionFilePath();
    const persisted = {
      ...userObj,
      accessToken: encryptTokenValue(userObj?.accessToken),
      refreshToken: encryptTokenValue(userObj?.refreshToken),
    };
    atomicWriteJson(file, persisted);
  } catch (err) {
    logBackendError("saveAuthSession", err, { source: "main.js:auth" });
  }
}

function clearAuthSession() {
  currentAuthSession = null;
  try {
    const file = getAuthSessionFilePath();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    logBackendError("clearAuthSession", err, { source: "main.js:auth" });
  }
}

async function fetchGoogleUserProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google UserInfo HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const info = await res.json();
  if (!info || !info.email) {
    throw new Error("Google profile response did not include an email address.");
  }
  if (info.email_verified !== true) {
    throw new Error("Google account email is not verified.");
  }
  return {
    sub: String(info.sub || ""),
    name: String(info.name || info.given_name || info.email.split("@")[0]),
    email: String(info.email).trim(),
    avatar: String(info.picture || ""),
  };
}

async function performGoogleOAuthLogin() {
  if (typeof activeOAuthAbort === "function") {
    activeOAuthAbort();
    activeOAuthAbort = null;
  }

  const clientId = getGoogleOAuthClientId();
  if (!GOOGLE_CLIENT_ID_RE.test(clientId)) {
    const err = new Error(
      `Invalid Google OAuth Client ID format ("${clientId || "empty"}"). Expected *.apps.googleusercontent.com.`
    );
    logBackendError("google-login (Invalid Client ID)", err, { source: "main.js:auth" });
    return { ok: false, error: err.message };
  }

  const expectedState = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const clientSecret = getGoogleOAuthClientSecret();

  return new Promise((resolve) => {
    let settled = false;
    let server = null;
    let timeoutTimer = null;
    let redirectUri = "";

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (server) {
        try {
          server.close();
        } catch { }
        server = null;
      }
      if (activeOAuthAbort === abortPending) {
        activeOAuthAbort = null;
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      } catch { }
      resolve(result);
    };

    const abortPending = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, cancelled: true, error: "Previous Google sign-in attempt was superseded." });
    };
    activeOAuthAbort = abortPending;

    const handleOAuthCode = async (code) => {
      try {
        if (!code) {
          throw new Error("Google OAuth did not return an authorization code.");
        }
        const tokenData = await exchangeGoogleAuthCode({
          code,
          codeVerifier,
          redirectUri,
          clientId,
          clientSecret,
        });
        const profile = await fetchGoogleUserProfile(tokenData.access_token);

        if (!isEmailWhitelisted(profile.email)) {
          const msg = "Subscription required. Contact administrator.";
          logBackendError(
            `google-login (Whitelist Rejected: ${profile.email})`,
            new Error(`${msg} (Attempted user: ${profile.email})`),
            { source: "main.js:whitelist" }
          );
          clearAuthSession();
          finish({
            ok: false,
            unauthorized: true,
            email: profile.email,
            name: profile.name,
            avatar: profile.avatar,
            error: msg,
          });
          return;
        }

        const sameUser =
          currentAuthSession &&
          String(currentAuthSession.email || "").trim().toLowerCase() === profile.email.toLowerCase();
        const userSession = {
          ...profile,
          accessToken: String(tokenData.access_token || ""),
          refreshToken: String(tokenData.refresh_token || (sameUser ? currentAuthSession.refreshToken : "") || ""),
          expiresAt: Date.now() + Math.max(60, Number(tokenData.expires_in || 3600)) * 1000,
          whitelisted: true,
          loggedInAt: new Date().toISOString(),
        };
        saveAuthSession(userSession);
        finish({ ok: true, user: sanitizeUserForRenderer(userSession) });
      } catch (err) {
        logBackendError("google-login (Token Exchange / Profile)", err, { source: "main.js:auth" });
        finish({ ok: false, error: err?.message || String(err) });
      }
    };

    let callbackHandled = false;
    server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (reqUrl.pathname === "/oauth2callback" || reqUrl.pathname === "/") {
          if (callbackHandled) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body style='background:#04080e;color:#94a3b8;font-family:sans-serif;display:grid;place-items:center;height:100vh'><div>OAuth callback already handled. You can close this tab.</div></body></html>");
            return;
          }
          callbackHandled = true;
          const errParam = reqUrl.searchParams.get("error");
          const errDesc = reqUrl.searchParams.get("error_description");
          const code = reqUrl.searchParams.get("code") || "";
          const state = reqUrl.searchParams.get("state") || "";

          try {
            if (server) {
              server.close();
              server = null;
            }
          } catch { /* ignore */ }

          if (errParam) {
            const detail = errDesc ? `${errParam}: ${errDesc}` : errParam;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body style='background:#04080e;color:#f87171;font-family:sans-serif;display:grid;place-items:center;height:100vh'><div>Google login failed or was denied. You can close this tab and return to Delshiv AI.</div></body></html>");
            const err = new Error(`Google OAuth error (${detail}) [client_id=${clientId}, redirect_uri=${redirectUri}]`);
            logBackendError("google-login (OAuth Callback)", err, { source: "main.js:auth" });
            finish({ ok: false, error: err.message });
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body style='background:#04080e;color:#f87171;font-family:sans-serif;display:grid;place-items:center;height:100vh'><div>OAuth state mismatch. Please retry sign-in from Delshiv AI.</div></body></html>");
            const err = new Error("Google OAuth state verification failed (possible stale callback tab).");
            logBackendError("google-login (State Mismatch)", err, { source: "main.js:auth" });
            finish({ ok: false, error: err.message });
            return;
          }

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body style='background:#04080e;color:#4ade80;font-family:sans-serif;display:grid;place-items:center;height:100vh'><div>Sign-in complete! You can close this browser tab and return to Delshiv AI.</div></body></html>");
          void handleOAuthCode(code);
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (err) {
        logBackendError("google-login (Callback Server)", err, { source: "main.js:auth" });
        finish({ ok: false, error: err?.message || String(err) });
      }
    });

    server.on("error", (err) => {
      logBackendError("google-login (OAuth Server Error)", err, { source: "main.js:auth" });
      finish({ ok: false, error: err?.message || String(err) });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (!port) {
        const err = new Error("Failed to bind local OAuth loopback port on 127.0.0.1.");
        logBackendError("google-login (Server Listen)", err, { source: "main.js:auth" });
        finish({ ok: false, error: err.message });
        return;
      }

      redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      const authParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
        access_type: "offline",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: expectedState,
        prompt: "select_account consent",
      });
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

      timeoutTimer = setTimeout(() => {
        const timeoutErr = new Error(
          `Google sign-in timed out waiting for loopback callback (${redirectUri}). If the browser showed "Error 401: invalid_client", verify that OAuth Client ID "${clientId}" is active in Google Cloud Console (Desktop app).`
        );
        logBackendError("google-login (Timeout / Browser Error)", timeoutErr, { source: "main.js:auth" });
        finish({ ok: false, error: timeoutErr.message });
      }, 120000);

      shell.openExternal(authUrl).catch((err) => {
        logBackendError("google-login (shell.openExternal)", err, { source: "main.js:auth" });
        finish({ ok: false, error: err?.message || String(err) });
      });
    });
  });
}

let clipWatchTimer = null;

if (ipcMain && (!app || gotSingleInstanceLock)) {
  const isAuthenticated = () => Boolean(currentAuthSession || loadAuthSession());
  const requireAuth = (fn) => async (evt, ...args) => {
    if (!isAuthenticated()) {
      return {
        ok: false,
        unauthorized: true,
        error: "Authentication required. Please sign in with an authorized Google account.",
      };
    }
    return await fn(evt, ...args);
  };

  ipcMain.handle("google-login", async () => {
    return await performGoogleOAuthLogin();
  });

  ipcMain.handle("get-current-user", () => {
    const user = currentAuthSession || loadAuthSession();
    return {
      ok: true,
      authenticated: Boolean(user),
      user: sanitizeUserForRenderer(user),
    };
  });

  ipcMain.handle("logout", () => {
    clearAuthSession();
    return { ok: true };
  });

  ipcMain.handle("delshiv:get-error-logs", () => errorLogs);

  ipcMain.handle("delshiv:clear-error-logs", () => {
    errorLogs.length = 0;
    return { ok: true, logs: [] };
  });

  ipcMain.handle("delshiv:log-error", (_evt, rawPayload = {}) => {
    try {
      const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : { message: String(rawPayload || "") };
      const action = payload.action || payload.tool_name || payload.failed_step || "Renderer Operation";
      const msg = payload.message || payload.technical_message || "Application error";
      const errObj = new Error(msg);
      if (payload.stack) {
        errObj.stack = String(payload.stack);
      }
      return logBackendError(action, errObj, {
        source: payload.source || payload.module || "renderer",
        stack: payload.stack,
      });
    } catch (err) {
      return logBackendError("delshiv:log-error", err);
    }
  });

  ipcMain.handle("delshiv:get-api-key", requireAuth(() => {
    return { ok: true, apiKey: readStoredApiKey() };
  }));

  ipcMain.handle("delshiv:get-settings", requireAuth(() => {
    const raw = readJsonSafe(APP_PATHS.settings, null);
    return {
      ok: true,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      settings: raw && typeof raw === "object" ? raw : { _schemaVersion: CURRENT_SCHEMA_VERSION, user: null, prefs: null, theme: null },
    };
  }));

  ipcMain.handle("delshiv:save-settings", requireAuth((_evt, opts = {}) => {
    try {
      const existing = readJsonSafe(APP_PATHS.settings, null) || {};
      const next = {
        ...existing,
        _schemaVersion: CURRENT_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        ...(opts.user !== undefined ? { user: opts.user } : {}),
        ...(opts.prefs !== undefined ? { prefs: opts.prefs } : {}),
        ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
      };
      atomicWriteJson(APP_PATHS.settings, next);
      return { ok: true, schemaVersion: CURRENT_SCHEMA_VERSION };
    } catch (err) {
      logBackendError("delshiv:save-settings", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));

  ipcMain.handle("delshiv:get-auto-start", requireAuth(() => {
    const openAtLogin = Boolean(app && typeof app.getLoginItemSettings === "function" ? app.getLoginItemSettings().openAtLogin : false);
    return { ok: true, openAtLogin };
  }));

  ipcMain.handle("delshiv:execute-tool", requireAuth(async (_evt, payload = {}) => {
    return await handleToolOrCommandExecution(payload && typeof payload === "object" ? payload : {});
  }));

  ipcMain.handle("delshiv:run-command", requireAuth(async (_evt, opts = {}) => {
    const base = typeof opts === "string" ? { command: opts } : (opts && typeof opts === "object" ? opts : {});
    return await handleToolOrCommandExecution({ ...base, tool: "runCommand" });
  }));

  ipcMain.handle("delshiv:read-file", requireAuth(async (_evt, opts = {}) => {
    return await readFileTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:write-file", requireAuth(async (_evt, opts = {}) => {
    return await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "writeFile" });
  }));

  ipcMain.handle("delshiv:edit-file", requireAuth(async (_evt, opts = {}) => {
    return await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "editFile" });
  }));

  ipcMain.handle("delshiv:glob-files", requireAuth(async (_evt, opts = {}) => {
    return await globFilesTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:web-search", requireAuth(async (_evt, opts = {}) => {
    return await webSearchTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:open-url", requireAuth(async (_evt, opts = {}) => {
    return await openUrlTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:manage-notes", requireAuth(async (_evt, opts = {}) => {
    return await manageNotesTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:manage-tasks", requireAuth(async (_evt, opts = {}) => {
    return await manageTasksTool(opts && typeof opts === "object" ? opts : {});
  }));

  ipcMain.handle("delshiv:copy-text", requireAuth((_evt, text) => {
    try {
      if (!clipboard || typeof clipboard.writeText !== "function") {
        throw new Error("Electron clipboard is unavailable.");
      }
      clipboard.writeText(String(text || ""));
      return { ok: true };
    } catch (err) {
      logBackendError("delshiv:copy-text", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));

  // ---- Clipboard Intelligence ----
  let lastClipText = "";
  let clipBusy = false;

  const runClipboardAnalysis = async (text, source) => {
    try {
      const result = await analyzeClipboardText(text, readStoredApiKey(), (model, err) =>
        logBackendError(`clipboard-intelligence [${model}]`, err, { source })
      );
      return { ok: true, result };
    } catch (err) {
      logBackendError("clipboard-intelligence", err, { source });
      return { ok: false, error: err?.message || String(err) };
    }
  };

  const pollClipboard = async () => {
    if (clipBusy) return;
    let text = "";
    try {
      text = normalizeClipboardText(clipboard.readText());
    } catch (err) {
      logBackendError("clipboard-intelligence [read]", err);
      return;
    }
    if (!text || text === lastClipText || text.length < 3) return;
    lastClipText = text;
    try { clipboardHistory?.push(text); } catch { /* ignore */ }
    clipBusy = true;
    try {
      const out = await runClipboardAnalysis(text, "clipboard-watcher");
      sendToRenderer("delshiv:clipboard-analysis", out);
      if (out.ok && Notification && Notification.isSupported()) {
        const r = out.result;
        const body = [r.action, r.translation && `→ ${r.translation}`].filter(Boolean).join("\n").slice(0, 400);
        const n = new Notification({ title: "Delshiv Clipboard AI", body: body || "Analysis ready" });
        n.on("click", () => {
          try { clipboard.writeText(r.refined); lastClipText = normalizeClipboardText(r.refined); } catch (e) { logBackendError("clipboard-notification-click", e); }
        });
        n.show();
      }
    } finally {
      clipBusy = false;
    }
  };

  // Adaptive behavior tracker + offline queue (local JSON, aggregate data only).
  try {
    const slog = (action, err) => logBackendError(action, err, { source: "adaptive-offline" });
    behavior = createBehaviorTracker({ filePath: APP_PATHS.behaviorProfile, log: slog });
    offlineQueue = createOfflineQueue({ filePath: APP_PATHS.offlineQueue, log: slog });
  } catch (err) {
    logBackendError("adaptive-offline [init]", err);
  }

  const guarded = (name, fn) => requireAuth((_evt, arg) => {
    try {
      if (!behavior || !offlineQueue) throw new Error("Adaptive/offline module is not initialised.");
      return { ok: true, ...fn(arg && typeof arg === "object" ? arg : {}) };
    } catch (err) {
      logBackendError(name, err);
      return { ok: false, error: err?.message || String(err) };
    }
  });
  ipcMain.handle("delshiv:behavior-record", guarded("delshiv:behavior-record", (a) => {
    if (a.kind === "message") behavior.recordMessage(a.text);
    else throw new Error(`Unknown behavior record kind "${a.kind}".`);
    return behavior.getSummary();
  }));
  ipcMain.handle("delshiv:behavior-summary", guarded("delshiv:behavior-summary", () => behavior.getSummary()));
  ipcMain.handle("delshiv:behavior-reset", guarded("delshiv:behavior-reset", () => { behavior.reset(); return behavior.getSummary(); }));
  ipcMain.handle("delshiv:queue-add", guarded("delshiv:queue-add", (a) => ({ item: offlineQueue.add(a.type || "chat", a), size: offlineQueue.size() })));
  ipcMain.handle("delshiv:queue-list", guarded("delshiv:queue-list", () => ({ items: offlineQueue.list(), size: offlineQueue.size() })));
  ipcMain.handle("delshiv:queue-remove", guarded("delshiv:queue-remove", (a) => ({ removed: offlineQueue.remove(String(a.id || "")), size: offlineQueue.size() })));

  try {
    memoryDb = createMemoryDb({
      dbPath: APP_PATHS.memoryDb,
      log: (a, e) => {
        const msg = String(e?.message || e || "");
        if (/cooldown|Retrying in|HTTP 404|HTTP 429|aborted due to timeout|TimeoutError/i.test(msg)) {
          return;
        }
        logBackendError(a, e, { source: "memory-db" });
      },
    });
  } catch (err) {
    logBackendError("memory-db [init]", err);
  }

  try {
    pcKnowledge = createPcKnowledge({
      userDirs: {
        Desktop: getDesktopDir(),
        Documents: getSpecialUserDir("documents"),
        Downloads: getSpecialUserDir("downloads"),
      },
      knownApps: Object.keys(KNOWN_WINDOWS_APPS),
      aliasesFilePath: APP_PATHS.aliases,
      log: (a, e) => logBackendError(a, e, { source: "pc-knowledge" }),
    });
    pcKnowledge.start();
  } catch (err) {
    logBackendError("pc-knowledge [init]", err);
  }

  try {
    clipboardHistory = createClipboardHistory({ filePath: APP_PATHS.clipboardHistory, log: (a, e) => logBackendError(a, e, { source: "clipboard-history" }) });
    focusManager = createFocusManager({
      filePath: APP_PATHS.focusSession,
      onComplete: (sess) => {
        showDesktopNotification("🎯 Focus Complete", `"${sess.label}" (${sess.minutes} min) finished! Time for a break.`);
      },
      log: (a, e) => logBackendError(a, e, { source: "focus-mode" }),
    });
    pinGuard = createPinGuard({ filePath: APP_PATHS.pinLock, log: (a, e) => logBackendError(a, e, { source: "pin-guard" }) });
    pluginLoader = createPluginLoader({ dirs: [APP_PATHS.pluginsDir, path.join(__dirname, "plugins")], log: (a, e) => logBackendError(a, e, { source: "plugin-loader" }) });
    void pluginLoader.reload();
  } catch (err) {
    logBackendError("extra-tools [init]", err);
  }

  try {
    memoryStore = createMemoryStore({ filePath: APP_PATHS.memoriesJson, log: (a, e) => logBackendError(a, e, { source: "memory" }) });
  } catch (err) {
    logBackendError("memory-store [init]", err);
  }

  // One-time legacy migration from memories.json into SQLite memoryDb
  try {
    const migrationFlag = APP_PATHS.legacyMemoryFlag;
    if (memoryDb && memoryStore && !fs.existsSync(migrationFlag)) {
      const legacyItems = memoryStore.list();
      if (legacyItems.length > 0) {
        memoryDb.importLegacyFacts(legacyItems);
      }
      atomicWriteText(migrationFlag, new Date().toISOString());
    }
  } catch (err) {
    logBackendError("memory-migration [init]", err);
  }

  try {
    macroStore = createMacroStore({ filePath: APP_PATHS.macros, log: (a, e) => logBackendError(a, e, { source: "macros" }) });
  } catch (err) {
    logBackendError("macro-store [init]", err);
  }

  try {
    activityLog = createActivityLog({
      filePath: APP_PATHS.toolActivityLog,
      log: (a, e) => logBackendError(a, e, { source: "activity-log" }),
    });
  } catch (err) {
    logBackendError("activity-log [init]", err);
  }

  try {
    ruleEngine = createRuleEngine({
      filePath: APP_PATHS.rules,
      downloadsDir: getSpecialUserDir("downloads"),
      getHealth: getSystemHealthSummary,
      onTrigger: async (rule, ctx) => {
        let detail = ctx?.detail || rule.name;
        if (rule.action === "summarize_doc" && ctx?.filePath) {
          try {
            const qa = await queryDocument({ filePath: ctx.filePath, question: "", apiKey: readStoredApiKey(), resolvePath: resolveFilePath });
            detail = `${ctx.fileName}: ${String(qa.answer || "").slice(0, 260)}`;
          } catch (err) {
            logBackendError("ruleEngine [summarize_doc]", err);
          }
        }
        showDesktopNotification(`⚡ Rule: ${rule.name}`, detail);
        sendToRenderer("delshiv:rule-fired", { rule, detail });
      },
      log: (a, e) => logBackendError(a, e, { source: "rule-engine" }),
    });
    ruleEngine.start();
  } catch (err) {
    logBackendError("rule-engine [init]", err);
  }

  // Persistent scheduler: starts with the app, fires tasks missed while closed.
  try {
    scheduler = createScheduler({
      filePath: APP_PATHS.scheduledTasks,
      onDue: handleScheduledTaskDue,
      log: (action, err) => logBackendError(action, err, { source: "scheduler" }),
    });
    scheduler.start();
  } catch (err) {
    logBackendError("scheduler [autostart]", err);
  }

  ipcMain.handle("delshiv:memory-auto-extract", requireAuth(async (_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, saved: false };
      const res = await memoryDb.autoExtractMemory({ ...safeOpts, apiKey: readStoredApiKey() });
      return { ok: true, ...res };
    } catch (err) {
      logBackendError("delshiv:memory-auto-extract", err);
      return { ok: false, saved: false };
    }
  }));
  ipcMain.handle("delshiv:memory-retrieve", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, items: [] };
      return { ok: true, items: memoryDb.retrieveRelevantMemories(safeOpts.query || "", safeOpts.limit || 6) };
    } catch (err) {
      logBackendError("delshiv:memory-retrieve", err);
      return { ok: false, items: [] };
    }
  }));
  ipcMain.handle("delshiv:chat-search", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, items: [] };
      return { ok: true, items: memoryDb.searchPastChats(safeOpts.query || "", { excludeSessionId: safeOpts.excludeSessionId || "", limit: safeOpts.limit || 8 }) };
    } catch (err) {
      logBackendError("delshiv:chat-search", err);
      return { ok: false, items: [] };
    }
  }));
  ipcMain.handle("delshiv:memory-facts", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, items: [], audit: [] };
      return { ok: true, items: memoryDb.listFacts(safeOpts.limit || 100), audit: memoryDb.getAuditLog(20) };
    } catch (err) {
      logBackendError("delshiv:memory-facts", err);
      return { ok: false, error: err?.message || String(err), items: [], audit: [] };
    }
  }));
  ipcMain.handle("delshiv:memory-update-fact", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) throw new Error("memoryDb not initialised");
      return { ok: true, item: memoryDb.updateFact(safeOpts.id, safeOpts) };
    } catch (err) {
      logBackendError("delshiv:memory-update-fact", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:memory-delete-fact", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) throw new Error("memoryDb not initialised");
      return { ok: true, removed: memoryDb.deleteFact(safeOpts.id) };
    } catch (err) {
      logBackendError("delshiv:memory-delete-fact", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:memory-db-save-msg", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, error: "memoryDb not initialised" };
      if (safeOpts.sessionId) activeSessionId = String(safeOpts.sessionId);
      const saved = memoryDb.saveMessage(safeOpts);
      if (saved && memoryDb.shouldAutoSummarize(saved.sessionId)) {
        void memoryDb.summarizeSession({ sessionId: saved.sessionId, apiKey: readStoredApiKey() });
      }
      return { ok: true, saved };
    } catch (err) {
      logBackendError("delshiv:memory-db-save-msg", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:memory-db-bootstrap", requireAuth((_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false, recentMessages: [], recentSummaries: [] };
      if (safeOpts.sessionId) activeSessionId = String(safeOpts.sessionId);
      return {
        ok: true,
        recentMessages: memoryDb.getRecentMessages(safeOpts.limit || 16),
        recentSummaries: memoryDb.getRecentSummaries(5, safeOpts.sessionId || ""),
      };
    } catch (err) {
      logBackendError("delshiv:memory-db-bootstrap", err);
      return { ok: false, recentMessages: [], recentSummaries: [] };
    }
  }));
  ipcMain.handle("delshiv:memory-db-summarize", requireAuth(async (_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!memoryDb) return { ok: false };
      const sum = await memoryDb.summarizeSession({ sessionId: safeOpts.sessionId || activeSessionId, apiKey: readStoredApiKey() });
      return { ok: true, summary: sum };
    } catch (err) {
      logBackendError("delshiv:memory-db-summarize", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:pc-knowledge", requireAuth(async (_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (!pcKnowledge) return { ok: false, error: "pc_knowledge not initialised" };
      if (safeOpts.refresh) await pcKnowledge.refresh();
      return { ok: true, ...pcKnowledge.getSnapshot() };
    } catch (err) {
      logBackendError("delshiv:pc-knowledge", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:understand-command", requireAuth(async (_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      if (safeOpts.text) errorLogger.setLastUserCommand(safeOpts.text);
      const snapshot = pcKnowledge ? pcKnowledge.getSnapshot() : {};
      const cleaned = cleanCommandText(safeOpts.text, snapshot);
      const activeWindow = pcKnowledge ? await pcKnowledge.getActiveWindow() : "";
      const clip = (() => { try { return clipboard.readText(); } catch { return ""; } })();
      const parsed = await parseCommandIntent({
        cleanedText: cleaned.cleanedText,
        originalText: cleaned.originalText,
        history: Array.isArray(safeOpts.history) ? safeOpts.history : [],
        activeWindow,
        clipboardText: clip,
        snapshot,
        apiKey: readStoredApiKey(),
      });
      logCommandTrace(APP_PATHS.commandLog, {
        originalText: cleaned.originalText,
        cleanedText: cleaned.cleanedText,
        corrections: cleaned.corrections,
        intent: parsed.intent,
        tool: parsed.tool,
        confidence: parsed.confidence,
        missing_info: parsed.missing_info,
      });
      return { ok: true, ...cleaned, ...parsed, activeWindow };
    } catch (err) {
      logBackendError("delshiv:understand-command", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:read-web-page", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "readWebPage" })));
  ipcMain.handle("delshiv:clipboard-history", requireAuth(async (_evt, opts = {}) => await clipboardHistoryTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:focus-mode", requireAuth(async (_evt, opts = {}) => await focusModeTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:media-control", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "mediaControl" })));
  ipcMain.handle("delshiv:pin-lock", requireAuth(async (_evt, opts = {}) => await pinLockTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:manage-plugins", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "managePlugins" })));
  ipcMain.handle("delshiv:clean-junk", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "cleanJunk" })));
  ipcMain.handle("delshiv:read-gmail", requireAuth(async (_evt, opts = {}) => await readGmailTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:open-file", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "openFile" })));
  ipcMain.handle("delshiv:smart-execute", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "smartExecute" })));
  ipcMain.handle("delshiv:system-health", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "systemHealth" })));
  ipcMain.handle("delshiv:network-tools", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "networkTools" })));
  ipcMain.handle("delshiv:rule-engine", requireAuth(async (_evt, opts = {}) => await ruleEngineTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:extract-text-ocr", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "extractTextFromImage" })));
  ipcMain.handle("delshiv:ollama-status", requireAuth(async () => {
    try {
      return await getOllamaStatus();
    } catch (err) {
      logBackendError("delshiv:ollama-status", err);
      return { ok: false, running: false, models: [], error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:ollama-chat", requireAuth(async (_evt, opts = {}) => {
    try {
      const safeOpts = opts && typeof opts === "object" ? opts : {};
      return await askOllama({ prompt: safeOpts.text || safeOpts.prompt, systemPrompt: safeOpts.systemPrompt, history: safeOpts.history, model: safeOpts.model });
    } catch (err) {
      logBackendError("delshiv:ollama-chat", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:organize-files", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "organizeFiles" })));
  ipcMain.handle("delshiv:memory", requireAuth(async (_evt, opts = {}) => await memoryTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:query-document", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "queryDocument" })));
  ipcMain.handle("delshiv:manage-windows", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "manageWindows" })));
  ipcMain.handle("delshiv:automate-input", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "automateInput" })));
  ipcMain.handle("delshiv:quickbar-hide", () => {
    if (quickBarWin && !quickBarWin.isDestroyed()) quickBarWin.hide();
    return { ok: true };
  });
  ipcMain.handle("delshiv:quickbar-resize", (_evt, height) => {
    if (quickBarWin && !quickBarWin.isDestroyed()) {
      const h = Math.min(500, Math.max(82, Math.round(Number(height) || 82)));
      quickBarWin.setSize(640, h);
    }
    return { ok: true };
  });
  ipcMain.handle("delshiv:quickbar-run", requireAuth(async (_evt, text) => {
    const q = String(text || "").trim();
    if (!q) return { ok: false, error: "Empty command." };
    errorLogger.setLastUserCommand(q);
    try {
      const apiKey = readStoredApiKey();
      const snapshot = pcKnowledge ? pcKnowledge.getSnapshot() : {};
      const cleaned = cleanCommandText(q, snapshot);
      const activeWindow = pcKnowledge ? await pcKnowledge.getActiveWindow() : "";
      const parsed = await parseCommandIntent({
        cleanedText: cleaned.cleanedText,
        originalText: cleaned.originalText,
        history: [],
        activeWindow,
        clipboardText: "",
        snapshot,
        apiKey,
      });

      if (parsed?.tool && Number(parsed.confidence || 0) >= 0.7 && !parsed.missing_info) {
        const execRes = await handleToolOrCommandExecution({
          tool: parsed.tool,
          ...(parsed.args && typeof parsed.args === "object" ? parsed.args : {}),
          target: parsed.target || parsed.args?.target || q,
          rawText: q,
        });
        const reply = String(execRes?.message || execRes?.answer || execRes?.stdout || execRes?.error || "Done.").trim();
        return {
          ok: Boolean(execRes?.ok),
          reply,
          toolResult: execRes,
          error: execRes?.ok ? undefined : execRes?.error,
        };
      }

      if (apiKey) {
        for (const model of GEMINI_MODELS) {
          try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: "You are Delshiv AI Quick Bar. Reply concisely in 1-4 lines in Hindi/Hinglish or English matching the user." }] },
                contents: [{ role: "user", parts: [{ text: q }] }],
                generationConfig: { temperature: 0.4 },
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.ok) {
              const data = await res.json();
              const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
              if (reply) return { ok: true, reply };
            } else {
              logBackendError(`quickbar-run [${model}]`, new Error(`HTTP ${res.status}`));
            }
          } catch (err) {
            logBackendError(`quickbar-run [${model}]`, err);
          }
        }
      }

      const local = await askOllama({ prompt: q, systemPrompt: "You are Delshiv AI Quick Bar. Reply concisely in 1-4 lines." });
      return { ok: true, reply: `[Ollama: ${local.model}] ${local.reply}` };
    } catch (err) {
      logBackendError("quickbar-run", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:generate-report", requireAuth(async (_evt, opts = {}) => await generateReportTool(opts && typeof opts === "object" ? opts : {})));
  ipcMain.handle("delshiv:schedule-task", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "scheduleTask" })));

  // Opt-in Clipboard Intelligence: starts paused until user enables watcher or analyzes manually.
  ipcMain.handle("delshiv:analyze-clipboard", requireAuth(async (_evt, opts = {}) => {
    const safeOpts = opts && typeof opts === "object" ? opts : {};
    const text = typeof safeOpts.text === "string" ? safeOpts.text : clipboard.readText();
    return await runClipboardAnalysis(text, "manual");
  }));

  ipcMain.handle("delshiv:set-clipboard-watch", requireAuth((_evt, enabled) => {
    try {
      if (enabled && !clipWatchTimer) {
        lastClipText = normalizeClipboardText(clipboard.readText()); // don't analyze pre-existing content
        clipWatchTimer = setInterval(pollClipboard, 1000);
      } else if (!enabled && clipWatchTimer) {
        clearInterval(clipWatchTimer);
        clipWatchTimer = null;
      }
      return { ok: true, watching: Boolean(clipWatchTimer) };
    } catch (err) {
      logBackendError("delshiv:set-clipboard-watch", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));

  ipcMain.handle("delshiv:get-tavily-key-status", requireAuth(() => {
    const k = readStoredTavilyKey();
    return { ok: true, configured: Boolean(k), masked: k ? `${k.slice(0, 6)}...${k.slice(-4)}` : "" };
  }));
  ipcMain.handle("delshiv:save-tavily-key", requireAuth((_evt, key) => {
    try {
      const ok = saveStoredTavilyKey(key);
      return ok ? { ok: true, masked: `${String(key).trim().slice(0, 6)}...${String(key).trim().slice(-4)}` } : { ok: false, error: "Invalid Tavily API key." };
    } catch (err) {
      logBackendError("delshiv:save-tavily-key", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));
  ipcMain.handle("delshiv:fetch-page", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "fetch_page" })));
  ipcMain.handle("delshiv:youtube-transcript", requireAuth(async (_evt, opts = {}) => await handleToolOrCommandExecution({ ...(opts && typeof opts === "object" ? opts : {}), tool: "youtube_transcript" })));
  ipcMain.handle("delshiv:save-api-key", requireAuth((_evt, key) => {
    try {
      const ok = saveStoredApiKey(key);
      if (!ok) {
        return { ok: false, error: "Failed to validate or save GEMINI_API_KEY." };
      }
      return { ok: true };
    } catch (err) {
      logBackendError("delshiv:save-api-key", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));

  ipcMain.handle("delshiv:set-auto-start", requireAuth((_evt, enabled) => {
    try {
      if (!app || typeof app.setLoginItemSettings !== "function") {
        throw new Error("app.setLoginItemSettings is not supported in this environment.");
      }
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), name: "Delshiv AI" });
      return { ok: true, openAtLogin: Boolean(enabled) };
    } catch (err) {
      logBackendError("delshiv:set-auto-start", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }));

  ipcMain.handle("delshiv:fetch-live-news", requireAuth(async (_evt, opts = {}) => {
    const safeOpts = opts && typeof opts === "object" ? opts : {};
    const actionName = safeOpts.query
      ? `delshiv:fetch-live-news (query="${safeOpts.query}")`
      : "delshiv:fetch-live-news";
    try {
      const { country, cc, items } = await fetchNewsWithFallback(safeOpts.query);
      if (!items.length) {
        logBackendError(actionName, new Error("RSS feed returned 0 news items."));
      }
      return { ok: true, country: country.name, country_code: cc, items };
    } catch (err) {
      logBackendError(actionName, err);
      return { ok: false, country: cachedCountry.name, country_code: cachedCountry.code, items: [], error: err.message };
    }
  }));
}

if (app && gotSingleInstanceLock) {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.whenReady()
    .then(() => {
      runAppMigrations({
        paths: APP_PATHS,
        secretsStore: getSecretsStore(),
        appVersion: typeof app.getVersion === "function" ? app.getVersion() : "4.0.0",
        onError: (a, e) => logBackendError(a, e, { source: "migrations" }),
      });
      loadAuthSession();
      createWindow();
    })
    .catch((err) => logBackendError("app.whenReady", err));

  app.on("window-all-closed", () => app.quit());

  let quitting = false;
  app.on("before-quit", async (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    try {
      if (clipWatchTimer) {
        clearInterval(clipWatchTimer);
        clipWatchTimer = null;
      }
      try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
      try { pcKnowledge?.stop(); } catch { /* ignore */ }
      try { ruleEngine?.stop(); } catch { /* ignore */ }
      try { scheduler?.stop(); } catch { /* ignore */ }
      try { focusManager?.shutdown(); } catch { /* ignore */ }
      try { behavior?.flush(); } catch { /* ignore */ }
      if (memoryDb && activeSessionId) {
        await Promise.race([
          memoryDb.summarizeSession({ sessionId: activeSessionId, apiKey: readStoredApiKey() }).catch((e) => logBackendError("before-quit:summarize", e)),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      try { memoryDb?.close(); } catch { /* ignore */ }
    } catch (err) {
      logBackendError("before-quit", err);
    } finally {
      app.exit(0);
    }
  });
}
