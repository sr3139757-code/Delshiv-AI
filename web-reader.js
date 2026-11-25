// Web Page Reader & Summarizer for Delshiv AI (delegates HTML fetching/SSRF guards to research-tools.js).
import { fetchPageWithCheerio } from "./research-tools.js";
import { GEMINI_MODELS } from "./shared-utils.js";

export async function readWebPage({ url, question = "", apiKey = "", lookup, onError = () => {} } = {}) {
  const page = await fetchPageWithCheerio({ url, maxChars: 16000, lookup });
  const excerpt = page.text;

  if (apiKey) {
    const prompt = question
      ? `Answer this question using ONLY the web page text below.\n\nQuestion: ${question}\n\nPage (${page.title}):\n${excerpt.slice(0, 12000)}`
      : `Summarize the key points of this web page concisely in 4-6 bullet points.\n\nPage (${page.title}):\n${excerpt.slice(0, 12000)}`;
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
        const summary = gJson?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (summary) return { ok: true, url: page.url, title: page.title, mode: "summary", summary, text: excerpt.slice(0, 3000) };
      } catch (err) {
        onError(`readWebPage_${model}`, err);
      }
    }
  }

  return { ok: true, url: page.url, title: page.title, mode: "text", summary: excerpt.slice(0, 2500), text: excerpt };
}
