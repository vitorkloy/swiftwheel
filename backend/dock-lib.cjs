"use strict";

/**
 * Defaults e geometria da Dock — puro, sem Electron.
 * Sem AppBar: a janela flutua sobre o monitor (`bounds`), nunca sobre `workArea`.
 */

const DEFAULT_DOCK = {
  enabled: false,
  iconSize: 48,
  liftPx: 6,
  magnification: false,
  autoHide: true,
  autoHideDelayMs: 150,
  position: "bottom",
  monitor: "follow-mouse",
  pins: [],
  pinsSeeded: false,
};

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normalizeDockPin(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const command = String(raw.command || "").trim();
  if (!command) return null;
  const commandType = raw.commandType === "url" || raw.commandType === "folder" ? raw.commandType : "app";
  return {
    id: String(raw.id || `pin-${index}`),
    label: String(raw.label || command).slice(0, 120),
    command,
    commandType,
    iconPath: typeof raw.iconPath === "string" ? raw.iconPath : "",
  };
}

function normalizeDockSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const pins = Array.isArray(src.pins) ? src.pins.map(normalizeDockPin).filter(Boolean) : [];
  return {
    enabled: src.enabled === true,
    iconSize: clamp(src.iconSize, 32, 80, DEFAULT_DOCK.iconSize),
    liftPx: clamp(src.liftPx, 0, 24, DEFAULT_DOCK.liftPx),
    magnification: src.magnification === true,
    autoHide: src.autoHide !== false,
    autoHideDelayMs: clamp(src.autoHideDelayMs, 0, 2000, DEFAULT_DOCK.autoHideDelayMs),
    position: src.position === "left" || src.position === "right" ? src.position : "bottom",
    monitor: src.monitor === "primary" ? "primary" : "follow-mouse",
    pins,
    pinsSeeded: src.pinsSeeded === true,
  };
}

/** Pins já gravados, ou a semente da taskbar só na primeira vez. */
function pinsForMerge(settings, seedPins) {
  const cfg = normalizeDockSettings(settings);
  if (cfg.pinsSeeded) return cfg.pins;
  if (cfg.pins.length) return cfg.pins;
  return Array.isArray(seedPins) ? seedPins : [];
}

function sameCommand(a, b) {
  const left = String(a || "").trim().toLowerCase();
  const right = String(b || "").trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  const base = (value) => value.replace(/^"+|"+$/g, "").replace(/\//g, "\\").replace(/\.exe$/i, "");
  return base(left) === base(right);
}

function dockChrome(settings) {
  const cfg = normalizeDockSettings(settings);
  const mag = cfg.magnification ? Math.round(cfg.iconSize * 0.35) : 0;
  return {
    mag,
    pad: 12,
    indicator: 8,
    gap: 8,
    pillPad: 16,
    trayMin: 120,
    thickness: cfg.iconSize + cfg.liftPx + mag + 8 + 24,
    /** Altura do botão na coluna (ícone + lift + indicador), ver `.dk-item`. */
    itemButton: cfg.iconSize + cfg.liftPx + 8,
    /** Mini tray empilhado: margem, borda, padding, relógio e até 5 chips. */
    trayVertical: 8 + 1 + 10 + 26 + 5 * 28 + 4 * 6 + 8,
    rootPad: 16,
    pillPadSide: 28,
    pillGap: 4,
  };
}

/**
 * Rect da janela Electron no monitor. Usa o rect cheio do ecrã — sem reservar
 * área de trabalho (issue #53: auto-hide não deve encolher o workArea).
 */
function dockWindowBounds(monitor, settings, itemCount) {
  const cfg = normalizeDockSettings(settings);
  const chrome = dockChrome(cfg);
  const n = Math.max(0, Number(itemCount) || 0);
  const itemsSpan = chrome.pillPad * 2 + n * cfg.iconSize + Math.max(0, n - 1) * chrome.gap + 12 + chrome.trayMin;
  const mon = monitor || { x: 0, y: 0, width: 1920, height: 1080 };
  if (cfg.position === "left" || cfg.position === "right") {
    const width = chrome.thickness;
    const itemsH = n * chrome.itemButton + Math.max(0, n - 1) * chrome.gap;
    const content = chrome.rootPad + chrome.pillPadSide + itemsH + chrome.pillGap + chrome.trayVertical;
    const height = Math.min(mon.height - 16, Math.max(220, content));
    const y = mon.y + Math.round((mon.height - height) / 2);
    const x = cfg.position === "left" ? mon.x : mon.x + mon.width - width;
    return { x, y, width, height };
  }
  const width = Math.min(mon.width - 16, Math.max(240, itemsSpan));
  const height = chrome.thickness;
  const x = mon.x + Math.round((mon.width - width) / 2);
  const y = mon.y + mon.height - height;
  return { x, y, width, height };
}

function pointInRect(rect, point) {
  if (!rect || !point) return false;
  return point.x >= rect.x && point.y >= rect.y
    && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

function pickMonitor(displays, cursor, mode) {
  const list = Array.isArray(displays) ? displays : [];
  const primary = list.find((d) => d && d.primary) || list[0] || {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    primary: true,
  };
  if (mode === "primary") return primary.bounds;
  const hit = list.find((d) => d && pointInRect(d.bounds, cursor));
  return (hit || primary).bounds;
}

function cursorOnEdge(monitor, cursor, position, slop) {
  if (!monitor || !cursor) return false;
  const edge = slop == null ? 2 : clamp(slop, 0, 40, 2);
  if (position === "left") return cursor.x <= monitor.x + edge;
  if (position === "right") return cursor.x >= monitor.x + monitor.width - 1 - edge;
  return cursor.y >= monitor.y + monitor.height - 1 - edge;
}

function mergeDockItems(pins, running) {
  const pinList = Array.isArray(pins) ? pins.map(normalizeDockPin).filter(Boolean) : [];
  const runList = Array.isArray(running) ? running : [];
  const items = [];
  const seen = new Set();
  for (const pin of pinList) {
    const key = pin.command.toLowerCase();
    seen.add(key);
    const matches = runList.filter((app) => sameCommand(app.command || app.path, pin.command));
    items.push({
      id: pin.id,
      label: pin.label,
      command: pin.command,
      commandType: pin.commandType || "app",
      iconPath: pin.iconPath || (matches[0] && matches[0].path) || "",
      pinned: true,
      running: matches.length > 0,
      hwnds: matches.flatMap((app) => app.hwnds || (app.hwnd ? [app.hwnd] : [])),
    });
  }
  for (const app of runList) {
    const command = String(app.command || app.path || "").trim();
    if (!command) continue;
    if (seen.has(command.toLowerCase())) continue;
    if (pinList.some((pin) => sameCommand(pin.command, command))) continue;
    seen.add(command.toLowerCase());
    items.push({
      id: app.id || `run-${command}`,
      label: app.label || command,
      command,
      commandType: "app",
      iconPath: app.path || command,
      pinned: false,
      running: true,
      hwnds: app.hwnds || (app.hwnd ? [app.hwnd] : []),
    });
  }
  return items;
}

/** stdin ainda aceita write — não usar depois de exit/close (EPIPE). */
function helperStdinWritable(stdin) {
  return !!(stdin && stdin.destroyed !== true && stdin.writableEnded !== true && stdin.writable !== false);
}

function helperChildAlive(child) {
  return !!(child && child.killed !== true && child.exitCode == null && helperStdinWritable(child.stdin));
}

function writeHelperLine(stdin, line) {
  if (!helperStdinWritable(stdin)) return false;
  try {
    stdin.write(`${line}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** EPIPE/ECONNRESET no pipe não pode virar uncaughtException no main. */
function guardHelperPipes(child, onError) {
  if (!child) return;
  const swallow = (err) => {
    if (typeof onError === "function") {
      try { onError(err); } catch { /* ignore */ }
    }
  };
  if (child.stdin && typeof child.stdin.on === "function") child.stdin.on("error", swallow);
  if (child.stdout && typeof child.stdout.on === "function") child.stdout.on("error", swallow);
  if (child.stderr && typeof child.stderr.on === "function") child.stderr.on("error", swallow);
  if (typeof child.on === "function") child.on("error", swallow);
}

module.exports = {
  DEFAULT_DOCK,
  normalizeDockSettings,
  normalizeDockPin,
  dockChrome,
  dockWindowBounds,
  pickMonitor,
  cursorOnEdge,
  mergeDockItems,
  pinsForMerge,
  sameCommand,
  pointInRect,
  helperStdinWritable,
  helperChildAlive,
  writeHelperLine,
  guardHelperPipes,
};
