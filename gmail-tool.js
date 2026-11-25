// Gmail Reader tool for Delshiv AI (uses Google OAuth access token + optional Google API key).
// Note: Gmail API strictly requires an OAuth 2.0 Bearer token with gmail.readonly scope to read private mail.
import { decodeHtmlEntities } from "./shared-utils.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

function decodeBase64Url(data) {
  if (!data) return "";
  const norm = String(data).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(norm, "base64").toString("utf-8");
}

function findBodyByMime(payload, targetMime) {
  if (!payload) return "";
  if (payload.mimeType === targetMime && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const found = findBodyByMime(part, targetMime);
      if (found) return found;
    }
  }
  return "";
}

function stripHtmlBody(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<(?:br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractBody(payload) {
  if (!payload) return "";
  const plain = findBodyByMime(payload, "text/plain");
  if (plain && plain.trim()) return plain.trim();

  const html = findBodyByMime(payload, "text/html");
  if (html && html.trim()) return stripHtmlBody(html);

  if (payload.body?.data) {
    return stripHtmlBody(decodeBase64Url(payload.body.data));
  }
  return "";
}

function headerMap(headers = []) {
  const map = {};
  for (const h of headers) {
    if (h?.name) map[h.name.toLowerCase()] = String(h.value || "");
  }
  return map;
}

async function gmailFetch(endpoint, accessToken, apiKey = "") {
  const sep = endpoint.includes("?") ? "&" : "?";
  const url = apiKey ? `${BASE}${endpoint}${sep}key=${encodeURIComponent(apiKey)}` : `${BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 240) || `HTTP ${res.status}`;
    const err = new Error(`Gmail API HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

export async function listGmailMessages({ accessToken, apiKey = "", query = "", maxResults = 10 } = {}) {
  if (!accessToken) {
    throw new Error("Google OAuth access token is missing. Please sign in with Google (or log out and log back in to grant Gmail read permission).");
  }
  const n = Math.min(25, Math.max(1, Math.floor(Number(maxResults) || 10)));
  const qParam = query ? `&q=${encodeURIComponent(String(query).trim())}` : "";
  const list = await gmailFetch(`/messages?maxResults=${n}${qParam}`, accessToken, apiKey);
  const ids = Array.isArray(list?.messages) ? list.messages.map((m) => m.id).filter(Boolean) : [];
  if (!ids.length) return [];

  const details = [];
  let firstError = null;
  const BATCH = 5;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      chunk.map((id) =>
        gmailFetch(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, accessToken, apiKey)
      )
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) details.push(s.value);
      else if (s.status === "rejected" && !firstError) firstError = s.reason;
    }
  }
  if (!details.length && firstError) throw firstError;

  return details.map((m) => {
    const h = headerMap(m.payload?.headers);
    return {
      id: m.id,
      threadId: m.threadId,
      unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
      from: h.from || "(unknown sender)",
      subject: h.subject || "(no subject)",
      date: h.date || "",
      snippet: decodeHtmlEntities(m.snippet || ""),
    };
  });
}

export async function readGmailMessage({ accessToken, apiKey = "", id } = {}) {
  if (!accessToken) {
    throw new Error("Google OAuth access token is missing. Please sign in with Google to read Gmail.");
  }
  const msgId = String(id || "").trim();
  if (!msgId) throw new Error("Message id is required.");
  const m = await gmailFetch(`/messages/${encodeURIComponent(msgId)}?format=full`, accessToken, apiKey);
  const h = headerMap(m.payload?.headers);
  const body = extractBody(m.payload).slice(0, 6000);
  return {
    id: m.id,
    from: h.from || "(unknown sender)",
    to: h.to || "",
    subject: h.subject || "(no subject)",
    date: h.date || "",
    snippet: decodeHtmlEntities(m.snippet || ""),
    body: body || decodeHtmlEntities(m.snippet || ""),
  };
}
