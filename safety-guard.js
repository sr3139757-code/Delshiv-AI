// Safety layer + tool activity log for Delshiv AI.
// classifyRisk() is pure; main.js enforces confirmation & PIN guard before execution.
import fs from "fs";
import path from "path";
import { redact } from "./report-generator.js";

const DANGEROUS_CMD = new RegExp(
  [
    "\\b(Remove-Item|rm|rmdir|rd|del|erase|format|diskpart|cipher|shutdown|Restart-Computer|Stop-Computer)\\b",
    "\\b(Stop-Process|taskkill|Set-ExecutionPolicy|Invoke-Expression|iex|New-Service|netsh|bcdedit|vssadmin|wbadmin)\\b",
    "\\b(reg(?:\\.exe)?\\s+(?:add|delete|import)|sc(?:\\.exe)?\\s+(?:delete|config|stop)|Set-ItemProperty|New-ItemProperty)\\b",
    "\\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|Start-BitsTransfer)\\b",
    "\\b(Set-Content|Add-Content|Out-File|Clear-Content|Move-Item|Rename-Item|Copy-Item)\\b",
    "\\b(Start-Process|saps|Invoke-Command|icm|Invoke-CimMethod|Add-Type|ri|rp|mi|mv|cp|ren|rni|cpi|ac|clc|sp|spps|ni|sal)\\b",
    "\\b(cmd(?:\\.exe)?\\s*\\/c|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|wscript|cscript|mshta|rundll32|certutil|schtasks|wmic|robocopy|icacls|takeown)\\b",
    "\\[System\\.(?:IO|Net|Diagnostics|Reflection)",
    "(?:\\d|&)?\\s*>{1,2}(?!&)",
    "`|\\$\\(",
  ].join("|"),
  "i"
);

const CATASTROPHIC_CMD = new RegExp(
  [
    "\\bformat(?:\\.com|\\.exe)?\\s+[a-z]:",
    "\\b(diskpart|bcdedit|vssadmin\\s+delete|wbadmin\\s+delete|cipher\\s+\\/w)\\b",
    "(?:Remove-Item|rm|rmdir|rd|del|erase|ri).*?(?:[a-z]:\\\\(?:windows|program files|program files \\(x86\\)|programdata)|\\\\system32|\\.env|allowed_users\\.json|auth_session\\.json|pin_lock\\.json)",
  ].join("|"),
  "i"
);

const READ_ONLY_CMD_ALLOWLIST = /^(?:Get-Date|Get-Location|Get-ChildItem|Get-Process|Get-Service|Get-Content|Get-CimInstance|Get-ItemProperty|Get-ComputerInfo|Get-NetIPAddress|Test-Connection|dir|ls|pwd|whoami|hostname|echo|ipconfig|systeminfo|ver|where|which|git\s+(?:status|log|branch|diff|show)|node\s+(?:-v|--version)|npm\s+(?:-v|--version)|python\s+--version)(?:\s|$)/i;
const SHELL_CHAIN_OR_EVAL = /[;|&><`\r\n]|\$\(/;

const EXECUTABLE_EXT_RE = /\.(?:js|mjs|cjs|bat|cmd|ps1|vbs|exe|msi|lnk|scr|com|hta|jar)$/i;

// Never allowed, even with user approval (OS integrity + Delshiv security state).
const PROTECTED_PATH = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata|\$recycle\.bin|system volume information)(\\|$)/i;
const PROTECTED_SHORT_83 = /^[a-z]:\\(progra~\d+|window~\d+|system~\d+)(\\|$)/i;

let safetyConfig = {
  appDir: "",
  userDataDir: "",
  resolvePath: null,
};

export function configureSafetyPaths({ appDir = "", userDataDir = "", resolvePath = null } = {}) {
  safetyConfig = {
    appDir: appDir ? path.resolve(String(appDir)) : "",
    userDataDir: userDataDir ? path.resolve(String(userDataDir)) : "",
    resolvePath: typeof resolvePath === "function" ? resolvePath : null,
  };
}

function resolveForSafety(rawPath, cwd) {
  const clean = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!clean) return "";
  if (safetyConfig.resolvePath) {
    try {
      return safetyConfig.resolvePath(clean, cwd);
    } catch { /* fall through */ }
  }
  return cwd ? path.resolve(String(cwd), clean) : path.resolve(clean);
}

function canonicalizeDeepest(absPath) {
  const norm = path.resolve(absPath);
  const tail = [];
  let cur = norm;
  while (cur && !fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    if (fs.existsSync(cur)) {
      const realBase = typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(realBase, ...tail) : realBase;
    }
  } catch { /* fall back to norm */ }
  return norm;
}

function matchesAppProtectedTarget(candidatePath) {
  const lc = path.resolve(candidatePath).toLowerCase();
  if (safetyConfig.appDir) {
    const appLc = safetyConfig.appDir.toLowerCase();
    const appProtectedFiles = [
      ".env",
      "allowed_users.json",
      "main.js",
      "preload.cjs",
      "preload-quickbar.cjs",
      "safety-guard.js",
      "pin-guard.js",
      "plugin-loader.js",
      "shared-utils.js",
    ];
    for (const rel of appProtectedFiles) {
      if (lc === path.join(appLc, rel).toLowerCase()) return true;
    }
    const appPlugins = path.join(appLc, "plugins").toLowerCase();
    if (lc === appPlugins || lc.startsWith(appPlugins + path.sep)) return true;
  }
  if (safetyConfig.userDataDir) {
    const udLc = safetyConfig.userDataDir.toLowerCase();
    const udProtectedFiles = [".env", "auth_session.json", "pin_lock.json"];
    for (const rel of udProtectedFiles) {
      if (lc === path.join(udLc, rel).toLowerCase()) return true;
    }
    const udPlugins = path.join(udLc, "plugins").toLowerCase();
    if (lc === udPlugins || lc.startsWith(udPlugins + path.sep)) return true;
  }
  return false;
}

function checkCandidateProtected(candidate) {
  const norm = path.normalize(String(candidate || ""));
  if (!norm) return false;
  if (/^\\\\[^?]/.test(norm)) return true; // UNC network share
  const stripped = norm.replace(/^\\\\[?.]\\/i, "");
  if (/^unc\\/i.test(stripped)) return true;
  const resolved = path.resolve(stripped);
  if (PROTECTED_PATH.test(resolved) || PROTECTED_SHORT_83.test(resolved) || /^[a-z]:\\?$/i.test(resolved)) {
    return true;
  }
  if (matchesAppProtectedTarget(resolved)) return true;
  return false;
}

export function isProtectedPath(p, cwd = undefined) {
  const raw = String(p || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return false;
  if (/^\\\\[^?]/.test(raw)) return true;
  const withoutPrefix = raw.replace(/^\\\\[?.]\\/i, "");
  if (/^unc\\/i.test(withoutPrefix)) return true;

  if (checkCandidateProtected(withoutPrefix)) return true;
  const resolved = resolveForSafety(withoutPrefix, cwd);
  if (!resolved) return false;
  if (checkCandidateProtected(resolved)) return true;

  const real = canonicalizeDeepest(resolved);
  if (real && real !== resolved && checkCandidateProtected(real)) return true;
  return false;
}

const clip = (s, n = 400) => {
  const t = redact(String(s ?? ""));
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Returns { level: "safe"|"confirm"|"block", reason, detail, sessionKey? }
 */
export function classifyRisk(tool, payload = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const t = String(tool || "").trim();
  const target = p.targetPath || p.path || p.filePath || p.folderName || p.target || "";

  if (/^(deletePath|delete_path|deleteFolder|delete_folder|deleteFile|delete_file)$/i.test(t)) {
    if (target && isProtectedPath(target, p.cwd)) return { level: "block", reason: "Protected system or security location", detail: clip(target) };
    return { level: "confirm", reason: "Delete file/folder", detail: clip(target || "(no path)") };
  }

  if (/^(writeFile|write_file)$/i.test(t)) {
    if (target && isProtectedPath(target, p.cwd)) return { level: "block", reason: "Protected system or security location", detail: clip(target) };
    const cleanTarget = String(target || "").trim().replace(/^["']|["']$/g, "");
    if (cleanTarget && EXECUTABLE_EXT_RE.test(cleanTarget)) {
      return { level: "confirm", reason: "Write script or executable file", detail: clip(cleanTarget) };
    }
    let exists = false;
    try {
      const resolved = resolveForSafety(target, p.cwd);
      exists = Boolean(resolved) && fs.existsSync(resolved);
    } catch { /* treat as new */ }
    if (exists) return { level: "confirm", reason: "Overwrite existing file", detail: clip(target), sessionKey: "writeFile" };
    return { level: "safe" };
  }

  if (/^(editFile|edit_file)$/i.test(t)) {
    if (target && isProtectedPath(target, p.cwd)) return { level: "block", reason: "Protected system or security location", detail: clip(target) };
    return { level: "confirm", reason: "Edit file", detail: clip(target), sessionKey: "editFile" };
  }

  if (/^(createFolder|create_folder)$/i.test(t)) {
    if (target && isProtectedPath(target, p.cwd)) return { level: "block", reason: "Protected system or security location", detail: clip(target) };
    return { level: "safe" };
  }

  if (/^(openFile|open_file)$/i.test(t)) {
    if (target && isProtectedPath(target, p.cwd)) return { level: "block", reason: "Protected system or security location", detail: clip(target) };
    const cleanTarget = String(target || "").trim().replace(/^["']|["']$/g, "");
    if (cleanTarget && EXECUTABLE_EXT_RE.test(cleanTarget)) {
      return { level: "confirm", reason: "Launch executable or script file", detail: clip(cleanTarget) };
    }
    return { level: "safe" };
  }

  if (/^(runCommand|run_command|powershell)$/i.test(t)) {
    const cmd = String(p.command || p.cmd || p.target || "").trim();
    if (!cmd) return { level: "safe" };
    if (CATASTROPHIC_CMD.test(cmd)) {
      return { level: "block", reason: "Blocked destructive or protected system command", detail: clip(cmd, 600) };
    }
    if (!SHELL_CHAIN_OR_EVAL.test(cmd) && !DANGEROUS_CMD.test(cmd) && READ_ONLY_CMD_ALLOWLIST.test(cmd)) {
      return { level: "safe" };
    }
    return { level: "confirm", reason: "Shell/PowerShell execution requires user approval", detail: clip(cmd, 600) };
  }

  if (/^(smartExecute|smart_execute)$/i.test(t)) {
    const cmd = String(p.command || "").trim();
    const kind = String(p.kind || "auto").toLowerCase().trim();
    const tgt = String(p.target || "").trim();
    if (cmd) return classifyRisk("runCommand", { ...p, command: cmd });
    if (kind === "command" || (kind === "auto" && tgt && (SHELL_CHAIN_OR_EVAL.test(tgt) || DANGEROUS_CMD.test(tgt)))) {
      return classifyRisk("runCommand", { ...p, command: tgt });
    }
    return { level: "safe" };
  }

  if (/^(managePlugins|manage_plugins)$/i.test(t)) {
    const op = String(p.operation || "list").toLowerCase().trim();
    if (op === "reload" || op === "run") {
      return { level: "confirm", reason: `${op === "reload" ? "Load" : "Execute"} plugin code in main process`, detail: clip(p.name || p.target || "plugins") };
    }
    return { level: "safe" };
  }

  if (/^(scheduleTask|schedule_task)$/i.test(t)) {
    const op = String(p.operation || p.op || "list").toLowerCase().trim();
    if (op === "add" || op === "create") {
      const ap = p.actionPayload;
      if (ap && typeof ap === "object" && ap.type === "command") {
        return classifyRisk("runCommand", { command: ap.command, cwd: p.cwd });
      }
      if (ap && typeof ap === "object" && ap.type === "macro") {
        return { level: "confirm", reason: "Schedule workflow macro execution", detail: clip(ap.macro || p.taskName || "macro") };
      }
    }
    return { level: "safe" };
  }

  if (/^(workflowMacro|workflow_macro)$/i.test(t)) {
    const op = String(p.operation || "list").toLowerCase().trim();
    if (op === "run" || op === "schedule") {
      return { level: "confirm", reason: `${op === "run" ? "Run" : "Schedule"} workflow macro`, detail: clip(p.name || p.target || "macro") };
    }
    return { level: "safe" };
  }

  if (/^(pinLock|pin_lock)$/i.test(t)) {
    const op = String(p.operation || "status").toLowerCase().trim();
    if (op === "disable") return { level: "confirm", reason: "Disable sensitive-tool PIN lock", detail: "pinLock" };
    return { level: "safe" };
  }

  if (/^(systemControl|system_control)$/i.test(t)) {
    const op = String(p.operation || p.commandType || p.target || "").toLowerCase();
    if (op === "shutdown_pc" || op === "restart_pc" || op === "sleep_pc") {
      return { level: "confirm", reason: `System ${op.replace("_pc", "")}`, detail: op };
    }
  }

  if (/^(organizeFiles|organize_files)$/i.test(t)) {
    const op = String(p.operation || "plan").toLowerCase();
    if (op === "apply" || op === "undo") {
      return { level: "confirm", reason: op === "undo" ? "Undo file organisation (move files back)" : "Organise folder (move files into category subfolders)", detail: clip(p.path || "Downloads") };
    }
    return { level: "safe" };
  }

  if (/^(manageWindows|manage_windows)$/i.test(t)) {
    const op = String(p.operation || "list").toLowerCase();
    if (op === "close") return { level: "confirm", reason: "Close application window", detail: clip(p.target || "(window)") };
    return { level: "safe" };
  }

  if (/^(automateInput|automate_input)$/i.test(t)) {
    const op = String(p.operation || "").toLowerCase();
    return { level: "confirm", reason: `Simulate mouse/keyboard (${op || "input"})`, detail: clip(p.keys || p.text || `${p.x ?? ""},${p.y ?? ""}`), sessionKey: "automateInput" };
  }

  if (/^(systemHealth|system_health)$/i.test(t)) {
    const op = String(p.operation || "summary").toLowerCase();
    if (op === "kill") return { level: "confirm", reason: "Terminate running process", detail: clip(p.processName || `PID ${p.pid || ""}`) };
    return { level: "safe" };
  }

  if (/^(networkTools|network_tools)$/i.test(t)) {
    const op = String(p.operation || "ports").toLowerCase();
    if (op === "free_port") return { level: "confirm", reason: "Kill process listening on TCP port", detail: clip(`Port ${p.port || ""}`) };
    return { level: "safe" };
  }

  if (/^(cleanJunk|clean_junk)$/i.test(t)) {
    const op = String(p.operation || "scan").toLowerCase();
    if (op === "clean") return { level: "confirm", reason: "Delete Windows temp/junk files & empty Recycle Bin", detail: "User Temp, CrashDumps, Windows Temp, Recycle Bin" };
    return { level: "safe" };
  }

  if (/^(sendEmail|send_email|sendMessage|send_message)$/i.test(t)) {
    return { level: "confirm", reason: "Send external email/message", detail: clip(p.to || p.recipient || p.subject || "(message)") };
  }

  return { level: "safe" };
}

export function isSensitiveForPin(tool, payload = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const t = String(tool || "").trim();
  const op = String(p.operation || p.op || "").toLowerCase().trim();

  if (/^(pinLock|pin_lock)$/i.test(t)) {
    return op === "disable";
  }

  const risk = classifyRisk(t, p);
  if (risk.level === "confirm" || risk.level === "block") return true;

  if (/^(readGmail|read_gmail|gmail|deletePath|delete_path|deleteFolder|delete_folder|deleteFile|delete_file|runCommand|run_command|powershell|automateInput|automate_input)$/i.test(t)) {
    return true;
  }
  if (/^(managePlugins|manage_plugins)$/i.test(t) && (op === "reload" || op === "run")) {
    return true;
  }
  if (/^(cleanJunk|clean_junk)$/i.test(t) && op === "clean") {
    return true;
  }
  return false;
}

export const TOOL_SAFETY_CATALOG = {
  safe: [
    "webSearch", "fetch_page", "youtube_transcript", "readWebPage", "readFile", "globFiles",
    "searchCode", "readScreen", "extractTextFromImage", "readGmail", "manageNotes", "manageTasks",
    "scheduleTask(list/now/notify)", "dailyBriefing", "memory", "queryDocument", "clipboardHistory", "focusMode",
    "mediaControl", "generateReport", "getToolActivity", "getErrorLogs", "open_app", "openUrl",
    "systemHealth(summary/processes)", "networkTools(ports/ping)", "organizeFiles(plan/duplicates)",
    "cleanJunk(scan)", "manageWindows(list/focus/minimize/maximize/restore/snap)", "managePlugins(list)",
  ],
  dangerous: [
    "deletePath", "writeFile(overwrite/script)", "editFile", "runCommand(non-readonly)",
    "systemControl(shutdown/restart/sleep)", "cleanJunk(clean)", "organizeFiles(apply/undo)",
    "manageWindows(close)", "automateInput", "systemHealth(kill)", "networkTools(free_port)",
    "managePlugins(reload/run)", "scheduleTask(command/macro)", "workflowMacro(run/schedule)",
    "openFile(executable)", "pinLock(disable)", "sendEmail", "sendMessage",
  ],
};

// ───────── Activity log (JSONL, rotated at 2 MB) ─────────
const MAX_BYTES = 2 * 1024 * 1024;

export function createActivityLog({ filePath, log = () => {} }) {
  function append(entry) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (fs.existsSync(filePath)) {
        try {
          if (fs.statSync(filePath).size > MAX_BYTES) {
            const backup = `${filePath}.1`;
            try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* ignore */ }
            fs.renameSync(filePath, backup);
          }
        } catch (rotErr) {
          log("activity-log rotate", rotErr);
        }
      }
      fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      log("activity-log append", err);
    }
  }

  function record({ tool, payload, decision, ok, error, ms }) {
    const summary = clip(
      payload?.command || payload?.targetPath || payload?.path || payload?.filePath || payload?.folderName || payload?.target || payload?.operation || payload?.query || "",
      200
    );
    append({ time: new Date().toISOString(), tool: String(tool || ""), summary, decision, ok: Boolean(ok), error: error ? clip(error, 200) : undefined, ms });
  }

  function recent(limit = 20) {
    const n = Math.min(200, Math.max(1, Math.floor(Number(limit) || 20)));
    try {
      if (!fs.existsSync(filePath)) return [];
      const st = fs.statSync(filePath);
      let raw = "";
      if (st.size > 512 * 1024) {
        const readBytes = Math.min(st.size, 512 * 1024);
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(readBytes);
          fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
          raw = buf.toString("utf-8");
          const nl = raw.indexOf("\n");
          if (nl !== -1) raw = raw.slice(nl + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        raw = fs.readFileSync(filePath, "utf-8");
      }
      const lines = raw.split("\n").filter(Boolean);
      return lines.slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch (err) {
      log("activity-log read", err);
      return [];
    }
  }

  return { record, recent };
}
