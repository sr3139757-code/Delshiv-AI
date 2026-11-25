// Windows Global Media Controls (Play/Pause, Next, Previous, Stop) via keybd_event.
import { runPowerShell } from "./shared-utils.js";

const VK_MEDIA = {
  play_pause: 0xb3,
  play: 0xb3,
  pause: 0xb3,
  next: 0xb0,
  next_track: 0xb0,
  previous: 0xb1,
  prev: 0xb1,
  previous_track: 0xb1,
  stop: 0xb2,
};

export async function sendMediaKey(operation) {
  const op = String(operation || "play_pause").toLowerCase().trim();
  const vk = VK_MEDIA[op];
  if (!vk) throw new Error(`Unsupported media operation "${op}". Valid: play_pause, next, previous, stop.`);

  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DelshivMedia {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[DelshivMedia]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)
[DelshivMedia]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`;

  await runPowerShell(ps, { timeout: 8000 });
  return { ok: true, operation: op, message: `Media action executed: ${op.replace("_", "/")}.` };
}

/**
 * Search YouTube for a song/video query and open the top matching video directly.
 */
export async function playYouTube(query, openExternalFn) {
  const q = String(query || "").trim();
  if (!q) throw new Error("YouTube play requires a non-empty song or video query.");

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  let targetUrl = searchUrl;
  let videoId = "";

  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/);
      if (match?.[1]) {
        videoId = match[1];
        targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
  } catch {
    // Fallback gracefully to YouTube search results URL if fetch/timeout fails
  }

  if (typeof openExternalFn === "function") {
    await openExternalFn(targetUrl);
  }
  return {
    ok: true,
    operation: "play_youtube",
    query: q,
    videoId: videoId || undefined,
    url: targetUrl,
    message: videoId
      ? `Playing "${q}" on YouTube (${targetUrl}).`
      : `Opened YouTube search for "${q}" (${targetUrl}).`,
  };
}
