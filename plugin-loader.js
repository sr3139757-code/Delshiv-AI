// Dynamic Plugin / Custom Tool Loader for Delshiv AI.
// Loads regular .js/.mjs files from pluginsDirs that export { name, description, run(payload) }.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const PLUGIN_TIMEOUT_MS = 30_000;

export function createPluginLoader({ dirs = [], log = () => {} }) {
  let plugins = new Map();
  let reloadPromise = null;

  async function doReload() {
    const nextPlugins = new Map();
    const loaded = [];
    const errors = [];

    for (const dir of dirs) {
      if (!dir) continue;
      try { fs.mkdirSync(dir, { recursive: true }); } catch { continue; }
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => /\.(js|mjs)$/i.test(f)); } catch { continue; }

      for (const f of files) {
        const full = path.join(dir, f);
        try {
          const lst = fs.lstatSync(full);
          if (!lst.isFile() || lst.isSymbolicLink()) {
            throw new Error("Skipped non-regular file or symlink.");
          }
          const mod = await import(`${pathToFileURL(full).href}?t=${Date.now()}`);
          const def = mod.default || mod;
          const name = String(def?.name || "").trim();
          if (name.length < 2 || typeof def?.run !== "function") {
            throw new Error("Plugin must export { name (>=2 chars), description, run(payload) }.");
          }
          if (nextPlugins.has(name)) {
            throw new Error(`Duplicate plugin name "${name}" ignored.`);
          }
          nextPlugins.set(name, {
            name,
            description: String(def.description || "Custom plugin tool"),
            file: full,
            run: def.run,
          });
          loaded.push(name);
        } catch (err) {
          errors.push({ file: f, error: err?.message || String(err) });
          log(`plugin-loader (${f})`, err);
        }
      }
    }

    plugins = nextPlugins;
    return { loaded, errors, dirs };
  }

  function reload() {
    if (reloadPromise) return reloadPromise;
    reloadPromise = doReload().finally(() => {
      reloadPromise = null;
    });
    return reloadPromise;
  }

  function list() {
    return [...plugins.values()].map(({ name, description, file }) => ({ name, description, file }));
  }

  async function run(name, payload = {}) {
    const key = String(name || "").trim();
    const p = plugins.get(key);
    if (!p) throw new Error(`Plugin "${name}" not found. Use managePlugins(operation="list") to see loaded plugins.`);

    let timer = null;
    try {
      const res = await Promise.race([
        Promise.resolve(p.run(payload)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Plugin "${key}" timed out after ${PLUGIN_TIMEOUT_MS}ms.`)), PLUGIN_TIMEOUT_MS);
        }),
      ]);
      if (Array.isArray(res)) return { ok: true, result: res };
      if (typeof res === "object" && res !== null) return { ok: true, ...res };
      return { ok: true, message: String(res ?? "Done.") };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { reload, list, run };
}
