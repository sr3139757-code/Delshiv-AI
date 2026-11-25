// Web & Research Tools: Tavily web_search, Cheerio fetch_page, YouTube youtube_transcript.
import * as cheerio from "cheerio";
import { redact } from "./report-generator.js";
import {
  GEMINI_MODELS,
  assertPublicHttpUrl,
  decodeHtmlEntities,
  readResponseTextWithLimit,
} from "./shared-utils.js";

const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export async function tavilyWebSearch({ query, maxResults = 5, apiKey = "" } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("Search query is required.");
  if (!apiKey) throw new Error("TAVILY_API_KEY is not configured. Add it in Settings or .env.");

  const n = Math.min(10, Math.max(1, Math.floor(Number(maxResults) || 5)));
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: "basic",
      max_results: n,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`Tavily API HTTP ${res.status}: ${data?.detail || data?.error || raw.slice(0, 200)}`);
  }

  const results = (Array.isArray(data?.results) ? data.results : []).slice(0, n).map((r) => ({
    title: String(r.title || "Untitled").trim(),
    url: String(r.url || "").trim(),
    summary: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 320),
  }));

  return {
    ok: true,
    query: q,
    count: results.length,
    results,
    message: results.length ? `Found ${results.length} Tavily result(s) for "${q}".` : `No results found for "${q}".`,
  };
}

export async function fetchPageWithCheerio({ url, maxChars = 6000, lookup } = {}) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) throw new Error("URL is required.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) && !/^https?:\/\//i.test(rawUrl)) {
    throw new Error("Only http and https URLs are supported.");
  }
  const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const parsed = await assertPublicHttpUrl(normalized, { lookup });

  const res = await fetch(parsed.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (res.url) {
    await assertPublicHttpUrl(res.url, { lookup });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${parsed.hostname}`);

  const body = await readResponseTextWithLimit(res, MAX_PAGE_BYTES);
  const contentType = String(res.headers?.get?.("content-type") || "");
  const isHtml = /html|xml/i.test(contentType) || /<html|<body|<article|<main/i.test(body);

  let title = parsed.hostname;
  let mainText = "";
  if (isHtml) {
    const $ = cheerio.load(body);
    title = $("title").first().text().replace(/\s+/g, " ").trim() || parsed.hostname;
    $("script, style, noscript, svg, iframe, nav, footer, aside").remove();
    mainText = ($("main").text() || $("article").text() || $("body").text() || $.text() || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  } else {
    mainText = body.trim();
  }

  if (!mainText) throw new Error("Page loaded, but no readable text was found.");
  const limit = Math.min(20000, Math.max(500, Number(maxChars) || 6000));
  const clean = redact(mainText);
  const truncated = clean.length > limit;
  const text = truncated ? clean.slice(0, limit) + "\n…[truncated]" : clean;

  return {
    ok: true,
    url: res.url || parsed.toString(),
    title,
    length: clean.length,
    truncated,
    text,
    message: `Fetched "${title}" (${clean.length} chars${truncated ? `, shortened to ${limit}` : ""}).`,
  };
}

export function extractYoutubeId(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:v=|youtu\.be\/|youtube\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{11})/) || (/^[A-Za-z0-9_-]{11}$/.test(s) ? [s, s] : null);
  return m ? m[1] : null;
}

async function downloadCaptionText(baseUrl, onError = () => {}) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  };
  try {
    const jUrl = baseUrl.includes("fmt=") ? baseUrl : `${baseUrl}&fmt=json3`;
    const r = await fetch(jUrl, { headers, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const txt = await readResponseTextWithLimit(r, 1024 * 1024);
      if (txt.trim().startsWith("{")) {
        const data = JSON.parse(txt);
        const words = [];
        for (const ev of data?.events || []) {
          for (const seg of ev?.segs || []) {
            if (seg?.utf8 && seg.utf8.trim() && seg.utf8 !== "\n") words.push(seg.utf8);
          }
        }
        const joined = words.join(" ").replace(/\s+/g, " ").trim();
        if (joined) return joined;
      }
    }
  } catch (err) {
    onError("youtube_json3_caption", err);
  }

  const capRes = await fetch(baseUrl, { headers, signal: AbortSignal.timeout(12000) });
  if (!capRes.ok) return "";
  const xml = await readResponseTextWithLimit(capRes, 1024 * 1024);
  if (!xml.trim()) return "";
  const $ = cheerio.load(xml, { xmlMode: true });
  const lines = [];
  $("text, p").each((_, el) => {
    const t = decodeHtmlEntities($(el).text()).replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
  });
  return lines.join(" ").trim();
}

async function fetchTracksViaInnertube(videoId, onError = () => {}) {
  const clients = [
    { name: "ANDROID", version: "19.09.37", ua: "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip", extra: { androidSdkVersion: 30 } },
    { name: "IOS", version: "19.29.1", ua: "com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)", extra: { deviceModel: "iPhone16,2" } },
  ];
  for (const c of clients) {
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": c.ua },
        body: JSON.stringify({
          context: { client: { clientName: c.name, clientVersion: c.version, hl: "en", gl: "US", ...c.extra } },
          videoId,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (tracks.length) return { title: data?.videoDetails?.title || videoId, tracks };
    } catch (err) {
      onError(`youtube_innertube_${c.name}`, err);
    }
  }
  return null;
}

async function summarizeYoutubeViaGemini(watchUrl, apiKey, onError = () => {}) {
  if (!apiKey) return "";
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { fileData: { fileUri: watchUrl } },
              { text: "Provide a clear, accurate transcript/summary of what is spoken and shown in this YouTube video in 5-8 concise bullet points." },
            ],
          }],
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (text) return text;
    } catch (err) {
      onError(`youtube_gemini_${model}`, err);
    }
  }
  return "";
}

export async function fetchYoutubeTranscript({ url, apiKey = "", onError = () => {} } = {}) {
  const videoId = extractYoutubeId(url);
  if (!videoId) throw new Error("Invalid YouTube URL or video ID.");

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let title = videoId;
  let tracks = [];

  try {
    const it = await fetchTracksViaInnertube(videoId, onError);
    if (it?.tracks?.length) {
      title = it.title || videoId;
      tracks = it.tracks;
    }
  } catch (err) {
    onError("youtube_innertube", err);
  }

  if (!tracks.length) {
    const res = await fetch(watchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
    const html = await readResponseTextWithLimit(res, MAX_PAGE_BYTES);
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, "")).trim() : videoId;

    const marker = "ytInitialPlayerResponse = ";
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      let depth = 0, inStr = false, esc = false, end = -1;
      const start = html.indexOf("{", idx);
      for (let i = start; i < html.length; i++) {
        const ch = html[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\" && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === "{") depth++;
          else if (ch === "}" && --depth === 0) { end = i + 1; break; }
        }
      }
      if (end !== -1) {
        const player = JSON.parse(html.slice(start, end));
        tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      }
    }
  }

  const track = Array.isArray(tracks) && tracks.length
    ? (tracks.find((t) => /^en/i.test(t.languageCode || "")) || tracks.find((t) => /^hi/i.test(t.languageCode || "")) || tracks[0])
    : null;

  let transcript = "";
  if (track?.baseUrl) {
    try {
      transcript = await downloadCaptionText(track.baseUrl, onError);
    } catch (err) {
      onError("youtube_caption_download", err);
    }
  }

  if (!transcript) {
    const geminiSummary = await summarizeYoutubeViaGemini(watchUrl, apiKey, onError);
    if (geminiSummary) {
      return {
        ok: true,
        videoId,
        url: watchUrl,
        title,
        language: "auto",
        summary: geminiSummary,
        transcript: geminiSummary,
        message: `Summarized YouTube video "${title}" directly via AI video analysis.`,
      };
    }
    throw new Error(
      Array.isArray(tracks) && tracks.length
        ? "YouTube restricted direct caption download (empty response) and AI video fallback was unavailable."
        : "No captions/transcript available for this YouTube video."
    );
  }

  let summary = "";
  if (apiKey) {
    const prompt = `Summarize this YouTube video transcript ("${title}") concisely in 5 clear bullet points:\n\n${transcript.slice(0, 14000)}`;
    for (const model of GEMINI_MODELS) {
      try {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
          signal: AbortSignal.timeout(15000),
        });
        if (!gRes.ok) continue;
        const gJson = await gRes.json();
        summary = gJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (summary) break;
      } catch (err) {
        onError(`youtube_summarize_${model}`, err);
      }
    }
  }

  return {
    ok: true,
    videoId,
    url: watchUrl,
    title,
    language: track.languageCode || "unknown",
    summary: summary || transcript.slice(0, 2000),
    transcript: transcript.slice(0, 12000),
    message: summary ? `Summarized YouTube video "${title}" (${track.languageCode}).` : `Extracted transcript for "${title}" (${transcript.length} chars).`,
  };
}
