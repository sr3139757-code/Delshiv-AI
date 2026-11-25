// Local code search for Delshiv AI: symbol-aware chunking + BM25 ranking + exact-match boost.
// Fully offline & async I/O. Never indexes secret files; snippets are redacted before being returned.
import fs from "fs";
import path from "path";
import { redact } from "./report-generator.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "__pycache__", ".venv", "venv", "coverage", ".cache"]);
const CODE_EXT = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".cs", ".rb", ".php", ".html", ".css", ".json", ".md", ".bat", ".ps1", ".vbs", ".sh", ".yml", ".yaml", ".toml"]);
const SECRET_FILE = /(^\.env|\.pem$|\.key$|\.pfx$|\.p12$|\.jks$|id_rsa|id_ed25519|\.npmrc|secret|credential|allowed_users|auth_session|pin_lock|command_log|clipboard_history|delshiv_memory|\.lock$|package-lock\.json$)/i;
const MAX_FILE_BYTES = 1_500_000;
const MAX_FILES = 3000;
const MAX_CHUNK_LINES = 80;
const MAX_CACHE_ENTRIES = 5;

const DECL = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s{0,2}ipcMain\.handle\(\s*["']([^"']+)["']/,
  /^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?def\s+(\w+)/,
  /^class\s+(\w+)/,
  /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
  /^(?:pub\s+)?fn\s+(\w+)/,
  /^#{1,3}\s+(.+)/,
];

export function tokenize(text) {
  return String(text || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./\\:]+/g, " ")
    .toLowerCase()
    .match(/[a-z0-9\u0900-\u097f]{2,}/g) || [];
}

function symbolOf(line) {
  for (const re of DECL) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}

export function chunkFile(relPath, content) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  let start = 0;
  let symbol = null;
  const flush = (end) => {
    if (end <= start) return;
    for (let s = start; s < end; s += MAX_CHUNK_LINES) {
      const e = Math.min(end, s + MAX_CHUNK_LINES);
      const text = lines.slice(s, e).join("\n");
      if (!text.trim()) continue;
      chunks.push({ file: relPath, start: s + 1, end: e, symbol, text });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const sym = symbolOf(lines[i]);
    if (sym && i > start) {
      flush(i);
      start = i;
      symbol = sym;
    } else if (sym && i === start) {
      symbol = sym;
    }
  }
  flush(lines.length);
  return chunks;
}

async function walkAsync(root, out = []) {
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        await walkAsync(full, out);
      }
    } else if (e.isFile() && CODE_EXT.has(path.extname(e.name).toLowerCase()) && !SECRET_FILE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const cache = new Map(); // root → { sig, chunks, df, avgLen }

async function buildIndex(root) {
  const files = await walkAsync(root);
  let sig = "";
  const stats = [];
  for (const f of files) {
    try {
      const st = await fs.promises.stat(f);
      if (st.size > MAX_FILE_BYTES) continue;
      stats.push([f, st]);
      sig += `${f}:${st.mtimeMs}:${st.size};`;
    } catch { /* file vanished */ }
  }
  const hit = cache.get(root);
  if (hit && hit.sig === sig) {
    cache.delete(root);
    cache.set(root, hit);
    return hit;
  }

  const chunks = [];
  for (const [f] of stats) {
    let content;
    try { content = await fs.promises.readFile(f, "utf-8"); } catch { continue; }
    if (content.includes("\u0000")) continue;
    chunks.push(...chunkFile(path.relative(root, f).replace(/\\/g, "/"), content));
  }
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    c.tokens = tokenize(`${c.file} ${c.symbol || ""} ${c.symbol || ""} ${c.text}`);
    c.tf = new Map();
    for (const t of c.tokens) c.tf.set(t, (c.tf.get(t) || 0) + 1);
    for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += c.tokens.length;
  }
  const idx = { sig, chunks, df, avgLen: totalLen / Math.max(1, chunks.length), files: stats.length, root };
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(root, idx);
  return idx;
}

export async function searchCode(root, query, { limit = 6, snippetLines = 14 } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("Search query is empty.");
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) throw new Error(`Search root is not a directory: ${absRoot}`);
  const idx = await buildIndex(absRoot);
  const qTokens = [...new Set(tokenize(q))];
  if (!qTokens.length) throw new Error("Query has no searchable terms.");
  const N = idx.chunks.length;
  const k1 = 1.4, b = 0.75;
  const literal = q.length >= 3 ? q.toLowerCase() : "";

  const scored = [];
  for (const c of idx.chunks) {
    let score = 0;
    const len = c.tokens.length || 1;
    for (const t of qTokens) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / idx.avgLen)));
    }
    if (score <= 0) continue;
    if (literal && c.text.toLowerCase().includes(literal)) score *= 1.6;
    if (c.symbol && qTokens.some((t) => tokenize(c.symbol).includes(t))) score *= 1.3;
    scored.push({ c, score });
  }
  scored.sort((a, z) => z.score - a.score);

  const seen = new Set();
  const results = [];
  for (const { c, score } of scored) {
    const key = `${c.file}:${Math.floor(c.start / 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = c.text.split("\n");
    let hitLine = lines.findIndex((l) => qTokens.some((t) => l.toLowerCase().includes(t)));
    if (hitLine < 0) hitLine = 0;
    const s = Math.max(0, hitLine - 2);
    const e = Math.min(lines.length, s + snippetLines);
    results.push({
      ref: `${c.file}:${c.start + s}-${c.start + e - 1}`,
      file: c.file,
      startLine: c.start + s,
      endLine: c.start + e - 1,
      symbol: c.symbol || null,
      score: Math.round(score * 100) / 100,
      snippet: redact(lines.slice(s, e).join("\n")),
    });
    if (results.length >= Math.min(15, Math.max(1, limit))) break;
  }
  return { root: absRoot, indexedFiles: idx.files, indexedChunks: N, results };
}
