"use strict";

const fs = require("fs");
const path = require("path");
const { USER_DATA_DIRNAME, LEGACY_USER_DATA_DIRNAMES } = require("./product.cjs");

/**
 * Ficheiros/pastas que contam como perfil real. Uma pasta só com caches do Chromium
 * (GPUCache, Code Cache, …) conta como vazia — migramos para cima dela.
 */
const PROFILE_MARKERS = [
  "config-v2.json",
  "config-v2.json.bak",
  "settings.json",
  "license-device.json",
  "icon-cache.json",
  "custom-icons",
  ".env.local",
  "rovyl-persistence.log",
  "zenith-persistence.log",
];

/**
 * Caches do Chromium: grandes, voláteis, e o processo novo recria-os.
 * Tudo o resto (prefs, workspaces, ícones, licença, logs de persistência) copia.
 */
const SKIP_DIR_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "CachedData",
  "Crashpad",
  "CrashpadMetrics-active",
  "VideoDecodeStats",
  "blob_storage",
  "Service Worker",
  "Session Storage",
  "Local Storage",
  "IndexedDB",
  "Network",
  "Partitions",
  "shared_proto_db",
  "logs",
]);

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function hasProfile(dir) {
  if (!dir || !pathExists(dir)) return false;
  return PROFILE_MARKERS.some((name) => pathExists(path.join(dir, name)));
}

function copyTree(src, dest) {
  const copied = [];
  const walk = (from, to, isRoot) => {
    let st;
    try {
      st = fs.lstatSync(from);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (!isRoot && SKIP_DIR_NAMES.has(path.basename(from))) return;
      fs.mkdirSync(to, { recursive: true });
      let entries = [];
      try {
        entries = fs.readdirSync(from, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        walk(path.join(from, entry.name), path.join(to, entry.name), false);
      }
      return;
    }
    if (!st.isFile()) return;
    if (pathExists(to)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied.push(path.relative(dest, to).split(path.sep).join("/"));
  };
  walk(src, dest, true);
  return copied;
}

/**
 * Resolve a pasta de perfil SwiftWheel em `appData`.
 * Se a pasta nova não existir ou estiver vazia (sem marcadores de perfil) e houver
 * um perfil legado (VOR, depois Zenith), copia os ficheiros. Idempotente: nunca
 * sobrescreve destinos já presentes e não apaga a pasta antiga.
 *
 * @param {string} appDataPath  `app.getPath("appData")`
 * @param {{ log?: (msg: string) => void, destName?: string, legacyNames?: string[] }} [options]
 */
function migrateUserDataIfNeeded(appDataPath, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const destName = options.destName || USER_DATA_DIRNAME;
  const legacyNames = options.legacyNames || LEGACY_USER_DATA_DIRNAMES;
  const dest = path.join(appDataPath, destName);

  if (hasProfile(dest)) {
    return { userDataDir: dest, migratedFrom: null, copied: [], skipped: true };
  }

  const source = legacyNames
    .map((name) => path.join(appDataPath, name))
    .find((dir) => hasProfile(dir));

  if (!source) {
    fs.mkdirSync(dest, { recursive: true });
    return { userDataDir: dest, migratedFrom: null, copied: [], skipped: false };
  }

  fs.mkdirSync(dest, { recursive: true });
  const copied = copyTree(source, dest);
  log(
    `[Persist] Migrated profile ${path.basename(source)} → ${path.basename(dest)} (${copied.length} files); source kept`,
  );
  return { userDataDir: dest, migratedFrom: source, copied, skipped: false };
}

module.exports = {
  USER_DATA_DIRNAME,
  LEGACY_USER_DATA_DIRNAMES,
  PROFILE_MARKERS,
  SKIP_DIR_NAMES,
  hasProfile,
  copyTree,
  migrateUserDataIfNeeded,
};
