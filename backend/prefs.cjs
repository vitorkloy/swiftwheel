"use strict";

/** Preferências de módulos, notificações e sons — defaults e gates. */

const DEFAULT_MODULES = {
  radial: true,
  shiftdrop: true,
  capture: true,
  preview: true,
};

/** Início de conversão desligado por padrão (#7); o resto ligado. */
const DEFAULT_NOTIFICATIONS = {
  master: true,
  captureCopied: true,
  captureSaved: true,
  fileConvertStart: false,
  fileConverted: true,
  fileConvertError: true,
  updates: true,
  other: true,
};

const DEFAULT_SOUNDS = {
  master: true,
  wheelOpen: true,
  captureShutter: true,
  convertDone: true,
};

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeModules(raw, screenshot, preview) {
  const src = raw && typeof raw === "object" ? raw : {};
  const captureFromShot = screenshot && screenshot.enabled === false ? false : true;
  const previewFromCfg = preview && preview.enabled === false ? false : true;
  return {
    radial: asBool(src.radial, true),
    shiftdrop: asBool(src.shiftdrop, true),
    capture: asBool(src.capture, captureFromShot),
    preview: asBool(src.preview, previewFromCfg),
  };
}

function normalizeNotifications(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_NOTIFICATIONS)) {
    out[key] = asBool(src[key], fallback);
  }
  return out;
}

function normalizeSounds(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SOUNDS)) {
    out[key] = asBool(src[key], fallback);
  }
  return out;
}

function moduleOn(modules, name) {
  const normalized = normalizeModules(modules);
  return normalized[name] !== false;
}

function allowsNotification(notifications, kind) {
  const n = normalizeNotifications(notifications);
  if (!n.master) return false;
  if (kind && Object.prototype.hasOwnProperty.call(n, kind)) return n[kind] !== false;
  return n.other !== false;
}

function allowsSound(sounds, kind) {
  const s = normalizeSounds(sounds);
  if (!s.master) return false;
  if (kind && Object.prototype.hasOwnProperty.call(s, kind)) return s[kind] !== false;
  return true;
}

module.exports = {
  DEFAULT_MODULES,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_SOUNDS,
  normalizeModules,
  normalizeNotifications,
  normalizeSounds,
  moduleOn,
  allowsNotification,
  allowsSound,
};
