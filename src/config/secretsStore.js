// Encrypted Secrets Store for Delshiv AI.
// Persists API keys and OAuth secrets in %APPDATA%\delshiv-ai\secrets.json
// encrypted via Electron safeStorage (Windows DPAPI).
import fs from "fs";
import path from "path";
import { atomicWriteJson, readJsonSafe } from "../../shared-utils.js";
import { APP_PATHS, CURRENT_SCHEMA_VERSION } from "./appConfig.js";

const SECRET_KEYS = [
  "GEMINI_API_KEY",
  "GMAIL_API_KEY",
  "TAVILY_API_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
];

export function createSecretsStore({
  filePath = APP_PATHS.secrets,
  safeStorage = null,
  onError = null,
} = {}) {
  const reportErr = (action, err) => {
    if (typeof onError === "function") onError(action, err);
  };

  function canEncrypt() {
    try {
      return Boolean(
        safeStorage &&
        typeof safeStorage.isEncryptionAvailable === "function" &&
        safeStorage.isEncryptionAvailable()
      );
    } catch {
      return false;
    }
  }

  function encryptValue(plain) {
    const str = String(plain || "").trim();
    if (!str) return null;
    if (canEncrypt()) {
      const buf = safeStorage.encryptString(str);
      return { enc: true, data: buf.toString("base64") };
    }
    // Never silently drop; mark unencrypted fallback only if DPAPI unavailable (e.g., headless CLI)
    return { enc: false, data: Buffer.from(str, "utf-8").toString("base64") };
  }

  function decryptValue(entry) {
    if (!entry || typeof entry !== "object" || !entry.data) return "";
    try {
      if (entry.enc) {
        if (!canEncrypt()) return "";
        return safeStorage.decryptString(Buffer.from(String(entry.data), "base64"));
      }
      return Buffer.from(String(entry.data), "base64").toString("utf-8");
    } catch (err) {
      reportErr("secretsStore.decryptValue", err);
      return "";
    }
  }

  function loadStore() {
    const raw = readJsonSafe(filePath, null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { _schemaVersion: CURRENT_SCHEMA_VERSION, updatedAt: new Date().toISOString(), keys: {} };
    }
    return {
      _schemaVersion: Number(raw._schemaVersion) || CURRENT_SCHEMA_VERSION,
      updatedAt: String(raw.updatedAt || new Date().toISOString()),
      keys: raw.keys && typeof raw.keys === "object" ? { ...raw.keys } : {},
    };
  }

  function getSecret(name) {
    const keyName = String(name || "").trim();
    if (!keyName) return "";
    const store = loadStore();
    const entry = store.keys[keyName];
    const fromStore = decryptValue(entry);
    if (fromStore) return fromStore;
    return String(process.env[keyName] || "").trim();
  }

  function setSecret(name, value) {
    const keyName = String(name || "").trim();
    const clean = String(value || "").trim();
    if (!keyName || !clean || /[\r\n\0]/.test(clean)) return false;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const store = loadStore();
      const encrypted = encryptValue(clean);
      if (!encrypted) return false;
      store._schemaVersion = CURRENT_SCHEMA_VERSION;
      store.updatedAt = new Date().toISOString();
      store.keys[keyName] = encrypted;
      atomicWriteJson(filePath, store);
      process.env[keyName] = clean;
      return true;
    } catch (err) {
      reportErr(`secretsStore.setSecret(${keyName})`, err);
      return false;
    }
  }

  function deleteSecret(name) {
    const keyName = String(name || "").trim();
    if (!keyName) return false;
    try {
      const store = loadStore();
      if (keyName in store.keys) {
        delete store.keys[keyName];
        store.updatedAt = new Date().toISOString();
        atomicWriteJson(filePath, store);
      }
      delete process.env[keyName];
      return true;
    } catch (err) {
      reportErr(`secretsStore.deleteSecret(${keyName})`, err);
      return false;
    }
  }

  function importFromEnvFile(envFilePath) {
    if (!envFilePath || !fs.existsSync(envFilePath)) return [];
    const imported = [];
    try {
      const content = fs.readFileSync(envFilePath, "utf-8");
      for (const name of SECRET_KEYS) {
        const re = new RegExp(`^\\s*${name}\\s*=\\s*["']?([^\\s"'#\\r\\n]+)["']?`, "m");
        const m = content.match(re);
        if (m?.[1]) {
          const val = m[1].trim();
          const existing = getSecret(name);
          if (!existing || existing !== val) {
            if (setSecret(name, val)) imported.push(name);
          } else {
            imported.push(name);
          }
        }
      }
    } catch (err) {
      reportErr(`secretsStore.importFromEnvFile(${path.basename(envFilePath)})`, err);
    }
    return imported;
  }

  /** Re-encrypt any fallback-encoded entries once Electron safeStorage is ready */
  function upgradeEncryption() {
    if (!canEncrypt()) return 0;
    const store = loadStore();
    let upgraded = 0;
    for (const [k, entry] of Object.entries(store.keys)) {
      if (entry && entry.enc === false && entry.data) {
        const plain = decryptValue(entry);
        if (plain) {
          store.keys[k] = encryptValue(plain);
          upgraded++;
        }
      }
    }
    if (upgraded > 0) {
      store.updatedAt = new Date().toISOString();
      atomicWriteJson(filePath, store);
    }
    return upgraded;
  }

  return {
    getSecret,
    setSecret,
    deleteSecret,
    importFromEnvFile,
    upgradeEncryption,
    canEncrypt,
  };
}
