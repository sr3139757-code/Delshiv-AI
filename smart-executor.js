// Multi-Strategy Resilient Executor for Delshiv AI.
// Automatically tries up to 4 distinct strategies for a goal/command before reporting failure.
import fs from "fs";
import path from "path";

const WEB_DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|in|co|dev|app|gov|edu|uk|me|tv|gg)(?:[/?#].*)?$/i;
const FILE_EXT_RE = /\.(?:txt|md|json|js|cjs|mjs|ts|py|csv|log|pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|webp|mp4|mp3|zip|rar|7z|html|css|xml|yaml|yml|ini|bat|cmd|ps1|vbs|exe)$/i;

export async function runWithStrategies(goal, strategies, log = () => {}) {
  const attempts = [];
  const list = strategies.slice(0, 4);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const started = Date.now();
    try {
      const res = await s.run();
      if (res && res.ok) {
        attempts.push({ step: i + 1, strategy: s.name, ok: true, ms: Date.now() - started });
        const stdoutText = typeof res.stdout === "string" ? res.stdout : "";
        const stderrText = typeof res.stderr === "string" ? res.stderr : "";
        const trimmedOut = stdoutText.trim();
        let summaryMsg = res.message;
        if (!summaryMsg) {
          if (trimmedOut) {
            const preview = trimmedOut.length > 180 ? `${trimmedOut.slice(0, 180)}...` : trimmedOut;
            summaryMsg = `Succeeded (${trimmedOut.split(/\r?\n/).length} line(s): ${preview})`;
          } else {
            summaryMsg = "Succeeded";
          }
        }
        return {
          ok: true,
          goal,
          succeededAt: i + 1,
          strategyUsed: s.name,
          attempts,
          ...(typeof res.stdout === "string" ? { stdout: res.stdout } : {}),
          ...(typeof res.stderr === "string" ? { stderr: res.stderr } : {}),
          result: res,
          message: `${summaryMsg} (Strategy ${i + 1}/${list.length}: ${s.name})`,
        };
      }
      const errMsg = res?.error || "Returned ok=false";
      attempts.push({ step: i + 1, strategy: s.name, ok: false, error: errMsg, ms: Date.now() - started });
      const isSecurityBlock =
        Boolean(res?.denied) ||
        Boolean(res?.blocked) ||
        /Refusing to read protected|Blocked for safety|Blocked protected|protected system or security/i.test(errMsg);

      if (isSecurityBlock || res?.needsConfirmation || res?.pinRequired) {
        // Never bypass explicit denial, protected-path block, confirmation, or PIN lock.
        return {
          ok: false,
          goal,
          stoppedEarly: true,
          needsConfirmation: Boolean(res?.needsConfirmation),
          pinRequired: Boolean(res?.pinRequired),
          blocked: isSecurityBlock,
          attempts,
          error: errMsg,
        };
      }
    } catch (err) {
      const msg = err?.message || String(err);
      attempts.push({ step: i + 1, strategy: s.name, ok: false, error: msg, ms: Date.now() - started });
      log(`smartExecute [${s.name}]`, err);
      if (/Refusing to read protected|Blocked for safety|Blocked protected|protected system or security/i.test(msg)) {
        return {
          ok: false,
          goal,
          stoppedEarly: true,
          blocked: true,
          attempts,
          error: msg,
        };
      }
    }
  }
  const summary = attempts.map((a) => `${a.step}. ${a.strategy}: ${a.error}`).join(" | ");
  return {
    ok: false,
    goal,
    failedAllStrategies: true,
    attempts,
    error: `All ${attempts.length} strategies failed for "${goal}": ${summary}`,
  };
}

export function findFileAcrossUserDirs(nameOrPath, userDirs = []) {
  const clean = String(nameOrPath || "").trim().replace(/^["']|["']$/g, "");
  const base = path.basename(clean);
  if (!base) return null;
  const dirHint = path.dirname(clean);
  const hintToken = dirHint && dirHint !== "." ? path.basename(dirHint).toLowerCase() : "";

  const orderedDirs = hintToken
    ? [...userDirs].sort((a, b) => {
        const aHit = String(a || "").toLowerCase().includes(hintToken) ? 0 : 1;
        const bHit = String(b || "").toLowerCase().includes(hintToken) ? 0 : 1;
        return aHit - bHit;
      })
    : userDirs;

  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const targetNorm = norm(base);

  for (const dir of orderedDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const exact = path.join(dir, base);
    if (fs.existsSync(exact)) return exact;
    if (targetNorm.length < 3) continue;
    try {
      const entries = fs.readdirSync(dir);
      const fuzzy = entries.find((e) => norm(e) === targetNorm || norm(e).includes(targetNorm));
      if (fuzzy) return path.join(dir, fuzzy);
    } catch { /* unreadable dir */ }
  }
  return null;
}

export function buildSmartStrategies({ kind = "auto", target = "", command = "", handlers }) {
  const k = String(kind || "auto").toLowerCase().trim();
  const tgt = String(target || "").trim();
  const cmd = String(command || tgt).trim();
  const candidate = tgt || cmd;

  // 1. Explicit "<app.exe> <filePath>" BEFORE looksLikeFilePath so "notepad.exe Desktop/note.txt" works.
  const appFileMatch = k !== "read_file" && k !== "find_file" && k !== "web" && k !== "search"
    ? candidate.match(/^([^\s"]+\.exe)\s+(.+)$/i)
    : null;
  if (appFileMatch && !/[|;&><`]|\$\(/.test(candidate)) {
    const exe = appFileMatch[1];
    const fileArg = appFileMatch[2].replace(/^["']|["']$/g, "");
    return [
      { name: "Launch app with resolved file path", run: () => handlers.openAppWithFile(exe, fileArg) },
      { name: "Direct process execution (no shell)", run: () => handlers.execAppWithFile ? handlers.execAppWithFile(exe, fileArg) : handlers.openAppWithFile(exe, fileArg) },
      { name: "Open file with Windows default app", run: () => handlers.openFileDefault(fileArg) },
      { name: "Fuzzy find & open in Desktop/Downloads/Documents", run: () => handlers.fuzzyOpenFile(fileArg) },
    ];
  }

  // 2. Bare domains & URLs BEFORE looksLikeFilePath so "google.com" opens in browser instead of Notepad.
  const looksLikeUrl =
    /^https?:\/\//i.test(candidate) ||
    (WEB_DOMAIN_RE.test(candidate) && !FILE_EXT_RE.test(candidate) && !/[\\ ]/.test(candidate));
  if (looksLikeUrl && k !== "read_file" && k !== "find_file" && k !== "command") {
    return [
      { name: "Open URL in browser", run: () => handlers.openUrl(candidate) },
    ];
  }

  // 3. File-path targets BEFORE open_app so "Desktop/Kahani.txt" opens as a file.
  const looksLikeFilePath = (
    /^(?:desktop|downloads?|documents?|pictures?|videos?|music|~|[a-z]:)[\\/]/i.test(candidate) ||
    (/\.[a-z0-9]{1,6}$/i.test(candidate) && !/\.exe$/i.test(candidate) && !/^https?:\/\//i.test(candidate))
  ) && !/[|;&><`]|\$\(/.test(candidate);
  if (looksLikeFilePath && k !== "read_file" && k !== "find_file" && k !== "command") {
    return [
      { name: "Open resolved file path", run: () => handlers.openFileDefault(candidate) },
      { name: "Fuzzy find & open in Desktop/Downloads/Documents", run: () => handlers.fuzzyOpenFile(candidate) },
      { name: "Launch in Notepad / default app", run: () => handlers.openAppWithFile("notepad.exe", candidate) },
      { name: "Read file contents as fallback", run: () => handlers.readFile(candidate) },
    ];
  }

  // 4. Application launch
  if (k === "open_app" || (!cmd.includes(" ") && !k.includes("command") && k === "auto" && tgt && !/[\\/]/.test(tgt))) {
    const appName = tgt || cmd;
    const safe = appName.replace(/[^a-z0-9 .\-_]/gi, "").trim();
    if (safe.length < 2) {
      return [
        { name: "Direct app launcher", run: () => handlers.openApp(appName) },
      ];
    }
    return [
      { name: "Direct app launcher", run: () => handlers.openApp(appName) },
      { name: "Windows Start Menu (Get-StartApps)", run: () => handlers.runPs(`$a = Get-StartApps | Where-Object { $_.Name -like '*${safe}*' } | Select-Object -First 1; if (-not $a) { throw 'Not in StartApps' }; Start-Process "shell:AppsFolder\\$($a.AppID)"; Write-Output $a.Name`) },
      { name: "Start Menu .lnk shortcut search", run: () => handlers.runPs(`$lnk = Get-ChildItem "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs","$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs" -Recurse -Filter "*${safe}*.lnk" -ErrorAction SilentlyContinue | Select-Object -First 1; if (-not $lnk) { throw 'No shortcut found' }; Start-Process $lnk.FullName; Write-Output $lnk.Name`) },
      { name: "Executable PATH / LocalAppData search", run: () => handlers.runPs(`$exe = (Get-Command '${safe}' -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if (-not $exe) { $exe = (Get-ChildItem "$env:LOCALAPPDATA\\Programs","$env:ProgramFiles" -Depth 2 -Filter "*${safe}*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }; if (-not $exe) { throw 'Executable not found' }; Start-Process $exe; Write-Output $exe`) },
    ];
  }

  // 5. Read / find file
  if (k === "read_file" || k === "find_file") {
    return [
      { name: "Direct path resolution", run: () => handlers.readFile(tgt) },
      { name: "Search Desktop / Downloads / Documents", run: () => handlers.findAndRead(tgt, false) },
      { name: "Fuzzy filename match in user folders", run: () => handlers.findAndRead(tgt, true) },
      { name: "Recursive glob search in project & user folders", run: () => handlers.globFind(tgt) },
    ];
  }

  // 6. Web / search (no duplicate ddgSearch strategy)
  if (k === "web" || k === "search") {
    return [
      { name: "Web search", run: () => handlers.webSearch(tgt) },
      { name: "Live news RSS fallback", run: () => handlers.newsSearch(tgt) },
      { name: "Open search in browser", run: () => handlers.openUrl(`https://www.google.com/search?q=${encodeURIComponent(tgt)}`) },
    ];
  }

  // 7. Resilient command execution
  const desktopDir = String(handlers?.desktopDir || "").trim();
  const quotedDesktopPs = desktopDir ? `'${desktopDir.replace(/'/g, "''")}'` : "";
  const fixedDesktopCmd = desktopDir
    ? cmd
        .replace(/(["']?)\$HOME[\\/]Desktop\1/gi, quotedDesktopPs)
        .replace(/(?<![\\/\w:])Desktop[\\/]([^\s"']+)/gi, (_m, rel) => `'${path.join(desktopDir, rel).replace(/'/g, "''")}'`)
    : cmd;

  return [
    { name: "PowerShell direct execution", run: () => handlers.runPs(cmd) },
    {
      name: "Resolved OneDrive/Desktop path PowerShell",
      run: () => (fixedDesktopCmd !== cmd
        ? handlers.runPs(fixedDesktopCmd)
        : Promise.resolve({ ok: false, error: "No path rewrite applicable" })),
    },
    { name: "Windows CMD shell (cmd.exe /c)", run: () => handlers.runCmd(cmd) },
  ];
}
