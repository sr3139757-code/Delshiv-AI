// Versioned Data Schema & Safe Migration Runner for Delshiv AI.
// Ensures future updates upgrade AppData files without data loss and moves any
// legacy install-folder data (logs, plain-text .env) into AppData cleanly.
import fs from "fs";
import path from "path";
import { atomicWriteJson, readJsonSafe } from "../../shared-utils.js";
import {
  APP_PATHS,
  CURRENT_SCHEMA_VERSION,
  INSTALL_ROOT,
  ensureAppDirectories,
} from "./appConfig.js";

function copyFileSafe(src, dest) {
  if (!fs.existsSync(src)) return false;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function mergeJsonlFiles(srcFile, destFile) {
  if (!fs.existsSync(srcFile)) return 0;
  const seen = new Set();
  const lines = [];
  for (const file of [destFile, srcFile]) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
  }
  const dir = path.dirname(destFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destFile, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  return lines.length;
}

function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirContents(s, d);
    } else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function createBackupSnapshot(paths, label) {
  const backupDir = path.join(paths.backups, `${label}-${Date.now()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const candidates = [
    paths.settings,
    paths.secrets,
    paths.legacyEnv,
    paths.schemaMeta,
    paths.memoriesJson,
    paths.notesTasks,
    paths.errorsLog,
    paths.healHistoryLog,
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      copyFileSafe(file, path.join(backupDir, path.basename(file)));
    }
  }
  return backupDir;
}

export function runAppMigrations({
  paths = APP_PATHS,
  installRoot = INSTALL_ROOT,
  secretsStore = null,
  appVersion = "4.0.0",
  onError = null,
} = {}) {
  ensureAppDirectories(paths);

  const meta = readJsonSafe(paths.schemaMeta, null) || {
    schemaVersion: 0,
    appVersion,
    history: [],
  };
  let currentVersion = Number(meta.schemaVersion) || 0;
  const applied = [];

  try {
    // Migration v0 -> v1: Move install-folder logs/ into AppData\logs\
    if (currentVersion < 1) {
      createBackupSnapshot(paths, "v0-to-v1");
      const legacyLogsDir = path.join(installRoot, "logs");
      if (fs.existsSync(legacyLogsDir) && path.resolve(legacyLogsDir) !== path.resolve(paths.logsDir)) {
        mergeJsonlFiles(path.join(legacyLogsDir, "errors.jsonl"), paths.errorsLog);
        mergeJsonlFiles(path.join(legacyLogsDir, "heal-history.jsonl"), paths.healHistoryLog);
        copyDirContents(path.join(legacyLogsDir, "reports"), paths.healReportsDir);
        copyDirContents(path.join(legacyLogsDir, "snapshots"), paths.healSnapshotsDir);
        try {
          fs.rmSync(legacyLogsDir, { recursive: true, force: true });
        } catch { /* non-fatal if file locked */ }
      }
      currentVersion = 1;
      applied.push({ version: 1, at: new Date().toISOString(), note: "Moved logs/ to AppData" });
    }

    // Migration v1 -> v2: Encrypt .env API keys into AppData secrets.json & initialize versioned settings.json
    if (currentVersion < 2) {
      createBackupSnapshot(paths, "v1-to-v2");
      const installEnv = path.join(installRoot, ".env");

      if (secretsStore) {
        secretsStore.importFromEnvFile(paths.legacyEnv);
        secretsStore.importFromEnvFile(installEnv);
        secretsStore.upgradeEncryption();

        // Remove plain-text .env from install folder once encrypted in AppData
        if (fs.existsSync(installEnv) && secretsStore.canEncrypt()) {
          try { fs.unlinkSync(installEnv); } catch { /* non-fatal */ }
        }
        // Remove plain-text .env from AppData once encrypted in secrets.json
        if (fs.existsSync(paths.legacyEnv) && secretsStore.canEncrypt()) {
          try { fs.unlinkSync(paths.legacyEnv); } catch { /* non-fatal */ }
        }
      }

      const existingSettings = readJsonSafe(paths.settings, null);
      if (!existingSettings || typeof existingSettings !== "object") {
        atomicWriteJson(paths.settings, {
          _schemaVersion: 2,
          updatedAt: new Date().toISOString(),
          user: null,
          prefs: null,
          theme: null,
        });
      } else if ((Number(existingSettings._schemaVersion) || 0) < 2) {
        atomicWriteJson(paths.settings, {
          ...existingSettings,
          _schemaVersion: 2,
          updatedAt: new Date().toISOString(),
        });
      }

      currentVersion = 2;
      applied.push({ version: 2, at: new Date().toISOString(), note: "Encrypted secrets.json + versioned settings.json" });
    }

    // Always ensure any newly introduced install-folder .env is imported & scrubbed if safeStorage is active
    if (secretsStore && secretsStore.canEncrypt()) {
      const installEnv = path.join(installRoot, ".env");
      if (fs.existsSync(installEnv)) {
        secretsStore.importFromEnvFile(installEnv);
        try { fs.unlinkSync(installEnv); } catch { /* non-fatal */ }
      }
      secretsStore.upgradeEncryption();
    }

    if (applied.length > 0 || !fs.existsSync(paths.schemaMeta)) {
      atomicWriteJson(paths.schemaMeta, {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appVersion,
        updatedAt: new Date().toISOString(),
        history: [...(Array.isArray(meta.history) ? meta.history : []), ...applied].slice(-25),
      });
    }

    return { ok: true, schemaVersion: CURRENT_SCHEMA_VERSION, applied };
  } catch (err) {
    if (typeof onError === "function") onError("runAppMigrations", err);
    return { ok: false, schemaVersion: currentVersion, error: err?.message || String(err) };
  }
}
