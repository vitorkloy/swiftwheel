"use strict";

/**
 * Geometria da barra de modos da captura (issue #50).
 * Tudo em coordenadas do overlay: origem = canto do desktop virtual.
 * A barra usa o monitor DIP do cursor (mesma regra de #47); recortes de
 * janela/monitor mapeiam o bitmap físico para o overlay (DPI misto).
 */

const MODES = ["region", "window", "full"];

function normalizeCaptureMode(raw) {
  const value = String(raw || "").toLowerCase();
  if (value === "window" || value === "full") return value;
  return "region";
}

/** Atalho explícito ganha; senão o último modo (retangular se ainda não houver). */
function resolveStartMode(requested, last) {
  if (requested === "region" || requested === "window" || requested === "full") return requested;
  return normalizeCaptureMode(last);
}

function overlayMonitors(displays, origin) {
  const ox = origin && Number.isFinite(origin.x) ? origin.x : 0;
  const oy = origin && Number.isFinite(origin.y) ? origin.y : 0;
  return (displays || []).map((display) => {
    const bounds = display.bounds || display;
    return {
      x: bounds.x - ox,
      y: bounds.y - oy,
      width: bounds.width,
      height: bounds.height,
    };
  }).filter((item) => item.width > 0 && item.height > 0);
}

function monitorAtPoint(monitors, point) {
  if (!Array.isArray(monitors) || !monitors.length) return null;
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return monitors[0];
  return monitors.find((item) => rectContains(item, { x, y })) || monitors[0];
}

function modeBarPosition(monitor, barWidth, barHeight, pad = 12) {
  const width = Math.max(1, Math.round(Number(barWidth) || 0));
  const height = Math.max(1, Math.round(Number(barHeight) || 0));
  const gap = Number.isFinite(pad) ? pad : 12;
  if (!monitor) return { x: gap, y: gap, width, height };
  return {
    x: Math.round(monitor.x + (monitor.width - width) / 2),
    y: Math.round(monitor.y + gap),
    width,
    height,
  };
}

function rectContains(rect, point) {
  if (!rect || !point) return false;
  const x = Number(point.x);
  const y = Number(point.y);
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/** Janelas em z-order (a de cima primeiro), como o Recorte do Windows. */
function windowAtPoint(windows, point) {
  if (!Array.isArray(windows)) return null;
  return windows.find((item) => rectContains(item, point)) || null;
}

function physicalToOverlay(px, py, virtPhys, overlaySize) {
  const width = Math.max(1, Number(virtPhys && virtPhys.width) || 1);
  const height = Math.max(1, Number(virtPhys && virtPhys.height) || 1);
  const ox = Number(overlaySize && overlaySize.width) || 1;
  const oy = Number(overlaySize && overlaySize.height) || 1;
  const originX = Number(virtPhys && virtPhys.x) || 0;
  const originY = Number(virtPhys && virtPhys.y) || 0;
  return {
    x: ((Number(px) - originX) * ox) / width,
    y: ((Number(py) - originY) * oy) / height,
  };
}

function physicalRectToOverlay(rect, virtPhys, overlaySize) {
  if (!rect) return null;
  const a = physicalToOverlay(rect.x, rect.y, virtPhys, overlaySize);
  const b = physicalToOverlay(rect.x + rect.width, rect.y + rect.height, virtPhys, overlaySize);
  return {
    x: a.x,
    y: a.y,
    width: Math.max(1, b.x - a.x),
    height: Math.max(1, b.y - a.y),
  };
}

function mapWindowsToOverlay(windows, virtPhys, overlaySize) {
  return (windows || []).map((item) => physicalRectToOverlay(item, virtPhys, overlaySize)).filter(Boolean);
}

/**
 * Bounds físicos de um monitor Electron. `dipToScreenRect` é
 * `screen.dipToScreenRect(null, bounds)` quando existe (Windows).
 */
function displayPhysicalBounds(display, dipToScreenRect) {
  const bounds = (display && display.bounds) || display || {};
  if (typeof dipToScreenRect === "function") {
    try {
      const rect = dipToScreenRect(bounds);
      if (rect && Number.isFinite(rect.width) && rect.width > 0) {
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    } catch { /* fallback abaixo */ }
  }
  const scale = (display && display.scaleFactor) || 1;
  return {
    x: Math.round((bounds.x || 0) * scale),
    y: Math.round((bounds.y || 0) * scale),
    width: Math.round((bounds.width || 0) * scale),
    height: Math.round((bounds.height || 0) * scale),
  };
}

function mapDisplaysToOverlay(displays, origin, virtPhys, overlaySize, dipToScreenRect) {
  return (displays || []).map((display) => {
    const dip = overlayMonitors([display], origin)[0];
    const phys = displayPhysicalBounds(display, dipToScreenRect);
    const image = physicalRectToOverlay(phys, virtPhys, overlaySize);
    return { dip, image };
  }).filter((item) => item.dip && item.image);
}

module.exports = {
  MODES,
  normalizeCaptureMode,
  resolveStartMode,
  overlayMonitors,
  monitorAtPoint,
  modeBarPosition,
  rectContains,
  windowAtPoint,
  physicalToOverlay,
  physicalRectToOverlay,
  mapWindowsToOverlay,
  displayPhysicalBounds,
  mapDisplaysToOverlay,
};
