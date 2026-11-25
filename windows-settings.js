// Non-admin Windows Settings controller for Delshiv AI (Bluetooth, Wi-Fi, Brightness, Dark Mode, Power Plan, ms-settings).
import { runPowerShell } from "./shared-utils.js";

const VALID_RADIO_KINDS = new Set(["Bluetooth", "WiFi"]);

const WINRT_RADIO_PS = (kind, on) => `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]
$null = [Windows.Devices.Radios.RadioAccessStatus, Windows.System.Devices, ContentType=WindowsRuntime]
$null = [Windows.Devices.Radios.RadioState, Windows.System.Devices, ContentType=WindowsRuntime]
$null = [Windows.Devices.Radios.RadioKind, Windows.System.Devices, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
if ($access -ne [Windows.Devices.Radios.RadioAccessStatus]::Allowed) {
  throw "Radio access status: $access"
}
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$target = $radios | Where-Object { $_.Kind -eq [Windows.Devices.Radios.RadioKind]::${kind} } | Select-Object -First 1
if (-not $target) { throw "No ${kind} radio adapter found on this PC." }
$state = [Windows.Devices.Radios.RadioState]::${on ? "On" : "Off"}
$res = Await ($target.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
if ($res -ne [Windows.Devices.Radios.RadioAccessStatus]::Allowed) { throw "Could not change ${kind} state: $res" }
"${kind} turned ${on ? "ON" : "OFF"}"`;

export async function setRadioState(kind, enable, openExternal) {
  if (!VALID_RADIO_KINDS.has(kind)) {
    throw new Error(`Unsupported radio kind "${kind}". Valid: Bluetooth, WiFi.`);
  }
  try {
    const msg = await runPowerShell(WINRT_RADIO_PS(kind, Boolean(enable)), { timeout: 12000 });
    return { ok: true, message: msg };
  } catch (err) {
    const uri = kind === "Bluetooth" ? "ms-settings:bluetooth" : "ms-settings:network-wifi";
    if (typeof openExternal === "function") {
      try { await openExternal(uri); } catch { /* ignore */ }
    }
    throw new Error(`${err.message} (Opened Windows ${kind} Settings so you can toggle it directly.)`);
  }
}

export async function setBrightness(levelOrDelta, isDelta = false) {
  const num = Number(levelOrDelta);
  if (!Number.isFinite(num)) {
    throw new Error("Brightness value must be a valid number (0-100).");
  }
  const rounded = Math.round(num);
  const ps = isDelta
    ? `
$cur = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness
$next = [math]::Max(0, [math]::Min(100, $cur + (${rounded})))
(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1).WmiSetBrightness(1, $next) | Out-Null
$next`
    : `
$val = [math]::Max(0, [math]::Min(100, ${rounded}))
(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1).WmiSetBrightness(1, $val) | Out-Null
$val`;
  try {
    const val = await runPowerShell(ps, { timeout: 12000 });
    return { ok: true, brightness: Number(val), message: `Screen brightness set to ${val}%.` };
  } catch (err) {
    if (/NotSupported|Invalid class|null-valued expression/i.test(err?.message || "")) {
      throw new Error("Brightness control via WMI is not supported on this display (external monitors use physical OSD buttons).");
    }
    throw err;
  }
}

export async function setDarkMode(enable) {
  const val = enable ? 0 : 1; // 0 = Dark, 1 = Light
  const ps = `
$p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
Set-ItemProperty -Path $p -Name AppsUseLightTheme -Value ${val} -Type DWord
Set-ItemProperty -Path $p -Name SystemUsesLightTheme -Value ${val} -Type DWord
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DelshivThemeBroadcast {
  [DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@
$res = [UIntPtr]::Zero
[DelshivThemeBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "ImmersiveColorSet", 2, 1000, [ref]$res) | Out-Null`;
  await runPowerShell(ps, { timeout: 12000 });
  return { ok: true, darkMode: Boolean(enable), message: `Windows theme set to ${enable ? "Dark Mode" : "Light Mode"}.` };
}

const POWER_GUIDS = {
  balanced: "381b4222-f694-41f0-9685-ff5bb260df2e",
  power_saver: "a1841308-3541-4fab-bc81-f71556f20b4a",
  high_performance: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c",
};

export async function setPowerPlan(plan) {
  const guid = POWER_GUIDS[plan];
  if (!guid) throw new Error(`Unknown power plan "${plan}".`);
  try {
    await runPowerShell(`powercfg /setactive ${guid}`, { timeout: 12000 });
    return { ok: true, message: `Power plan switched to ${plan.replace("_", " ")}.` };
  } catch (err) {
    throw new Error(`Could not switch power plan (${err.message}). Windows Modern Standby PCs often lock classic power schemes.`);
  }
}

export const SETTINGS_URIS = {
  bluetooth: "ms-settings:bluetooth",
  wifi: "ms-settings:network-wifi",
  airplane: "ms-settings:network-airplanemode",
  hotspot: "ms-settings:network-mobilehotspot",
  display: "ms-settings:display",
  nightlight: "ms-settings:nightlight",
  sound: "ms-settings:sound",
  batterysaver: "ms-settings:batterysaver",
  battery: "ms-settings:batterysaver",
  personalization: "ms-settings:personalization",
  privacy: "ms-settings:privacy",
  windowsupdate: "ms-settings:windowsupdate",
  update: "ms-settings:windowsupdate",
  apps: "ms-settings:appsfeatures",
  storage: "ms-settings:storagesense",
  main: "ms-settings:",
};
