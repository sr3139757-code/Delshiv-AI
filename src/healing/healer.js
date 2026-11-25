// Self-Healing Core Engine for Delshiv AI.
// Listens to errorLogger 'error-logged' and 'error-repeated' events and executes multi-level self-healing:
//
// Levels:
//   Level 1: Safe direct fixes (tool retry up to 2x, module restart, missing npm package install, missing directory/file create).
//   Level 2: Automated code bug repair:
//     - Takes file/project backup snapshot prior to fix.
//     - Sends error, stack trace, and targeted file code to LLM for a minimal patch.
//     - Guards against risky modifications (file deletions, unapproved packages, protected files).
//     - Executes syntax verification and basic test suite.
//     - If tests pass -> retains fix and logs to heal-history.jsonl.
//     - If tests fail -> performs immediate atomic rollback to backup snapshot.
//   Level 3: Escalation & Report:
//     - Triggered when attempts reach 3 or when protected files prevent automated edits.
//     - Generates detailed Markdown report in logs/reports/heal-report-<timestamp>.md.
//     - Alerts user via voice/UI: "Delshiv, ye error fix nahi ho paya, report ready hai."

import { execFile, execFileSync } from "child_process";
import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { errorLogger } from "./errorLogger.js";
import { APP_PATHS, INSTALL_ROOT } from "../config/appConfig.js";

const PROJECT_ROOT = INSTALL_ROOT;
const DEFAULT_HEAL_HISTORY_FILE = APP_PATHS.healHistoryLog;
const DEFAULT_REPORTS_DIR = APP_PATHS.healReportsDir;
const DEFAULT_SNAPSHOTS_DIR = APP_PATHS.healSnapshotsDir;

const MAX_ATTEMPTS_PER_ERROR = 3;
const MAX_TOOL_RETRIES = 2;

// Protected targets that the healer must NEVER auto-modify or delete
const PROTECTED_TARGET_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^safety-guard\.js$/i,
  /^pin-guard\.js$/i,
  /^src[/\\]healing[/\\]healer\.js$/i,
  /^src[/\\]healing[/\\]errorLogger\.js$/i,
  /^src[/\\]config[/\\].+\.js$/i,
  /^main\.js$/i,
  /^preload\.cjs$/i,
  /^preload-quickbar\.cjs$/i,
  /^allowed_users\.json$/i,
  /^auth_session\.json$/i,
  /^pin_lock\.json$/i,
  /^secrets\.json$/i,
  /^settings\.json$/i,
  /^schema_meta\.json$/i,
];

// Valid npm package name regex
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;

// Directories safe for auto-creating missing folders / blank files in Level 1
const SAFE_AUTOCREATE_DIR_PREFIXES = [
  "logs",
  "data",
  "config",
  "plugins",
  "reports",
  "tasks",
  "temp",
  "scratch",
  "cache",
];

/** Check if candidate path is protected from any auto-create or modification */
export function isTargetProtected(candidatePath, rootDir = PROJECT_ROOT) {
  const norm = path.normalize(String(candidatePath || "")).trim();
  if (!norm) return true;
  const abs = path.isAbsolute(norm) ? norm : path.resolve(rootDir, norm);
  const rel = path.relative(rootDir, abs);

  if (rel.startsWith("..") || /^[a-z]:\\?$/i.test(abs) || /^\\\\[^?]/.test(abs)) {
    return true;
  }

  for (const pattern of PROTECTED_TARGET_PATTERNS) {
    if (pattern.test(rel) || pattern.test(path.basename(abs))) return true;
  }
  return false;
}

/** Check if path is protected specifically from Level 2 code bug repair */
export function isProtectedFromCodeRepair(candidatePath, rootDir = PROJECT_ROOT) {
  const norm = path.normalize(String(candidatePath || "")).trim();
  if (!norm) return { protected: true, reason: "Empty or invalid file path." };
  const abs = path.isAbsolute(norm) ? norm : path.resolve(rootDir, norm);
  const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
  const base = path.basename(abs).toLowerCase();

  if (
    base.startsWith(".env") ||
    base === "safety-guard.js" ||
    base === "pin-guard.js" ||
    rel === "src/healing/healer.js" ||
    rel === "src/healing/errorLogger.js" ||
    base === "allowed_users.json" ||
    base === "auth_session.json"
  ) {
    return { protected: true, reason: `Target "${rel}" is a protected security/core file.` };
  }

  // package.json scripts must never be auto-modified
  if (base === "package.json") {
    return { protected: true, reason: "package.json scripts are protected from automated editing." };
  }

  return { protected: false };
}

export function isSafeToAutocreate(candidatePath, rootDir = PROJECT_ROOT) {
  if (isTargetProtected(candidatePath, rootDir)) return false;
  const abs = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(rootDir, candidatePath);
  const rel = path.relative(rootDir, abs);
  const topSegment = rel.split(path.sep)[0]?.toLowerCase();
  return SAFE_AUTOCREATE_DIR_PREFIXES.includes(topSegment);
}

/**
 * Creates an atomic backup snapshot of a file prior to code repair.
 */
export function createSnapshot(targetFilePath, { snapshotDir = null, projectDir = PROJECT_ROOT } = {}) {
  const absPath = path.isAbsolute(targetFilePath) ? targetFilePath : path.resolve(projectDir, targetFilePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Cannot snapshot non-existent file: ${absPath}`);
  }
  const originalContent = fs.readFileSync(absPath, "utf-8");
  const timestamp = Date.now();
  const id = `snap_${timestamp}_${crypto.randomBytes(3).toString("hex")}`;
  const baseSnapDir = snapshotDir || path.resolve(projectDir, "logs", "snapshots", id);
  fs.mkdirSync(baseSnapDir, { recursive: true });
  const backupFileName = path.basename(absPath);
  const backupPath = path.join(baseSnapDir, backupFileName);
  fs.writeFileSync(backupPath, originalContent, "utf-8");

  return {
    id,
    timestamp,
    targetFilePath: absPath,
    backupPath,
    originalContent,
    restore() {
      fs.writeFileSync(absPath, originalContent, "utf-8");
      return true;
    },
  };
}

/**
 * Extracts target source file and error line number from an Error stack trace.
 */
export function extractTargetFileFromStack(stack, projectDir = PROJECT_ROOT) {
  if (!stack || typeof stack !== "string") return null;
  const currentUser = path.basename(os.homedir()) || process.env.USERNAME || "";
  const lines = stack.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("at "));
  for (const line of lines) {
    // Matches (file:///C:/path/file.js:12:34) or (C:\path\file.js:12:34) or at C:\path\file.js:12:34
    const m = line.match(/(?:file:\/\/\/|\(|\s)([a-zA-Z]:[\\/][^:)]+):(\d+)(?::(\d+))?\)?/);
    if (m && m[1]) {
      let rawPath = decodeURIComponent(m[1].replace(/\//g, path.sep));
      const lineNum = parseInt(m[2], 10);
      const colNum = m[3] ? parseInt(m[3], 10) : 0;

      // Ignore node internal files and self-healing engine internals
      if (
        rawPath.includes("node_modules") ||
        rawPath.includes("node:") ||
        rawPath.includes("src\\healing\\") ||
        rawPath.includes("src/healing/")
      ) {
        continue;
      }

      let absPath = path.resolve(rawPath);
      // Restore redacted user profile if <user> placeholder was inserted by redactor
      if (!fs.existsSync(absPath) && rawPath.includes("<user>") && currentUser) {
        const restored = rawPath.replace(/<user>/gi, currentUser);
        if (fs.existsSync(path.resolve(restored))) {
          absPath = path.resolve(restored);
        }
      }

      // Also check if filename exists directly inside projectDir
      if (!fs.existsSync(absPath)) {
        const candidateInProject = path.resolve(projectDir, path.basename(rawPath));
        if (fs.existsSync(candidateInProject)) {
          absPath = candidateInProject;
        }
      }

      if (fs.existsSync(absPath)) {
        return {
          filePath: absPath,
          relativeFilePath: path.relative(projectDir, absPath).replace(/\\/g, "/"),
          line: lineNum,
          column: colNum,
        };
      }
    }
  }
  return null;
}

/**
 * Detects risky or overly destructive patch proposals that require manual user approval.
 */
export function detectRiskyChange(originalContent, patchedContent, filePath = "") {
  if (!patchedContent || patchedContent.trim().length === 0) {
    return { risky: true, reason: "Patch would completely empty or delete file." };
  }
  const origLines = originalContent.split(/\r?\n/).length;
  const newLines = patchedContent.split(/\r?\n/).length;

  if (origLines > 30 && newLines < origLines * 0.3) {
    return {
      risky: true,
      reason: `Patch removes excessive lines (${origLines - newLines} lines, >70% deletion).`,
    };
  }

  if (filePath.endsWith("package.json")) {
    try {
      const origPkg = JSON.parse(originalContent);
      const newPkg = JSON.parse(patchedContent);
      const origDeps = Object.keys(origPkg.dependencies || {});
      const newDeps = Object.keys(newPkg.dependencies || {});
      const addedDeps = newDeps.filter((d) => !origDeps.includes(d));
      if (addedDeps.length > 0) {
        return { risky: true, reason: `Patch adds unapproved packages: ${addedDeps.join(", ")}.` };
      }
    } catch {
      return { risky: true, reason: "Malformed package.json patch." };
    }
  }

  return { risky: false };
}

/**
 * Runs syntax check and basic test verification on a modified file.
 */
export async function runSyntaxAndBasicTests(filePath, { projectDir = PROJECT_ROOT, testRunner = null } = {}) {
  // 1. Target file syntax check via Node.js runtime
  try {
    execFileSync(process.execPath, ["--check", filePath], { cwd: projectDir, stdio: "pipe" });
  } catch (err) {
    return { ok: false, error: `Syntax check failed: ${(err.stderr || err.message || "").toString().trim()}` };
  }

  // 2. Project-wide syntax check
  const syntaxCheckScript = path.resolve(projectDir, "tests", "syntax-check.js");
  if (fs.existsSync(syntaxCheckScript)) {
    try {
      execFileSync(process.execPath, [syntaxCheckScript], { cwd: projectDir, stdio: "pipe", timeout: 15000 });
    } catch (err) {
      return { ok: false, error: `Project syntax check failed: ${(err.stderr || err.message || "").toString().trim()}` };
    }
  }

  // 3. Basic test runner (if configured)
  if (typeof testRunner === "function") {
    try {
      const res = await testRunner({ filePath, projectDir });
      if (!res || !res.ok) {
        return { ok: false, error: res?.error || "Basic test suite failed after patch." };
      }
    } catch (err) {
      return { ok: false, error: `Test runner exception: ${err?.message || String(err)}` };
    }
  }

  return { ok: true };
}

/**
 * Generates Level 3 markdown failure report in logs/reports/.
 */
export function generateLevel3Report({
  errorEntry,
  attempts = [],
  projectDir = PROJECT_ROOT,
  probableCause = "",
} = {}) {
  const reportDir = path.resolve(projectDir, "logs", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const timestamp = Date.now();
  const dateStr = new Date().toISOString();
  const fileName = `heal-report-${timestamp}-${(errorEntry.id || "err").slice(-6)}.md`;
  const reportFilePath = path.join(reportDir, fileName);

  const attemptsRows = (attempts.length ? attempts : [{ attempt: 1, action: "Unknown", message: "Failed" }])
    .map(
      (a, i) =>
        `| ${a.attempt || i + 1} | ${a.time || dateStr} | \`${a.action || "repair"}\` | ${a.success ? "✅ Success" : "❌ Failed"} | ${a.message || "N/A"} |`
    )
    .join("\n");

  const cause =
    probableCause ||
    (errorEntry.message?.includes("Cannot read propert")
      ? "Null or undefined pointer dereference in module logic."
      : errorEntry.message?.includes("is not a function")
        ? "Type mismatch or missing exported function call."
        : "Unresolved logic bug or protected file policy preventing automated edits.");

  const md = `# 🚨 Delshiv AI Self-Healing Escalation Report (Level 3)

**Generated At:** ${dateStr}  
**Error ID:** \`${errorEntry.id || "N/A"}\`  
**Module / Tool:** \`${errorEntry.module || "unknown"}\`  
**User Command:** "${errorEntry.userCommand || "None"}"  

---

## 1. ⚠️ Error Summary
**Message:**
\`\`\`
${errorEntry.message || "Unknown error"}
\`\`\`

**Stack Trace:**
\`\`\`
${errorEntry.stack || "No stack trace available"}
\`\`\`

---

## 2. 🔄 Self-Healing Attempts History
The self-healing engine executed automated remediation attempts before escalating:

| Attempt | Timestamp | Action Taken | Result | Details |
|---------|-----------|--------------|--------|---------|
${attemptsRows}

---

## 3. 🔍 Probable Root Cause Analysis
${cause}

---

## 4. 🛠️ Recommended Action for BOSS
1. Inspect the stack trace above to locate the exact line.
2. If this target is a protected core security file, review and update manually.
3. Once updated, restart the affected module or re-run the user command.

*Delshiv AI Autonomous Self-Healing Engine*
`;

  fs.writeFileSync(reportFilePath, md, "utf-8");
  return {
    reportFilePath,
    fileName,
    voiceMessage: "Delshiv, ye error fix nahi ho paya, report ready hai.",
  };
}

function parseModuleNotFound(message) {
  const msg = String(message || "");
  const m =
    msg.match(/Cannot find module ['"]([^'"]+)['"]/i) ||
    msg.match(/Cannot find package ['"]([^'"]+)['"]/i) ||
    msg.match(/MODULE_NOT_FOUND.*?['"]([^'"]+)['"]/i);
  if (!m || !m[1]) return null;

  const rawTarget = m[1].trim();
  if (rawTarget.startsWith(".") || rawTarget.startsWith("/") || rawTarget.startsWith("\\") || rawTarget.includes(":\\")) {
    return { type: "local_file", target: rawTarget };
  }
  const parts = rawTarget.split("/");
  const pkgName = rawTarget.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  if (NPM_PACKAGE_NAME_RE.test(pkgName)) {
    return { type: "npm_package", packageName: pkgName };
  }
  return null;
}

function parseMissingPath(message) {
  const msg = String(message || "");
  const m =
    msg.match(/ENOENT:\s*no such file or directory,?\s*(?:open|scandir|mkdir|stat|unlink)?\s*['"]?([^'"\r\n]+)['"]?/i) ||
    msg.match(/no such file or directory:?\s*['"]?([^'"\r\n]+)['"]?/i);
  if (!m || !m[1]) return null;
  return m[1].trim();
}

function isTransientError(message) {
  const msg = String(message || "").toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout of") ||
    msg.includes("network error") ||
    msg.includes("fetch failed")
  );
}

function isCodeBug(message, stack) {
  const combined = `${message} ${stack}`;
  return (
    /TypeError:/i.test(combined) ||
    /ReferenceError:/i.test(combined) ||
    /SyntaxError:/i.test(combined) ||
    /RangeError:/i.test(combined) ||
    /Cannot read propert(?:y|ies) of (?:undefined|null)/i.test(combined) ||
    /is not a function/i.test(combined) ||
    /Unexpected token/i.test(combined)
  );
}

/**
 * Classifies an error into Level 0 (self-ignore), Level 1 (safe fix), Level 2 (code bug), or Level 3 (escalate).
 */
export function classifyError(errorEntry, { projectDir = PROJECT_ROOT, attemptCount = 0 } = {}) {
  const mod = String(errorEntry?.module || "").toLowerCase();
  const stack = String(errorEntry?.stack || "");
  const msg = String(errorEntry?.message || "");

  // Rule: Healer never heals itself
  if (
    mod === "healer" ||
    mod.startsWith("healing") ||
    stack.includes("src/healing/healer.js") ||
    stack.includes("src\\healing\\healer.js")
  ) {
    return { level: 0, type: "self_ignore", reason: "Healer ignores its own internal errors to prevent recursion." };
  }

  // If already at or above max attempts, escalate to Level 3
  if (attemptCount >= MAX_ATTEMPTS_PER_ERROR) {
    return {
      level: 3,
      type: "max_attempts_exceeded",
      reason: `Maximum healing attempts (${MAX_ATTEMPTS_PER_ERROR}) exhausted.`,
    };
  }

  // Level 1: Missing npm package
  const parsedModule = parseModuleNotFound(msg);
  if (parsedModule && parsedModule.type === "npm_package") {
    return {
      level: 1,
      type: "missing_npm_package",
      packageName: parsedModule.packageName,
      reason: `Missing npm package "${parsedModule.packageName}".`,
    };
  }

  // Level 1: Missing folder / file
  const missingPath = parseMissingPath(msg);
  if (missingPath) {
    if (isTargetProtected(missingPath, projectDir)) {
      return {
        level: 3,
        type: "protected_path_violation",
        targetPath: missingPath,
        reason: `Target path "${missingPath}" is protected; cannot auto-create.`,
      };
    }
    if (isSafeToAutocreate(missingPath, projectDir)) {
      const ext = path.extname(missingPath);
      return {
        level: 1,
        type: ext ? "missing_file" : "missing_directory",
        targetPath: missingPath,
        reason: `Missing safe ${ext ? "file" : "directory"} "${missingPath}".`,
      };
    }
  }

  // Level 1: Transient network / timeout error
  if (isTransientError(msg)) {
    return {
      level: 1,
      type: "retry_tool",
      tool: errorEntry.module,
      reason: `Transient error in "${errorEntry.module}"; retry eligible.`,
    };
  }

  // Level 2: Code bug repair
  if (isCodeBug(msg, stack)) {
    return {
      level: 2,
      type: "code_bug_repair",
      reason: "Code-level bug detected; eligible for automated LLM repair.",
    };
  }

  // Level 3: Unfixable or unknown fatal error
  return {
    level: 3,
    type: "unfixable",
    reason: `Unrecognized or fatal error in "${errorEntry.module}". Escalating to report.`,
  };
}

/**
 * Factory to create a self-healing Healer.
 */
export function createHealer(options = {}) {
  const {
    errorLoggerInstance = errorLogger,
    historyFilePath = DEFAULT_HEAL_HISTORY_FILE,
    reportsDir = DEFAULT_REPORTS_DIR,
    snapshotsDir = DEFAULT_SNAPSHOTS_DIR,
    projectDir = PROJECT_ROOT,
    maxAttempts = MAX_ATTEMPTS_PER_ERROR,
    npmExecutor = null,
    llmPatcher = null,
    testRunner = null,
    requestUserPermission = null,
    onReportLevel3 = null,
    onVoiceAlert = null,
    autoStart = true,
  } = options;

  const emitter = new EventEmitter();
  const attemptsByFingerprint = new Map();
  const historyByFingerprint = new Map();
  const inFlightSet = new Set();
  const moduleRestarters = new Map();
  const toolRetriers = new Map();
  let listening = false;

  function defaultNpmInstall(packageName) {
    return new Promise((resolve) => {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      execFile(
        npmCmd,
        ["install", "--no-audit", "--no-fund", "--save", packageName],
        { cwd: projectDir, timeout: 60000, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            return resolve({
              ok: false,
              error: (stderr || err.message || "").trim(),
              stdout: String(stdout || ""),
            });
          }
          resolve({ ok: true, stdout: String(stdout || "").trim() });
        }
      );
    });
  }

  const runNpmInstall = typeof npmExecutor === "function" ? npmExecutor : defaultNpmInstall;

  function appendHistory(record) {
    try {
      const dir = path.dirname(historyFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const line = `${JSON.stringify(record)}\n`;
      fs.appendFileSync(historyFilePath, line, "utf-8");

      const fp = record.fingerprint || "unknown";
      if (!historyByFingerprint.has(fp)) historyByFingerprint.set(fp, []);
      historyByFingerprint.get(fp).push(record);
    } catch {
      // Never crash on history log write failure
    }
  }

  function registerModuleRestarter(name, restartFn) {
    if (typeof restartFn === "function") {
      moduleRestarters.set(String(name).toLowerCase(), restartFn);
    }
  }

  function registerToolRetrier(name, retryFn) {
    if (typeof retryFn === "function") {
      toolRetriers.set(String(name).toLowerCase(), retryFn);
    }
  }

  async function executeLevel1Fix(classification, errorEntry, attemptNumber) {
    const actionLabel = `${classification.type}${classification.packageName ? `: ${classification.packageName}` : classification.targetPath ? `: ${classification.targetPath}` : ""}`;

    if (classification.type === "missing_npm_package") {
      const res = await runNpmInstall(classification.packageName);
      if (res && res.ok) {
        return {
          success: true,
          action: actionLabel,
          message: `Installed missing npm package "${classification.packageName}".`,
        };
      }
      return {
        success: false,
        action: actionLabel,
        message: `Failed to install package "${classification.packageName}": ${res?.error || "Unknown npm error"}`,
      };
    }

    if (classification.type === "missing_directory") {
      const abs = path.isAbsolute(classification.targetPath)
        ? classification.targetPath
        : path.resolve(projectDir, classification.targetPath);
      if (isTargetProtected(abs, projectDir)) {
        return { success: false, action: actionLabel, message: `Target "${abs}" is protected.` };
      }
      fs.mkdirSync(abs, { recursive: true });
      return { success: true, action: actionLabel, message: `Created missing directory "${abs}".` };
    }

    if (classification.type === "missing_file") {
      const abs = path.isAbsolute(classification.targetPath)
        ? classification.targetPath
        : path.resolve(projectDir, classification.targetPath);
      if (isTargetProtected(abs, projectDir)) {
        return { success: false, action: actionLabel, message: `Target "${abs}" is protected.` };
      }
      const dir = path.dirname(abs);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(abs)) {
        const defaultContent = abs.endsWith(".json") ? "{}\n" : "";
        fs.writeFileSync(abs, defaultContent, "utf-8");
      }
      return { success: true, action: actionLabel, message: `Created missing file "${abs}".` };
    }

    if (classification.type === "retry_tool") {
      const toolKey = String(errorEntry.module || "").toLowerCase();
      const retrier = toolRetriers.get(toolKey);
      if (typeof retrier === "function") {
        if (attemptNumber > MAX_TOOL_RETRIES) {
          return { success: false, action: actionLabel, message: `Max tool retries (${MAX_TOOL_RETRIES}) exceeded.` };
        }
        const retryRes = await retrier(errorEntry);
        return {
          success: Boolean(retryRes && retryRes.ok),
          action: actionLabel,
          message: retryRes?.message || `Retried tool "${errorEntry.module}".`,
        };
      }
      return {
        success: false,
        action: actionLabel,
        message: `No retrier registered for tool "${errorEntry.module}".`,
      };
    }

    if (classification.type === "restart_module") {
      const modKey = String(errorEntry.module || "").toLowerCase();
      const restarter = moduleRestarters.get(modKey);
      if (typeof restarter === "function") {
        const rRes = await restarter(errorEntry);
        return {
          success: Boolean(rRes && rRes.ok),
          action: actionLabel,
          message: rRes?.message || `Restarted module "${errorEntry.module}".`,
        };
      }
      return {
        success: false,
        action: actionLabel,
        message: `No restarter registered for module "${errorEntry.module}".`,
      };
    }

    return {
      success: false,
      action: actionLabel,
      message: `Unknown Level 1 fix type "${classification.type}".`,
    };
  }

  async function executeLevel2Repair(classification, errorEntry, attemptNumber) {
    const target = extractTargetFileFromStack(errorEntry.stack, projectDir);
    if (!target) {
      return {
        success: false,
        action: "code_bug_repair",
        message: "Could not locate matching local project source file from stack trace.",
        escalateImmediately: true,
      };
    }

    // Rule 5: Protected files check
    const protCheck = isProtectedFromCodeRepair(target.filePath, projectDir);
    if (protCheck.protected) {
      return {
        success: false,
        action: "protected_file_rejected",
        targetFile: target.relativeFilePath,
        message: protCheck.reason,
        escalateImmediately: true,
      };
    }

    // Step 1: Pre-fix snapshot backup
    let snapshot = null;
    try {
      snapshot = createSnapshot(target.filePath, { snapshotDir: snapshotsDir, projectDir });
    } catch (snapErr) {
      return {
        success: false,
        action: "code_bug_repair",
        message: `Snapshot creation failed: ${snapErr?.message || String(snapErr)}`,
      };
    }

    const currentCode = snapshot.originalContent;

    // Step 2: Request patch from LLM patcher
    let patchProposal = null;
    if (typeof llmPatcher === "function") {
      try {
        patchProposal = await llmPatcher({
          error: errorEntry.message,
          stack: errorEntry.stack,
          filePath: target.relativeFilePath,
          fileContent: currentCode,
          line: target.line,
          attempt: attemptNumber,
        });
      } catch (patchErr) {
        return {
          success: false,
          action: "code_bug_repair",
          message: `LLM patcher exception: ${patchErr?.message || String(patchErr)}`,
        };
      }
    } else {
      return {
        success: false,
        action: "code_bug_repair",
        message: "No LLM patcher configured for Level 2 repair.",
        escalateImmediately: true,
      };
    }

    if (!patchProposal || !patchProposal.patchedCode) {
      return {
        success: false,
        action: "code_bug_repair",
        message: patchProposal?.error || "LLM did not return a valid patched code block.",
      };
    }

    // Step 7: Check for risky modifications
    const risk = detectRiskyChange(currentCode, patchProposal.patchedCode, target.relativeFilePath);
    if (risk.risky) {
      let allowed = false;
      if (typeof requestUserPermission === "function") {
        try {
          allowed = await requestUserPermission({
            reason: risk.reason,
            filePath: target.relativeFilePath,
            error: errorEntry,
          });
        } catch {
          allowed = false;
        }
      }
      if (!allowed) {
        return {
          success: false,
          action: "permission_denied",
          targetFile: target.relativeFilePath,
          message: `Risky code modification rejected without user confirmation: ${risk.reason}`,
          escalateImmediately: true,
        };
      }
    }

    // Apply proposed patch to file
    try {
      fs.writeFileSync(target.filePath, patchProposal.patchedCode, "utf-8");
    } catch (writeErr) {
      snapshot.restore();
      return {
        success: false,
        action: "code_bug_repair",
        message: `Failed to write patch to disk: ${writeErr?.message || String(writeErr)}`,
      };
    }

    // Step 3 & 4: Run syntax check and basic test
    const testRes = await runSyntaxAndBasicTests(target.filePath, { projectDir, testRunner });
    if (!testRes.ok) {
      // Immediate atomic rollback on validation failure
      snapshot.restore();
      return {
        success: false,
        action: "code_bug_repair",
        targetFile: target.relativeFilePath,
        rolledBack: true,
        message: `Patch validation failed (${testRes.error}); safely rolled back to snapshot.`,
      };
    }

    // Tests passed! Fix retained
    return {
      success: true,
      action: "code_bug_repair",
      targetFile: target.relativeFilePath,
      snapshotId: snapshot.id,
      message: `Code repair applied and verified cleanly on "${target.relativeFilePath}".`,
    };
  }

  async function handleLoggedError(errorEntry) {
    if (!errorEntry || typeof errorEntry !== "object") return null;

    const fp = String(errorEntry.fingerprint || errorEntry.id || "unknown_fp");
    if (inFlightSet.has(fp)) return null;

    const currentAttempts = attemptsByFingerprint.get(fp) || 0;
    if (currentAttempts >= maxAttempts) {
      // Maximum attempts reached: strictly stop to prevent infinite loops
      return null;
    }

    const nextAttempt = currentAttempts + 1;

    const classification = classifyError(errorEntry, {
      projectDir,
      attemptCount: currentAttempts,
    });

    // Level 0: Ignore self-errors
    if (classification.level === 0) return null;

    inFlightSet.add(fp);
    attemptsByFingerprint.set(fp, nextAttempt);

    const started = Date.now();
    let outcome = { success: false, action: classification.type, message: classification.reason };

    try {
      if (classification.level === 1) {
        outcome = await executeLevel1Fix(classification, errorEntry, nextAttempt);
      } else if (classification.level === 2) {
        outcome = await executeLevel2Repair(classification, errorEntry, nextAttempt);
      } else {
        outcome = {
          success: false,
          action: "escalated_to_report",
          message: classification.reason || "Error cannot be auto-healed; escalating to report.",
        };
      }
    } catch (err) {
      outcome = {
        success: false,
        action: classification.type || "unknown",
        message: `Healer exception: ${err?.message || String(err)}`,
      };
    } finally {
      inFlightSet.delete(fp);
    }

    const durationMs = Date.now() - started;
    const historyRecord = {
      id: `heal_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      time: new Date().toISOString(),
      errorId: errorEntry.id,
      fingerprint: fp,
      module: errorEntry.module,
      level: classification.level,
      attempt: nextAttempt,
      action: outcome.action,
      success: outcome.success,
      rolledBack: Boolean(outcome.rolledBack),
      message: outcome.message,
      durationMs,
    };

    appendHistory(historyRecord);
    emitter.emit("heal-attempted", historyRecord);

    // Step 6: Level 3 escalation check
    const shouldEscalate =
      !outcome.success &&
      (classification.level === 3 || nextAttempt >= maxAttempts || outcome.escalateImmediately);

    if (shouldEscalate) {
      const reportInfo = generateLevel3Report({
        errorEntry,
        attempts: historyByFingerprint.get(fp) || [historyRecord],
        projectDir,
        probableCause: outcome.message,
      });

      historyRecord.level3Report = reportInfo.reportFilePath;
      historyRecord.voiceAlert = reportInfo.voiceMessage;

      emitter.emit("heal-escalated", { ...historyRecord, ...reportInfo });
      emitter.emit("voice-alert", {
        voiceText: reportInfo.voiceMessage,
        reportPath: reportInfo.reportFilePath,
        error: errorEntry,
      });

      if (typeof onVoiceAlert === "function") {
        try {
          onVoiceAlert(reportInfo.voiceMessage, reportInfo.reportFilePath, errorEntry);
        } catch { /* ignore */ }
      }

      if (typeof onReportLevel3 === "function") {
        try {
          onReportLevel3(errorEntry, historyRecord, reportInfo);
        } catch { /* ignore */ }
      }
    }

    return historyRecord;
  }

  function start() {
    if (listening) return;
    if (errorLoggerInstance && typeof errorLoggerInstance.on === "function") {
      errorLoggerInstance.on("error-logged", handleLoggedError);
      errorLoggerInstance.on("error-repeated", handleLoggedError);
      listening = true;
    }
  }

  function stop() {
    if (!listening) return;
    if (errorLoggerInstance && typeof errorLoggerInstance.off === "function") {
      errorLoggerInstance.off("error-logged", handleLoggedError);
      errorLoggerInstance.off("error-repeated", handleLoggedError);
      listening = false;
    }
  }

  function getHistory(limit = 100) {
    try {
      if (!fs.existsSync(historyFilePath)) return [];
      const lines = fs
        .readFileSync(historyFilePath, "utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      return [];
    }
  }

  function clearHistory() {
    attemptsByFingerprint.clear();
    historyByFingerprint.clear();
    try {
      if (fs.existsSync(historyFilePath)) fs.unlinkSync(historyFilePath);
    } catch {
      // ignore
    }
  }

  if (autoStart) {
    start();
  }

  return Object.assign(emitter, {
    start,
    stop,
    handleLoggedError,
    classifyError: (entry) =>
      classifyError(entry, {
        projectDir,
        attemptCount: attemptsByFingerprint.get(entry?.fingerprint) || 0,
      }),
    registerModuleRestarter,
    registerToolRetrier,
    getHistory,
    clearHistory,
    getAttempts: (fp) => attemptsByFingerprint.get(fp) || 0,
    historyFilePath,
    reportsDir,
    snapshotsDir,
  });
}

export const healer = createHealer();
export default healer;
