// Window manager & mouse/keyboard automation for Delshiv AI (Windows PowerShell + Win32 user32.dll).
import { runPowerShell } from "./shared-utils.js";

const VALID_WINDOW_OPS = new Set([
  "list", "focus", "activate", "minimize", "maximize", "restore", "snap_left", "snap_right", "close",
]);

const WIN32_TYPE = `
Add-Type -AssemblyName System.Windows.Forms
if (-not ([System.Management.Automation.PSTypeName]'DelshivWin32').Type) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DelshivWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
"@
}`;

export async function listWindows() {
  const ps = `Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle, @{N='Handle';E={$_.MainWindowHandle.ToInt64()}} | ConvertTo-Json -Compress`;
  const raw = await runPowerShell(ps, { timeout: 10000 });
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function manageWindows({ operation = "list", target = "" } = {}) {
  const op = String(operation || "list").toLowerCase().trim();
  if (!VALID_WINDOW_OPS.has(op)) {
    throw new Error(`Unsupported window operation '${op}'. Valid: ${[...VALID_WINDOW_OPS].join(", ")}.`);
  }
  if (op === "list") {
    const windows = await listWindows();
    return { ok: true, action: "manageWindows (list)", windows, message: windows.length ? `${windows.length} open window(s).` : "No titled windows found." };
  }
  const q = String(target || "").trim();
  if (!q) throw new Error(`Window target (app/title) is required for "${op}".`);
  const safeQ = q.replace(/'/g, "''");

  const ps = `${WIN32_TYPE}
$q = '${safeQ}'
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' -and ($_.MainWindowTitle -like "*$q*" -or $_.ProcessName -like "*$q*") } | Select-Object -First 1
if (-not $proc) { throw "No open window matching '$q'." }
$h = $proc.MainWindowHandle
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
switch ('${op}') {
  'focus'      { [DelshivWin32]::ShowWindow($h, 9) | Out-Null; [DelshivWin32]::SetForegroundWindow($h) | Out-Null }
  'activate'   { [DelshivWin32]::ShowWindow($h, 9) | Out-Null; [DelshivWin32]::SetForegroundWindow($h) | Out-Null }
  'minimize'   { [DelshivWin32]::ShowWindow($h, 6) | Out-Null }
  'maximize'   { [DelshivWin32]::ShowWindow($h, 3) | Out-Null }
  'restore'    { [DelshivWin32]::ShowWindow($h, 9) | Out-Null }
  'snap_left'  { [DelshivWin32]::ShowWindow($h, 9) | Out-Null; [DelshivWin32]::MoveWindow($h, $wa.X, $wa.Y, [int]($wa.Width/2), $wa.Height, $true) | Out-Null; [DelshivWin32]::SetForegroundWindow($h) | Out-Null }
  'snap_right' { [DelshivWin32]::ShowWindow($h, 9) | Out-Null; [DelshivWin32]::MoveWindow($h, $wa.X + [int]($wa.Width/2), $wa.Y, [int]($wa.Width/2), $wa.Height, $true) | Out-Null; [DelshivWin32]::SetForegroundWindow($h) | Out-Null }
  'close'      { [DelshivWin32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
}
@{ title = $proc.MainWindowTitle; process = $proc.ProcessName; op = '${op}' } | ConvertTo-Json -Compress`;

  const out = JSON.parse(await runPowerShell(ps, { timeout: 10000 }));
  return { ok: true, action: `manageWindows (${op})`, window: out, message: `${op}: "${out.title}" (${out.process}).` };
}

function toSendKeysCombo(keys) {
  const parts = String(keys || "").toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("keys is required (e.g. 'ctrl+c', 'alt+tab', 'enter').");
  const modMap = { ctrl: "^", control: "^", alt: "%", shift: "+" };
  const keyMap = {
    enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}",
    backspace: "{BACKSPACE}", delete: "{DELETE}", del: "{DELETE}", space: " ",
    insert: "{INSERT}", ins: "{INSERT}",
    pageup: "{PGUP}", pgup: "{PGUP}", pagedown: "{PGDN}", pgdn: "{PGDN}",
    up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}", home: "{HOME}", end: "{END}",
    capslock: "{CAPSLOCK}", numlock: "{NUMLOCK}", prtsc: "{PRTSC}", printscreen: "{PRTSC}",
    plus: "{+}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
    f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
  };
  let mods = "";
  const main = [];
  for (const p of parts) {
    if (p === "win" || p === "windows" || p === "super" || p === "meta") {
      throw new Error(`Modifier "${p}" is not supported by Windows SendKeys.`);
    }
    if (modMap[p]) mods += modMap[p];
    else if (keyMap[p]) main.push(keyMap[p]);
    else if (p.length === 1) main.push(/[+^%~(){}[\]]/.test(p) ? `{${p}}` : p);
    else main.push(`{${p.toUpperCase()}}`);
  }
  if (!main.length) throw new Error(`Invalid hotkey "${keys}".`);
  return mods + main.join("");
}

function escapeSendKeysText(text) {
  return String(text || "")
    .replace(/([+^%~(){}[\]])/g, "{$1}")
    .replace(/\r?\n/g, "{ENTER}");
}

export async function automateInput({ operation, x, y, button = "left", text = "", keys = "" } = {}) {
  const op = String(operation || "").toLowerCase().trim();
  if (op === "move" || op === "click" || op === "double_click") {
    const nx = Math.round(Number(x));
    const ny = Math.round(Number(y));
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < -16000 || nx > 16000 || ny < -16000 || ny > 16000) {
      throw new Error("Valid finite screen coordinates (x, y) within -16000..16000 are required.");
    }
    const isRight = String(button).toLowerCase() === "right";
    const downFlag = isRight ? "0x0008" : "0x0002";
    const upFlag = isRight ? "0x0010" : "0x0004";
    const clickCode = op === "move"
      ? ""
      : op === "double_click"
        ? `[DelshivWin32]::mouse_event(${downFlag},0,0,0,0); [DelshivWin32]::mouse_event(${upFlag},0,0,0,0); Start-Sleep -Milliseconds 60; [DelshivWin32]::mouse_event(${downFlag},0,0,0,0); [DelshivWin32]::mouse_event(${upFlag},0,0,0,0)`
        : `[DelshivWin32]::mouse_event(${downFlag},0,0,0,0); [DelshivWin32]::mouse_event(${upFlag},0,0,0,0)`;
    await runPowerShell(`${WIN32_TYPE}\n[DelshivWin32]::SetCursorPos(${nx}, ${ny}) | Out-Null\n${clickCode}`, { timeout: 10000 });
    return { ok: true, action: `automateInput (${op})`, message: `${op} at (${nx}, ${ny})${op !== "move" ? ` [${button}]` : ""}.` };
  }
  if (op === "type") {
    const raw = String(text || "");
    if (!raw) throw new Error("text is required for type.");
    const escaped = escapeSendKeysText(raw).replace(/'/g, "''");
    await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`, { timeout: 10000 });
    return { ok: true, action: "automateInput (type)", message: `Typed ${raw.length} character(s).` };
  }
  if (op === "hotkey") {
    const combo = toSendKeysCombo(keys).replace(/'/g, "''");
    await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${combo}')`, { timeout: 10000 });
    return { ok: true, action: "automateInput (hotkey)", message: `Sent hotkey: ${keys}` };
  }
  throw new Error(`Unsupported automateInput operation "${op}". Valid: move, click, double_click, type, hotkey.`);
}
