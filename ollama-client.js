// Local Ollama client for Delshiv AI (100% offline LLM brain).
import { isPrivateIp } from "./shared-utils.js";

export function normalizeOllamaHost(rawHost) {
  let raw = String(rawHost || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").trim();
  if (!raw) raw = "http://127.0.0.1:11434";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid OLLAMA_HOST URL: "${rawHost}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OLLAMA_HOST must use http or https.");
  }
  const hostBare = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const isLocal = hostBare === "localhost" || hostBare === "::1" || isPrivateIp(hostBare);
  if (!isLocal && process.env.ALLOW_REMOTE_OLLAMA !== "1") {
    throw new Error("OLLAMA_HOST must point to localhost or a private LAN IP (set ALLOW_REMOTE_OLLAMA=1 to override).");
  }
  return parsed.origin;
}

export async function getOllamaStatus(hostArg) {
  let host;
  try {
    host = normalizeOllamaHost(hostArg);
  } catch (err) {
    return { available: false, host: String(hostArg || ""), models: [], error: err.message };
  }
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { available: false, host, models: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (Array.isArray(data?.models) ? data.models : [])
      .map((m) => (m && typeof m.name === "string" ? m.name.trim() : ""))
      .filter(Boolean);
    return { available: true, host, models, defaultModel: process.env.OLLAMA_MODEL || models[0] || "" };
  } catch (err) {
    return { available: false, host, models: [], error: err?.message || "Ollama not reachable" };
  }
}

export async function askOllama({ prompt, systemPrompt = "", history = [], model = "" } = {}, hostArg) {
  const host = normalizeOllamaHost(hostArg);
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Prompt is empty.");

  let targetModel = String(model || process.env.OLLAMA_MODEL || "").trim();
  if (!targetModel) {
    const status = await getOllamaStatus(host);
    if (!status.available) throw new Error(`Ollama is not running at ${host}: ${status.error}`);
    if (!status.models.length) throw new Error("Ollama is running, but no models are installed (run e.g. 'ollama pull llama3.2').");
    targetModel = status.models[0];
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: String(systemPrompt) });
  if (Array.isArray(history)) {
    for (const m of history.slice(-8)) {
      if (!m || typeof m !== "object") continue;
      const text = Array.isArray(m.parts)
        ? m.parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("")
        : typeof m.content === "string"
          ? m.content
          : typeof m.text === "string"
            ? m.text
            : "";
      if (!text) continue;
      const role = m.role === "system" ? "system" : (m.role === "model" || m.role === "assistant") ? "assistant" : "user";
      messages.push({ role, content: text });
    }
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || last.content !== cleanPrompt) {
    messages.push({ role: "user", content: cleanPrompt });
  }

  let res;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: targetModel, messages, stream: false }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    throw new Error(`Ollama is not reachable at ${host}: ${err?.message || "connection failed"}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Ollama ${targetModel} HTTP ${res.status}: ${body}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Ollama ${targetModel} returned invalid JSON.`);
  }
  const reply = String(data?.message?.content || "").trim();
  if (!reply) throw new Error(`Ollama ${targetModel} returned an empty response.`);
  return { ok: true, model: targetModel, reply };
}
