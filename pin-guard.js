// Salted scrypt PIN Lock for sensitive Delshiv AI tools.
import crypto from "crypto";
import fs from "fs";
import { atomicWriteJson } from "./shared-utils.js";

const UNLOCK_TTL_NS = BigInt(5 * 60 * 1000) * 1_000_000n;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export function createPinGuard({ filePath, log = () => {} }) {
  let state = { enabled: false, corrupted: false, salt: "", hash: "", failedAttempts: 0, lockedOutUntil: 0 };
  let unlockedUntilNs = 0n;

  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.enabled !== "boolean") {
        throw new Error("Invalid PIN store schema.");
      }
      if (parsed.enabled) {
        if (typeof parsed.salt !== "string" || parsed.salt.length < 16 || typeof parsed.hash !== "string" || !HEX_64_RE.test(parsed.hash)) {
          throw new Error("Corrupted PIN salt or hash.");
        }
      }
      state = {
        enabled: parsed.enabled,
        corrupted: false,
        salt: String(parsed.salt || ""),
        hash: String(parsed.hash || ""),
        failedAttempts: Math.max(0, Math.floor(Number(parsed.failedAttempts) || 0)),
        lockedOutUntil: Math.max(0, Number(parsed.lockedOutUntil) || 0),
      };
    } catch (err) {
      log("pin-guard load", err);
      // Fail closed if an existing PIN file was tampered with or corrupted.
      state = { enabled: true, corrupted: true, salt: "", hash: "", failedAttempts: 0, lockedOutUntil: 0 };
    }
  }

  const save = () => {
    atomicWriteJson(filePath, {
      enabled: state.enabled,
      salt: state.salt,
      hash: state.hash,
      failedAttempts: state.failedAttempts,
      lockedOutUntil: state.lockedOutUntil,
    });
  };

  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex");

  function verify(pin) {
    if (!state.enabled) return true;
    if (state.corrupted) {
      throw new Error("PIN configuration is corrupted on disk. Repair or remove pin_lock.json to recover.");
    }
    const now = Date.now();
    if (state.lockedOutUntil > now) {
      const mins = Math.max(1, Math.ceil((state.lockedOutUntil - now) / 60000));
      throw new Error(`Too many incorrect PIN attempts. Try again in ${mins} minute(s).`);
    }
    const clean = String(pin ?? "").trim();
    if (!clean) return false;

    const computed = Buffer.from(hashPin(clean, state.salt), "hex");
    const stored = Buffer.from(state.hash, "hex");
    const ok = computed.length === 32 && stored.length === 32 && crypto.timingSafeEqual(computed, stored);

    if (ok) {
      state.failedAttempts = 0;
      state.lockedOutUntil = 0;
      unlockedUntilNs = process.hrtime.bigint() + UNLOCK_TTL_NS;
      try { save(); } catch (err) { log("pin-guard save", err); }
      return true;
    }

    state.failedAttempts += 1;
    if (state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      state.lockedOutUntil = Date.now() + LOCKOUT_MS;
      state.failedAttempts = 0;
    }
    try { save(); } catch (err) { log("pin-guard save", err); }
    return false;
  }

  function setPin(pin, currentPin = "") {
    if (state.corrupted) {
      throw new Error("PIN configuration is corrupted on disk. Repair or remove pin_lock.json first.");
    }
    const clean = String(pin ?? "").trim();
    if (!/^\d{4,8}$/.test(clean)) throw new Error("PIN must be 4 to 8 digits.");
    if (state.enabled && !verify(currentPin)) throw new Error("Current PIN is incorrect.");
    const salt = crypto.randomBytes(16).toString("hex");
    state = { enabled: true, corrupted: false, salt, hash: hashPin(clean, salt), failedAttempts: 0, lockedOutUntil: 0 };
    unlockedUntilNs = process.hrtime.bigint() + UNLOCK_TTL_NS;
    save();
    return { enabled: true, message: "Sensitive tool PIN lock enabled." };
  }

  function disable(currentPin) {
    if (!state.enabled) return { enabled: false, message: "PIN lock is already disabled." };
    const currentlyUnlocked = !state.corrupted && process.hrtime.bigint() < unlockedUntilNs;
    if (!currentlyUnlocked && !verify(currentPin)) {
      throw new Error("Current PIN required to disable PIN lock (or unlock with PIN first).");
    }
    state = { enabled: false, corrupted: false, salt: "", hash: "", failedAttempts: 0, lockedOutUntil: 0 };
    unlockedUntilNs = 0n;
    save();
    return { enabled: false, message: "PIN lock disabled." };
  }

  function lockNow() {
    unlockedUntilNs = 0n;
    return { locked: true, message: "Sensitive tools locked." };
  }

  function needsUnlock() {
    return state.enabled && (state.corrupted || process.hrtime.bigint() >= unlockedUntilNs);
  }

  function status() {
    const isUnlocked = !state.enabled || (!state.corrupted && process.hrtime.bigint() < unlockedUntilNs);
    const lockoutRemainingSec = state.lockedOutUntil > Date.now() ? Math.ceil((state.lockedOutUntil - Date.now()) / 1000) : 0;
    return {
      enabled: state.enabled,
      corrupted: state.corrupted,
      unlocked: isUnlocked,
      lockoutRemainingSec,
      message: state.corrupted
        ? "PIN configuration corrupted (fail-closed)."
        : state.enabled
          ? (isUnlocked ? "PIN lock enabled (temporarily unlocked)." : "PIN lock enabled (locked).")
          : "PIN lock is not set.",
    };
  }

  return { setPin, verify, disable, lockNow, needsUnlock, status };
}
