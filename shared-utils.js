// Shared production utilities for Delshiv AI: PowerShell UTF-8 runner, atomic JSON I/O, URL/SSRF guards, HTML decoding.
import { execFile } from "child_process";
import dns from "dns";
import fs from "fs";
import net from "net";
import path from "path";

export const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
];

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Single-pass HTML/XML entity decoder (prevents double-unescaping like &amp;lt; -> <). */
export function decodeHtmlEntities(input) {
  const s = String(input ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (match) => {
    const body = match.slice(1, -1);
    const lower = body.toLowerCase();
    if (NAMED_ENTITIES[lower] !== undefined) return NAMED_ENTITIES[lower];
    if (lower.startsWith("#x")) {
      const cp = parseInt(lower.slice(2), 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (lower.startsWith("#")) {
      const cp = parseInt(lower.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return match;
  });
}

export function cleanPowershellStderr(str) {
  const raw = String(str || "").trim();
  if (!raw.startsWith("#< CLIXML")) return raw;
  const parts = [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    decodeHtmlEntities(
      m[1]
        .replace(/_x000D__x000A_/g, "\n")
        .replace(/_x000A_/g, "\n")
        .replace(/_x000D_/g, "")
    )
  );
  return parts.length ? parts.join("").trim() : raw;
}

/** Runs PowerShell script via UTF-16LE Base64 with UTF-8 console encoding forced. */
export function runPowerShellDetailed(script, { timeout = 12000, maxBuffer = 4 * 1024 * 1024, cwd } = {}) {
  const psScript = [
    "$ProgressPreference = 'SilentlyContinue';",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8;",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "$OutputEncoding = [System.Text.Encoding]::UTF8;",
    String(script || ""),
  ].join("\n");
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const execOpts = {
    timeout,
    maxBuffer,
    windowsHide: true,
    encoding: "utf8",
  };
  if (cwd) execOpts.cwd = cwd;

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand", encoded],
      execOpts,
      (err, stdout, stderr) => {
        const outStr = String(stdout || "").trim();
        const errStr = cleanPowershellStderr(stderr);
        if (err) {
          const sanitizedErrMsg = String(err.message || "PowerShell execution failed.")
            .replace(/-EncodedCommand\s+[A-Za-z0-9+/=]+/gi, "-EncodedCommand <omitted>");
          const friendlyMsg = (err.killed || err.signal === "SIGTERM") && !errStr
            ? `PowerShell command timed out after ${timeout}ms.`
            : (errStr || sanitizedErrMsg);
          resolve({
            ok: false,
            exitCode: typeof err.code === "number" ? err.code : 1,
            stdout: outStr,
            stderr: errStr,
            error: err,
            message: friendlyMsg,
          });
          return;
        }
        resolve({ ok: true, exitCode: 0, stdout: outStr, stderr: errStr });
      }
    );
  });
}

export async function runPowerShell(script, opts = {}) {
  const res = await runPowerShellDetailed(script, opts);
  if (!res.ok) {
    throw new Error(res.message || "PowerShell execution failed.");
  }
  return res.stdout;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback busy wait */ }
  }
}

export function atomicWriteText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  const tmp = `${filePath}.${suffix}`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeSync(fd, String(content ?? ""), null, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        lastErr = err;
        if ((err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES") && attempt < 3) {
          sleepSync(20 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

export function readJsonSafe(filePath, fallback, log = () => {}) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || (fallback !== null && typeof fallback === "object" && typeof parsed !== "object")) {
      throw new Error("Unexpected JSON root value.");
    }
    return parsed;
  } catch (err) {
    const bak = `${filePath}.corrupt-${Date.now()}`;
    try { fs.renameSync(filePath, bak); } catch { /* ignore */ }
    try { log(`readJsonSafe (${path.basename(filePath)})`, new Error(`Corrupt JSON moved to ${bak}: ${err.message}`)); } catch { /* ignore */ }
    return fallback;
  }
}

export function isSafeExternalUrl(rawUrl, { allowMsSettings = false } = {}) {
  const s = String(rawUrl || "").trim();
  if (!s || /[\x00-\x1f\x7f\s]/.test(s)) return false;
  if (allowMsSettings && /^ms-settings:[a-z0-9_-]*$/i.test(s)) return true;
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return Boolean(u.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

function ipv4Bytes(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

export function isPrivateIp(rawIp) {
  let ip = String(rawIp || "").trim().replace(/^\[|\]$/g, "");
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  const lower = ip.toLowerCase();

  if (lower.startsWith("::ffff:")) {
    const rest = lower.slice(7);
    if (rest.includes(".")) {
      ip = rest;
    } else {
      const hexParts = rest.split(":");
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          ip = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
        }
      }
    }
  }

  const family = net.isIP(ip);
  if (family === 4) {
    const b = ipv4Bytes(ip);
    if (!b) return true;
    const [o1, o2] = b;
    if (o1 === 0) return true; // 0.0.0.0/8
    if (o1 === 10) return true; // 10.0.0.0/8
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // 100.64.0.0/10 CGNAT
    if (o1 === 127) return true; // 127.0.0.0/8 loopback
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
    if (o1 >= 224) return true; // multicast & reserved
    return false;
  }

  if (family === 6) {
    const norm = ip.toLowerCase();
    if (norm === "::" || norm === "::1" || norm === "0:0:0:0:0:0:0:1" || norm === "0:0:0:0:0:0:0:0") return true;
    if (/^(fc|fd)[0-9a-f]{0,2}:/i.test(norm)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/i.test(norm)) return true; // Link-local fe80::/10
    return false;
  }

  return false;
}

export async function assertPublicHttpUrl(rawUrl, { lookup = dns.promises.lookup } = {}) {
  const s = String(rawUrl || "").trim();
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`Invalid URL: "${s}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("URL hostname is missing.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Blocked local hostname "${host}" (SSRF protection).`);
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error(`Blocked private/loopback IP "${host}" (SSRF protection).`);
  }
  if (typeof lookup === "function") {
    let records = [];
    try {
      records = await lookup(host, { all: true, verbatim: true });
    } catch {
      return parsed; // Let network fetch report DNS errors naturally
    }
    for (const r of records || []) {
      if (r?.address && isPrivateIp(r.address)) {
        throw new Error(`Blocked private/loopback DNS target for "${host}" (SSRF protection).`);
      }
    }
  }
  return parsed;
}

export async function readResponseTextWithLimit(res, maxBytes = 2 * 1024 * 1024) {
  const clHeader = res?.headers?.get?.("content-length");
  const contentLength = clHeader ? Number(clHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > maxBytes * 5) {
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    throw new Error(`Response too large (${contentLength} bytes exceeds safety limit).`);
  }

  if (!res?.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    return text.slice(0, maxBytes);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total).toString("utf-8");
}
