// System Health & Network/Port Inspector for Delshiv AI (Windows PowerShell + Node os).
import os from "os";
import { runPowerShell } from "./shared-utils.js";

const CRITICAL_PROCESSES = new Set([
  "system", "idle", "csrss", "wininit", "winlogon", "lsass", "smss", "services", "svchost", "dwm", "explorer", "electron",
]);

const HEALTH_CACHE_TTL_MS = 5000;
let prevCpuTotals = null;
let inFlightSummary = null;
let cachedSummary = null;
let cachedSummaryAt = 0;
let lastKnownExtras = { disks: [], battery: null, topProcesses: [] };

function readCpuTotals() {
  const cpus = os.cpus();
  if (!cpus || !cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

async function sampleCpuPercent() {
  const first = prevCpuTotals || readCpuTotals();
  if (!first) return null;
  let second;
  if (prevCpuTotals) {
    second = readCpuTotals();
  } else {
    await new Promise((r) => setTimeout(r, 120));
    second = readCpuTotals();
  }
  if (!second) return null;
  prevCpuTotals = second;
  const totalDiff = second.total - first.total;
  const idleDiff = second.idle - first.idle;
  if (totalDiff <= 0) return cachedSummary?.cpuPercent ?? 0;
  return Math.min(100, Math.max(0, Math.round(((totalDiff - idleDiff) / totalDiff) * 100)));
}

function getLiveRamAndUptime() {
  const totalRamGb = +(os.totalmem() / 1073741824).toFixed(2);
  const freeRamGb = +(os.freemem() / 1073741824).toFixed(2);
  const usedRamGb = +(totalRamGb - freeRamGb).toFixed(2);
  const ramPct = Math.round((usedRamGb / Math.max(0.1, totalRamGb)) * 100);
  return {
    ram: { usedGb: usedRamGb, freeGb: freeRamGb, totalGb: totalRamGb, usedPercent: ramPct },
    uptimeHours: +(os.uptime() / 3600).toFixed(1),
  };
}

export async function getSystemHealthSummary() {
  const now = Date.now();
  if (cachedSummary && now - cachedSummaryAt < HEALTH_CACHE_TTL_MS) {
    const { ram, uptimeHours } = getLiveRamAndUptime();
    return { ...cachedSummary, ram, uptimeHours };
  }
  if (inFlightSummary) return await inFlightSummary;

  inFlightSummary = (async () => {
    const cpuPromise = sampleCpuPercent();
    const ps = `
$disks = try {
  @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object {
    @{ DeviceID = $_.Name.TrimEnd('\\'); FreeGB = [math]::Round($_.AvailableFreeSpace/1GB, 2); TotalGB = [math]::Round($_.TotalSize/1GB, 2) }
  })
} catch { @() }
$bat = try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  $p = [System.Windows.Forms.SystemInformation]::PowerStatus
  if (($p.BatteryChargeStatus -band 128) -ne 0) { $null } else {
    @{ percent = [math]::Round($p.BatteryLifePercent * 100); charging = ($p.PowerLineStatus -eq 'Online' -or (($p.BatteryChargeStatus -band 8) -ne 0)) }
  }
} catch { $null }
$procs = try {
  @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 ProcessName, Id, @{N='RamMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N='CpuSec';E={[math]::Round($_.CPU,1)}})
} catch { @() }
@{ disks = $disks; battery = $bat; topProcesses = $procs } | ConvertTo-Json -Depth 4 -Compress`;

    let extras = lastKnownExtras;
    try {
      const raw = await runPowerShell(ps, { timeout: 15000 });
      const info = raw ? JSON.parse(raw) : {};
      const disks = (Array.isArray(info.disks) ? info.disks : info.disks ? [info.disks] : [])
        .filter((d) => d && typeof d === "object" && d.DeviceID);
      const battery = info.battery && typeof info.battery === "object" && info.battery.percent !== undefined
        ? { percent: Number(info.battery.percent), charging: Boolean(info.battery.charging) }
        : null;
      const topProcesses = (Array.isArray(info.topProcesses) ? info.topProcesses : [])
        .filter((p) => p && typeof p === "object");
      extras = { disks, battery, topProcesses };
      lastKnownExtras = extras;
    } catch {
      // Fall back gracefully to live Node CPU/RAM + last known disks/battery/processes on transient PS delay.
    }

    const cpuPercent = await cpuPromise;
    const { ram, uptimeHours } = getLiveRamAndUptime();
    const result = {
      cpuPercent,
      ram,
      disks: extras.disks,
      battery: extras.battery,
      topProcesses: extras.topProcesses,
      uptimeHours,
    };
    cachedSummary = result;
    cachedSummaryAt = Date.now();
    return result;
  })().finally(() => {
    inFlightSummary = null;
  });

  return await inFlightSummary;
}

export async function listProcesses(limit = 15) {
  const n = Math.min(40, Math.max(1, Math.floor(Number(limit) || 15)));
  const raw = await runPowerShell(
    `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${n} ProcessName, Id, @{N='RamMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N='CpuSec';E={[math]::Round($_.CPU,1)}} | ConvertTo-Json -Compress`,
    { timeout: 10000 }
  );
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function killProcess({ pid, processName } = {}) {
  const hasPid = pid !== undefined && pid !== null && String(pid).trim() !== "";
  if (hasPid) {
    const numPid = Number(pid);
    if (!Number.isInteger(numPid) || numPid <= 4) {
      throw new Error("Invalid or protected system PID.");
    }
    if (numPid === process.pid) {
      throw new Error("Refusing to terminate the Delshiv AI process itself.");
    }
    const checkPs = `$p = Get-Process -Id ${numPid} -ErrorAction Stop; $p.ProcessName`;
    const pname = (await runPowerShell(checkPs, { timeout: 5000 })).trim().toLowerCase();
    if (CRITICAL_PROCESSES.has(pname)) {
      throw new Error(`Refusing to terminate critical Windows process "${pname}" (PID ${numPid}).`);
    }
    await runPowerShell(`Stop-Process -Id ${numPid} -Force`, { timeout: 10000 });
    return { killed: `PID ${numPid}` };
  }
  const name = String(processName || "").trim().replace(/\.exe$/i, "");
  if (!name || !/^[\w .\-]+$/.test(name)) throw new Error("Provide a valid pid or processName.");
  if (CRITICAL_PROCESSES.has(name.toLowerCase())) {
    throw new Error(`Refusing to terminate critical Windows process "${name}".`);
  }
  await runPowerShell(`Stop-Process -Name '${name.replace(/'/g, "''")}' -Force`, { timeout: 10000 });
  return { killed: name };
}

export async function listListeningPorts(portFilter = null) {
  let filterClause = "";
  if (portFilter !== null && portFilter !== undefined && String(portFilter).trim() !== "") {
    const pf = Number(portFilter);
    if (!Number.isInteger(pf) || pf < 1 || pf > 65535) {
      throw new Error("Valid TCP port filter (1-65535) is required.");
    }
    filterClause = `| Where-Object { $_.LocalPort -eq ${pf} }`;
  }
  const ps = `
$procs = @{}
Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName }
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue ${filterClause} |
  Select-Object LocalAddress, LocalPort, OwningProcess, @{N='ProcessName';E={$procs[$_.OwningProcess]}} |
  Sort-Object LocalPort | Select-Object -First 30 | ConvertTo-Json -Compress`;
  const raw = await runPowerShell(ps, { timeout: 10000 });
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function freePort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("Valid TCP port (1-65535) is required.");
  const conns = await listListeningPorts(p);
  if (!conns.length) throw new Error(`No process is listening on port ${p}.`);
  const pids = [...new Set(conns.map((c) => c.OwningProcess).filter((id) => Number.isInteger(id) && id > 4 && id !== process.pid))];
  if (!pids.length) throw new Error(`Port ${p} is owned by a protected system process.`);
  for (const id of pids) {
    await killProcess({ pid: id });
  }
  return { port: p, killedPids: pids };
}

export async function pingHost(host = "8.8.8.8") {
  const clean = String(host || "8.8.8.8").trim();
  if (!/^[a-zA-Z0-9.-]{1,120}$/.test(clean)) throw new Error("Invalid host name or IP.");
  const ps = `Test-Connection -ComputerName '${clean}' -Count 2 -ErrorAction Stop | Measure-Object -Property ResponseTime -Average | Select-Object Count, @{N='AvgMs';E={[math]::Round($_.Average,1)}} | ConvertTo-Json -Compress`;
  const raw = await runPowerShell(ps, { timeout: 10000 });
  const res = JSON.parse(raw);
  return { host: clean, reachable: true, avgMs: res.AvgMs };
}
