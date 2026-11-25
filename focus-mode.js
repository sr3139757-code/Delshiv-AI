// Focus / Pomodoro Mode for Delshiv AI (persists active session across restarts when filePath is provided).
import fs from "fs";
import { atomicWriteJson, readJsonSafe } from "./shared-utils.js";

export function createFocusManager({ filePath = "", onComplete, log = () => {} }) {
  let session = null;
  let timer = null;

  function persist(nextSession) {
    if (!filePath) return;
    try {
      if (nextSession) atomicWriteJson(filePath, nextSession);
      else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      log("focus persist", err);
    }
  }

  function scheduleCompletion(sess) {
    const delay = Math.max(0, sess.endsAt - Date.now());
    timer = setTimeout(() => {
      const done = session;
      session = null;
      timer = null;
      persist(null);
      try { onComplete?.(done); } catch (err) { log("focus onComplete", err); }
    }, delay);
  }

  if (filePath) {
    const saved = readJsonSafe(filePath, null, log);
    if (saved && typeof saved === "object" && Number.isFinite(saved.endsAt)) {
      if (saved.endsAt > Date.now()) {
        session = saved;
        scheduleCompletion(session);
      } else {
        persist(null);
      }
    }
  }

  function status() {
    if (!session) return { active: false, message: "No active focus session." };
    const remMs = Math.max(0, session.endsAt - Date.now());
    const remMin = Math.ceil(remMs / 60000);
    return {
      active: true,
      label: session.label,
      minutes: session.minutes,
      remainingMinutes: remMin,
      endsAt: new Date(session.endsAt).toLocaleTimeString(),
      message: `Focus "${session.label}" active — ${remMin} min remaining (ends ${new Date(session.endsAt).toLocaleTimeString()}).`,
    };
  }

  function start({ minutes = 25, label = "Deep Work" } = {}) {
    const mins = Math.min(180, Math.max(1, Math.round(Number(minutes) || 25)));
    stop();
    const endsAt = Date.now() + mins * 60000;
    session = { label: String(label || "Deep Work").trim().slice(0, 60), minutes: mins, startedAt: Date.now(), endsAt };
    persist(session);
    scheduleCompletion(session);
    return status();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    const prev = session;
    session = null;
    persist(null);
    return prev ? { active: false, message: `Stopped focus session "${prev.label}".` } : { active: false, message: "No active focus session." };
  }

  function shutdown() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { start, stop, status, shutdown };
}
