// Centralized AppData Configuration & Paths for Delshiv AI.
// All user data (memory, chat DB, settings, logs, healing reports, encrypted secrets)
// is stored under Windows %APPDATA%\delshiv-ai rather than the install directory.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ID = "delshiv-ai";
export const CURRENT_SCHEMA_VERSION = 2;
export const INSTALL_ROOT = path.resolve(__dirname, "..", "..");

export function getUserDataDir() {
  const override = String(process.env.DELSHIV_DATA_DIR || "").trim();
  if (override) return path.resolve(override);
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  return path.join(base, APP_ID);
}

export function buildAppPaths(baseDir = getUserDataDir()) {
  const root = path.resolve(baseDir);
  const logsDir = path.join(root, "logs");
  return {
    root,
    backups: path.join(root, "backups"),
    logsDir,
    errorsLog: path.join(logsDir, "errors.jsonl"),
    healHistoryLog: path.join(logsDir, "heal-history.jsonl"),
    healReportsDir: path.join(logsDir, "reports"),
    healSnapshotsDir: path.join(logsDir, "snapshots"),
    toolActivityLog: path.join(root, "tool_activity.jsonl"),
    commandLog: path.join(root, "command_log.jsonl"),
    memoryDb: path.join(root, "delshiv_memory.db"),
    memoriesJson: path.join(root, "memories.json"),
    notesTasks: path.join(root, "notes_tasks.json"),
    macros: path.join(root, "macros.json"),
    rules: path.join(root, "rules.json"),
    scheduledTasks: path.join(root, "scheduled_tasks.json"),
    behaviorProfile: path.join(root, "behavior_profile.json"),
    offlineQueue: path.join(root, "offline_queue.json"),
    aliases: path.join(root, "aliases.json"),
    clipboardHistory: path.join(root, "clipboard_history.json"),
    focusSession: path.join(root, "focus_session.json"),
    authSession: path.join(root, "auth_session.json"),
    pinLock: path.join(root, "pin_lock.json"),
    settings: path.join(root, "settings.json"),
    secrets: path.join(root, "secrets.json"),
    schemaMeta: path.join(root, "schema_meta.json"),
    legacyEnv: path.join(root, ".env"),
    reportsDir: path.join(root, "reports"),
    pluginsDir: path.join(root, "plugins"),
    legacyMemoryFlag: path.join(root, "legacy_memory_migrated.flag"),
  };
}

export const APP_PATHS = buildAppPaths();

export function ensureAppDirectories(paths = APP_PATHS) {
  const dirs = [
    paths.root,
    paths.backups,
    paths.logsDir,
    paths.healReportsDir,
    paths.healSnapshotsDir,
    paths.reportsDir,
    paths.pluginsDir,
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
