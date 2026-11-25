// Safe Windows Junk & Temp Cleaner for Delshiv AI.
// Scans and cleans temporary/cache/dump folders and Recycle Bin asynchronously; skips locked files gracefully.
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const MIN_AGE_MS = 60 * 60 * 1000; // skip temp files modified in the last 1 hour (active apps)

function getJunkTargets({ includeWindowsUpdate = false } = {}) {
  const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const winDir = process.env.WINDIR || "C:\\Windows";
  const list = [
    { name: "User Temp", dir: os.tmpdir(), pruneEmptyDirs: true },
    { name: "Local CrashDumps", dir: path.join(localApp, "CrashDumps"), pruneEmptyDirs: false },
    { name: "Windows Temp", dir: path.join(winDir, "Temp"), pruneEmptyDirs: false },
  ];
  if (includeWindowsUpdate) {
    list.push({ name: "Windows Update Cache", dir: path.join(winDir, "SoftwareDistribution", "Download"), pruneEmptyDirs: false });
  }
  return list.filter((t, i, arr) => t.dir && arr.findIndex((x) => path.resolve(x.dir).toLowerCase() === path.resolve(t.dir).toLowerCase()) === i);
}

async function walkFilesAsync(dir, out = [], dirs = [], depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return { files: out, dirs };
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { files: out, dirs };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkFilesAsync(full, out, dirs, depth + 1);
      dirs.push(full);
    } else if (e.isFile()) {
      try {
        const st = await fs.promises.stat(full);
        if (Date.now() - st.mtimeMs >= MIN_AGE_MS) {
          out.push({ path: full, size: st.size });
        }
      } catch { /* ignore */ }
    }
  }
  return { files: out, dirs };
}

function getRecycleBinStats() {
  return new Promise((resolve) => {
    const ps = `$rb = (New-Object -ComObject Shell.Application).NameSpace(10).Items(); $c = 0; $b = 0; foreach($i in $rb){ $c++; $b += [int64]$i.Size }; @{ count=$c; bytes=$b } | ConvertTo-Json -Compress`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve({ count: 0, bytes: 0 });
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ count: 0, bytes: 0 }); }
    });
  });
}

function emptyRecycleBin() {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"], { timeout: 15000, windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

export async function scanJunkFiles({ includeWindowsUpdate = false } = {}) {
  const breakdown = [];
  let totalFiles = 0;
  let totalBytes = 0;

  for (const t of getJunkTargets({ includeWindowsUpdate })) {
    const { files } = await walkFilesAsync(t.dir);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    totalFiles += files.length;
    totalBytes += bytes;
    breakdown.push({ name: t.name, dir: t.dir, files: files.length, mb: +(bytes / 1048576).toFixed(2) });
  }

  const rb = await getRecycleBinStats();
  totalFiles += Number(rb.count || 0);
  totalBytes += Number(rb.bytes || 0);
  breakdown.push({ name: "Recycle Bin", dir: "Shell:RecycleBin", files: Number(rb.count || 0), mb: +((Number(rb.bytes || 0)) / 1048576).toFixed(2) });

  return {
    ok: true,
    totalFiles,
    totalMB: +(totalBytes / 1048576).toFixed(2),
    breakdown,
    message: `Found ${totalFiles} junk file(s) (~${(totalBytes / 1048576).toFixed(2)} MB) across temp folders and Recycle Bin.`,
  };
}

export async function cleanJunkFiles({ includeRecycleBin = true, includeWindowsUpdate = false } = {}) {
  let deletedFiles = 0;
  let freedBytes = 0;
  let skippedLocked = 0;
  const details = [];

  for (const t of getJunkTargets({ includeWindowsUpdate })) {
    const { files, dirs } = await walkFilesAsync(t.dir);
    let dirDeleted = 0;
    let dirBytes = 0;
    for (const f of files) {
      try {
        await fs.promises.unlink(f.path);
        deletedFiles++;
        freedBytes += f.size;
        dirDeleted++;
        dirBytes += f.size;
      } catch {
        skippedLocked++;
      }
    }
    if (t.pruneEmptyDirs) {
      for (const d of dirs) {
        try {
          const rest = await fs.promises.readdir(d);
          if (!rest.length) await fs.promises.rmdir(d);
        } catch { /* ignore */ }
      }
    }
    details.push({ name: t.name, deleted: dirDeleted, mb: +(dirBytes / 1048576).toFixed(2) });
  }

  if (includeRecycleBin) {
    const before = await getRecycleBinStats();
    if (before.count > 0) {
      await emptyRecycleBin();
      const after = await getRecycleBinStats();
      const rbDeleted = Math.max(0, Number(before.count || 0) - Number(after.count || 0));
      const rbFreed = Math.max(0, Number(before.bytes || 0) - Number(after.bytes || 0));
      deletedFiles += rbDeleted;
      freedBytes += rbFreed;
      details.push({ name: "Recycle Bin", deleted: rbDeleted, mb: +(rbFreed / 1048576).toFixed(2) });
    }
  }

  const freedMB = +(freedBytes / 1048576).toFixed(2);
  return {
    ok: true,
    deletedFiles,
    freedMB,
    skippedLocked,
    details,
    message: `Cleaned ${deletedFiles} junk file(s), freed ${freedMB} MB${skippedLocked ? ` (${skippedLocked} in-use file(s) skipped safely)` : ""}.`,
  };
}
