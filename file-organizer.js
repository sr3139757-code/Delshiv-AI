// File organizer for Delshiv AI: scan → plan → apply (non-destructive moves) → multi-run undo.
// Never deletes and never overwrites: conflicts get a numeric suffix; duplicates are moved, not removed.
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isProtectedPath } from "./safety-guard.js";
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";

const CATEGORIES = {
  Images: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".heic", ".ico", ".tiff"],
  Documents: [".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".ppt", ".pptx", ".md", ".epub"],
  Spreadsheets: [".xls", ".xlsx", ".csv", ".ods"],
  Videos: [".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"],
  Audio: [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"],
  Archives: [".zip", ".rar", ".7z", ".tar", ".gz"],
  Installers: [".exe", ".msi", ".msix", ".apk", ".iso"],
  Code: [".js", ".ts", ".py", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".html", ".css", ".json", ".xml", ".sql", ".ps1", ".bat", ".sh"],
};
const EXT_TO_CAT = new Map(Object.entries(CATEGORIES).flatMap(([cat, exts]) => exts.map((e) => [e, cat])));
const IN_PROGRESS = /\.(crdownload|part|tmp|download|partial)$/i;
const MIN_AGE_MS = 60_000;
const MAX_FILES = 5000;

export function categoryOf(fileName) {
  return EXT_TO_CAT.get(path.extname(fileName).toLowerCase()) || "Other";
}

export function resolveTargetDir(input, specialDirs = {}) {
  const raw = String(input || "").trim().replace(/^["']|["']$/g, "");
  const home = os.homedir();
  const pick = (key, fallbackFolder) => specialDirs[key] || specialDirs[fallbackFolder] || path.join(home, fallbackFolder);
  const alias = {
    desktop: pick("desktop", "Desktop"),
    downloads: pick("downloads", "Downloads"),
    download: pick("downloads", "Downloads"),
    documents: pick("documents", "Documents"),
    document: pick("documents", "Documents"),
    pictures: pick("pictures", "Pictures"),
    picture: pick("pictures", "Pictures"),
    videos: pick("videos", "Videos"),
    video: pick("videos", "Videos"),
    music: pick("music", "Music"),
  };
  const dir = alias[raw.toLowerCase()] || (raw ? path.resolve(raw) : alias.downloads);
  if (isProtectedPath(dir)) throw new Error(`Refusing to organise protected location: ${dir}`);
  if (path.resolve(dir).toLowerCase() === path.resolve(home).toLowerCase()) {
    throw new Error("Refusing to organise the whole home folder. Pick a specific folder (e.g. Downloads).");
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  return dir;
}

function topLevelFiles(dir, now = Date.now()) {
  const out = [];
  let skipped = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (out.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    try {
      const st = fs.statSync(full);
      if (IN_PROGRESS.test(e.name) || now - st.mtimeMs < MIN_AGE_MS || e.name.startsWith(".") || e.name === "desktop.ini") {
        skipped++;
        continue;
      }
      out.push({ name: e.name, full, size: st.size });
    } catch { skipped++; }
  }
  return { files: out, skipped };
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

export async function findDuplicates(dir) {
  const { files } = topLevelFiles(dir);
  const bySize = new Map();
  for (const f of files) {
    if (f.size === 0) continue;
    (bySize.get(f.size) || bySize.set(f.size, []).get(f.size)).push(f);
  }
  const groups = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map();
    for (const f of same) {
      try {
        const h = await sha256(f.full);
        (byHash.get(h) || byHash.set(h, []).get(h)).push(f);
      } catch { /* unreadable file: ignore */ }
    }
    for (const g of byHash.values()) if (g.length > 1) groups.push(g);
  }
  return groups.map((g) => {
    const sorted = g.slice().sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return { keep: sorted[0].name, duplicates: sorted.slice(1).map((f) => f.name), size: sorted[0].size };
  });
}

export function planOrganize(dir) {
  const { files, skipped } = topLevelFiles(dir);
  const moves = files.map((f) => ({ file: f.name, category: categoryOf(f.name) }));
  const summary = {};
  for (const m of moves) summary[m.category] = (summary[m.category] || 0) + 1;
  return { dir, moves, skipped, summary };
}

function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function moveFileSync(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err?.code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return;
    }
    throw err;
  }
}

const manifestPath = (dir) => path.join(dir, ".delshiv-organize-undo.json");

function isInsideDir(baseDir, candidatePath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(candidatePath));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function applyOrganize(dir, { moveDuplicates = [] } = {}) {
  const plan = planOrganize(dir);
  const dupSet = new Set(moveDuplicates);
  const done = [];
  const errors = [];
  const actualSummary = {};

  for (const m of plan.moves) {
    const from = path.join(dir, m.file);
    const targetFolder = dupSet.has(m.file) ? "Duplicates" : m.category;
    try {
      const destDir = path.join(dir, targetFolder);
      fs.mkdirSync(destDir, { recursive: true });
      const to = uniqueDest(destDir, m.file);
      moveFileSync(from, to);
      done.push({ from, to });
      actualSummary[targetFolder] = (actualSummary[targetFolder] || 0) + 1;
    } catch (err) {
      errors.push({ file: m.file, error: err.message });
    }
  }

  if (done.length) {
    const mp = manifestPath(dir);
    const prev = readJsonSafe(mp, null);
    const prevRuns = Array.isArray(prev?.runs)
      ? prev.runs
      : Array.isArray(prev?.moves)
        ? [{ at: prev.at || new Date().toISOString(), moves: prev.moves }]
        : [];
    const nextRuns = [...prevRuns.slice(-19), { at: new Date().toISOString(), moves: done }];
    atomicWriteJson(mp, { runs: nextRuns });
  }
  return { moved: done.length, errors, summary: actualSummary };
}

export function undoOrganize(dir) {
  const mp = manifestPath(dir);
  if (!fs.existsSync(mp)) throw new Error("Nothing to undo: no organise history found in this folder.");
  const raw = readJsonSafe(mp, null);
  if (!raw || typeof raw !== "object") {
    throw new Error("Organize undo history is unreadable or corrupted.");
  }
  const runs = Array.isArray(raw.runs)
    ? raw.runs.slice()
    : Array.isArray(raw.moves)
      ? [{ at: raw.at || "", moves: raw.moves }]
      : [];
  if (!runs.length) throw new Error("Nothing to undo: no organise runs recorded.");

  const latest = runs.pop();
  const moves = Array.isArray(latest?.moves) ? latest.moves : [];
  let restored = 0;
  const errors = [];

  for (const m of moves.slice().reverse()) {
    try {
      if (!m?.from || !m?.to || !isInsideDir(dir, m.from) || !isInsideDir(dir, m.to)) {
        throw new Error("Refusing to undo path outside target folder.");
      }
      if (!fs.existsSync(m.to)) throw new Error("file no longer at new location");
      fs.mkdirSync(path.dirname(m.from), { recursive: true });
      moveFileSync(m.to, uniqueDest(path.dirname(m.from), path.basename(m.from)));
      restored++;
    } catch (err) {
      errors.push({ file: path.basename(String(m?.to || "unknown")), error: err.message });
    }
  }

  if (!errors.length) {
    if (runs.length) atomicWriteJson(mp, { runs });
    else fs.unlinkSync(mp);
  }
  for (const cat of [...Object.keys(CATEGORIES), "Other", "Duplicates"]) {
    const p = path.join(dir, cat);
    try { if (fs.existsSync(p) && fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch { /* not empty / busy */ }
  }
  return { restored, remainingRuns: runs.length, errors };
}
