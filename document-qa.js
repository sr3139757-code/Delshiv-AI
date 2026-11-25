// Document Q&A for Delshiv AI: PDF, DOCX, XLSX, CSV, TXT, MD, JSON, LOG.
// Offline-first for text/CSV/DOCX/XLSX (via Windows .NET ZipFile); uses Gemini inlineData for PDFs when online.
import fs from "fs";
import path from "path";
import { tokenize } from "./code-search.js";
import { isProtectedPath } from "./safety-guard.js";
import { GEMINI_MODELS, runPowerShell } from "./shared-utils.js";
import { sanitizeForMemory } from "./memory-db.js";

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_OFFICE_BYTES = 15 * 1024 * 1024;

async function extractDocxText(filePath) {
  const safePath = filePath.replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${safePath}')
try {
  $entry = $zip.GetEntry('word/document.xml')
  if (-not $entry) { throw 'Invalid DOCX: word/document.xml not found.' }
  $sr = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  $xml = [xml]$sr.ReadToEnd()
  $sr.Dispose()
  $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
  $paras = $xml.SelectNodes('//w:p', $ns)
  $out = foreach ($p in $paras) {
    $texts = $p.SelectNodes('.//w:t', $ns) | ForEach-Object { $_.'#text' }
    ($texts -join '')
  }
  ($out | Where-Object { $_ -ne '' }) -join "\`n"
} finally {
  $zip.Dispose()
}`;
  return (await runPowerShell(ps, { timeout: 12000 })).trim();
}

async function extractXlsxText(filePath) {
  const safePath = filePath.replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${safePath}')
try {
  $shared = @()
  $ssEntry = $zip.GetEntry('xl/sharedStrings.xml')
  if ($ssEntry) {
    $sr = New-Object System.IO.StreamReader($ssEntry.Open(), [System.Text.Encoding]::UTF8)
    $sxml = [xml]$sr.ReadToEnd()
    $sr.Dispose()
    $shared = @($sxml.sst.si | ForEach-Object {
      if ($_.t) { if ($_.t -is [string]) { $_.t } else { $_.t.'#text' } }
      elseif ($_.r) { ($_.r | ForEach-Object { if ($_.t -is [string]) { $_.t } else { $_.t.'#text' } }) -join '' }
      else { '' }
    })
  }
  $sheets = $zip.Entries | Where-Object { $_.FullName -match '^xl/worksheets/sheet\\d+\\.xml$' } | Sort-Object { [int]([regex]::Match($_.Name, '\\d+').Value) }
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($sh in $sheets) {
    $lines.Add("=== $($sh.Name) ===")
    $sr = New-Object System.IO.StreamReader($sh.Open(), [System.Text.Encoding]::UTF8)
    $xml = [xml]$sr.ReadToEnd()
    $sr.Dispose()
    foreach ($row in $xml.worksheet.sheetData.row) {
      $cells = @()
      foreach ($c in $row.c) {
        $val = ''
        if ($c.t -eq 's' -and $null -ne $c.v) {
          $idx = [int]$c.v
          if ($idx -ge 0 -and $idx -lt $shared.Count) { $val = $shared[$idx] }
        } elseif ($null -ne $c.v) {
          $val = [string]$c.v
        } elseif ($c.is.t) {
          $val = [string]$c.is.t
        }
        $cells += $val
      }
      if (($cells -join '').Trim() -ne '') { $lines.Add(($cells -join ' | ')) }
    }
  }
  $lines -join "\`n"
} finally {
  $zip.Dispose()
}`;
  return (await runPowerShell(ps, { timeout: 15000 })).trim();
}

function extractRawPdfStrings(buf) {
  const latin = buf.toString("latin1");
  const chunks = [];
  for (const m of latin.matchAll(/\(([^()\\]{2,200})\)\s*Tj/g)) chunks.push(m[1]);
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  return text.length >= 40 ? text : "";
}

function rankChunks(text, query, maxChunks = 5) {
  const lines = String(text || "").split(/\r?\n/);
  const chunks = [];
  for (let i = 0; i < lines.length; i += 25) {
    const slice = lines.slice(i, i + 25).join("\n").trim();
    if (slice) chunks.push({ startLine: i + 1, endLine: Math.min(lines.length, i + 25), text: slice });
  }
  if (!query) return chunks.slice(0, maxChunks);
  const qToks = [...new Set(tokenize(query))];
  if (!qToks.length) return chunks.slice(0, maxChunks);
  const scored = chunks.map((c) => {
    const toks = new Set(tokenize(c.text));
    const hits = qToks.filter((t) => toks.has(t)).length;
    return { ...c, score: hits };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxChunks);
}

async function askGeminiWithParts(parts, apiKey, onModelError = () => {}) {
  let lastErr;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`Gemini ${model} HTTP ${res.status}: ${body}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const answer = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!answer) throw new Error(`Gemini ${model} returned empty answer.`);
      return { answer, model };
    } catch (err) {
      lastErr = err;
      onModelError(model, err);
      if (err.status === 400 || err.status === 401 || err.status === 403) break;
    }
  }
  throw lastErr || new Error("Document Q&A model call failed.");
}

export async function queryDocument({ filePath, question = "", apiKey = "", resolvePath = null, onModelError = () => {} } = {}) {
  const rawPath = String(filePath || "").trim();
  if (!rawPath) throw new Error("filePath is required.");
  const abs = typeof resolvePath === "function" ? resolvePath(rawPath) : path.resolve(rawPath);
  if (isProtectedPath(abs)) throw new Error(`Refusing to read protected location: ${abs}`);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`File not found: ${abs}`);

  const ext = path.extname(abs).toLowerCase();
  const stat = fs.statSync(abs);
  const q = String(question || "").trim();

  if (ext === ".pdf") {
    if (stat.size > MAX_PDF_BYTES) throw new Error(`PDF exceeds 12 MB limit (${Math.round(stat.size / 1048576)} MB).`);
    const buf = fs.readFileSync(abs);
    if (apiKey) {
      try {
        const prompt = q
          ? `Answer this question accurately using ONLY the attached PDF. Quote relevant sections/numbers.\n\nQuestion: ${q}`
          : "Summarize the key points, structure, and important figures of this PDF concisely.";
        const { answer, model } = await askGeminiWithParts(
          [{ inlineData: { mimeType: "application/pdf", data: buf.toString("base64") } }, { text: prompt }],
          apiKey,
          onModelError
        );
        return { file: abs, format: "pdf", mode: "gemini-pdf", model, answer };
      } catch (err) {
        const local = extractRawPdfStrings(buf);
        if (!local) throw err;
        const hits = rankChunks(local, q, 4);
        return { file: abs, format: "pdf", mode: "offline-fallback", excerpts: hits, answer: hits.map((h) => h.text).join("\n\n") };
      }
    }
    const local = extractRawPdfStrings(buf);
    if (!local) throw new Error("PDF text is compressed/scanned and GEMINI_API_KEY is not available for PDF reading.");
    const hits = rankChunks(local, q, 4);
    return { file: abs, format: "pdf", mode: "offline-local", excerpts: hits, answer: hits.map((h) => h.text).join("\n\n") };
  }

  let text = "";
  if (ext === ".docx") {
    if (stat.size > MAX_OFFICE_BYTES) throw new Error(`DOCX exceeds 15 MB limit (${Math.round(stat.size / 1048576)} MB).`);
    text = await extractDocxText(abs);
  } else if (ext === ".xlsx") {
    if (stat.size > MAX_OFFICE_BYTES) throw new Error(`XLSX exceeds 15 MB limit (${Math.round(stat.size / 1048576)} MB).`);
    text = await extractXlsxText(abs);
  } else {
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`File exceeds 5 MB text limit (${Math.round(stat.size / 1048576)} MB).`);
    text = fs.readFileSync(abs, "utf-8");
    if (text.includes("\u0000")) throw new Error(`Binary file format "${ext}" is not supported for Document Q&A.`);
  }

  if (!text.trim()) throw new Error(`No readable text found in ${path.basename(abs)}.`);
  const excerpts = rankChunks(text, q, 6);
  const rawContext = excerpts.map((c) => `[Lines ${c.startLine}-${c.endLine}]\n${c.text}`).join("\n\n---\n\n").slice(0, 24000);
  const safeContext = sanitizeForMemory(rawContext).slice(0, 12000);

  if (apiKey) {
    try {
      const prompt = q
        ? `Answer the user's question based ONLY on these excerpts from "${path.basename(abs)}". If the answer is not in the excerpts, say so.\n\nQuestion: ${q}\n\nExcerpts:\n${safeContext}`
        : `Summarize the key points, structure, and important details of "${path.basename(abs)}" concisely in 3-5 bullet points based ONLY on these excerpts:\n\n${safeContext}`;
      const { answer, model } = await askGeminiWithParts([{ text: prompt }], apiKey, onModelError);
      return { file: abs, format: ext.slice(1) || "text", mode: "gemini-rag", model, excerpts, answer };
    } catch (err) {
      onModelError("gemini-rag-fallback", err);
    }
  }

  return {
    file: abs,
    format: ext.slice(1) || "text",
    mode: "local-excerpts",
    excerpts,
    answer: rawContext,
  };
}
