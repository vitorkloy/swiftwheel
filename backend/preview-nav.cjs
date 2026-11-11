"use strict";

/**
 * Máquina de estado da navegação da prévia.
 * O preview é a fonte da verdade: seta calcula o próximo índice, mostra esse
 * ficheiro, e só depois pede ao Explorer para selecionar (efeito colateral).
 * Ecos do SelectItem (open do mesmo path) são ignorados.
 */
const fs = require("fs");
const path = require("path");

function samePath(a, b) {
  const left = String(a || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const right = String(b || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return left.length > 0 && left === right;
}

function createNavState(paths, index) {
  const list = Array.isArray(paths) ? paths.slice() : [];
  let idx = Number(index) || 0;
  if (idx < 0 || (list.length && idx >= list.length)) idx = 0;
  if (!list.length) idx = 0;
  return {
    paths: list,
    index: idx,
    gen: 0,
    current: list[idx] || "",
    ignoreSelect: "",
  };
}

function applyView(state, paths, index) {
  const next = createNavState(paths, index);
  next.gen = state && Number(state.gen) ? Number(state.gen) : 0;
  next.ignoreSelect = (state && state.ignoreSelect) || "";
  return next;
}

/**
 * Os PIDLs relativos da view, se mal convertidos, viram Área de Trabalho\<nome>.
 * Confirma que o ficheiro existe; se não, tenta a pasta do item atual.
 */
function resolveViewItems(rawPaths, currentFile, preferredIndex) {
  const warnings = [];
  const paths = [];
  const current = currentFile ? path.resolve(String(currentFile)) : "";
  const currentDir = current ? path.dirname(current) : "";
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  for (let i = 0; i < list.length; i += 1) {
    const raw = String(list[i] || "");
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (resolved && fs.existsSync(resolved)) {
      paths.push(resolved);
      continue;
    }
    const name = path.basename(resolved || raw);
    const sibling = currentDir && name ? path.resolve(path.join(currentDir, name)) : "";
    if (sibling && sibling !== resolved && fs.existsSync(sibling)) {
      warnings.push(`viewitem inexistente (corrigido): ${resolved} → ${sibling}`);
      paths.push(sibling);
      continue;
    }
    warnings.push(`viewitem inexistente: ${resolved || raw}`);
  }
  let index = current ? paths.findIndex((item) => samePath(item, current)) : -1;
  if (index < 0) {
    index = Number(preferredIndex) || 0;
    if (index < 0 || (paths.length && index >= paths.length)) index = 0;
  }
  if (!paths.length) index = 0;
  return { paths, index, warnings };
}

function move(state, delta) {
  const list = (state && state.paths) || [];
  const step = Number(delta) || 0;
  if (!list.length || !step) return { state, action: null };
  const index = (state.index + step + list.length * 8) % list.length;
  const filePath = list[index];
  const gen = (Number(state.gen) || 0) + 1;
  const next = {
    paths: list,
    index,
    gen,
    current: state.current,
    ignoreSelect: filePath,
  };
  return {
    state: next,
    action: {
      type: "show",
      path: filePath,
      index,
      total: list.length,
      gen,
      select: filePath,
    },
  };
}

function shouldIgnoreSelect(state, filePath) {
  return !!(state && state.ignoreSelect && samePath(state.ignoreSelect, filePath));
}

function clearIgnoreSelect(state, filePath) {
  if (!shouldIgnoreSelect(state, filePath)) return state;
  return { ...state, ignoreSelect: "" };
}

function acceptShow(state, filePath, gen) {
  if (Number(gen) !== Number(state.gen)) {
    return { state, accepted: false, reason: "stale" };
  }
  const idx = (state.paths || []).findIndex((item) => samePath(item, filePath));
  const index = idx >= 0 ? idx : state.index;
  return {
    state: {
      ...state,
      current: filePath,
      index,
      ignoreSelect: filePath,
    },
    accepted: true,
    reason: "ok",
  };
}

function debugLog(line, opts) {
  const enabled = opts && opts.enabled;
  if (!enabled) return null;
  const appData = (opts && opts.appData) || "";
  if (!appData) return null;
  const dir = path.join(appData, "SwiftWheel", "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "preview.log");
  fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" });
  return file;
}

module.exports = {
  samePath,
  createNavState,
  applyView,
  resolveViewItems,
  move,
  shouldIgnoreSelect,
  clearIgnoreSelect,
  acceptShow,
  debugLog,
};
