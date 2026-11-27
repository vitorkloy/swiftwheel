"use strict";

/**
 * Janelas temporárias do SwiftWheel e os Virtual Desktops do Windows.
 *
 * Um BrowserWindow reaproveitado (overlay de captura, preview, toast) fica preso
 * na desktop em que nasceu. `focus()` / `show()` / `moveTop()` nesse HWND faz o
 * Windows ativar essa desktop — o utilizador está na 1, cola o print e cai na 2.
 *
 * Ordem que não troca a desktop: pin/mover → showInactive → focus só depois,
 * e só se o HWND já está na desktop atual. Ao estacionar, devolver o foreground
 * à app de origem ANTES de setFocusable(false), senão o Windows escolhe outra
 * janela do processo (main/preview) noutro desktop.
 */

function hwndFromHandle(handle) {
  if (!handle || typeof handle.length !== "number" || handle.length < 4) return "";
  try {
    const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    if (value === 0n) return "";
    return value.toString();
  } catch {
    return "";
  }
}

function hwndFromWindow(win) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return "";
  if (typeof win.getNativeWindowHandle !== "function") return "";
  try {
    return hwndFromHandle(win.getNativeWindowHandle());
  } catch {
    return "";
  }
}

function pinToAllWorkspaces(win) {
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
  if (typeof win.setVisibleOnAllWorkspaces !== "function") return false;
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    return true;
  } catch {
    return false;
  }
}

function captureActivateSteps({ hwnd, helperReady, movedToCurrentDesktop }) {
  const steps = ["pin-all-workspaces"];
  if (hwnd && helperReady) steps.push("todesktop");
  steps.push("show-inactive");
  steps.push("topmost");
  // SetForegroundWindow num HWND de outra desktop é o que troca a área de trabalho.
  if (movedToCurrentDesktop !== false) steps.push("focus");
  return steps;
}

function captureParkSteps({ helperReady }) {
  const steps = [];
  if (helperReady) steps.push("restorefg");
  steps.push("unfocus");
  return steps;
}

function shouldRecreateOverlay({ movedToCurrentDesktop, platform = process.platform }) {
  if (platform !== "win32") return false;
  // Só reutiliza o HWND se o helper confirmou IVirtualDesktopManager.MoveWindowToDesktop.
  return movedToCurrentDesktop !== true;
}

function activateCaptureOverlay(win, opts = {}) {
  const hwnd = opts.hwnd || hwndFromWindow(win);
  const helperSend = opts.helperSend;
  pinToAllWorkspaces(win);
  if (hwnd && typeof helperSend === "function") helperSend(`todesktop ${hwnd}`);
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
    return { hwnd, requestedMove: !!(hwnd && helperSend) };
  }
  try { win.setFocusable(true); } catch { /* ignore */ }
  try { win.setIgnoreMouseEvents(false); } catch { /* ignore */ }
  try {
    if (typeof win.showInactive === "function") win.showInactive();
  } catch { /* ignore */ }
  try { win.setAlwaysOnTop(true, "screen-saver"); } catch { /* ignore */ }
  try { if (typeof win.moveTop === "function") win.moveTop(); } catch { /* ignore */ }
  if (opts.allowFocus !== false) {
    try { win.focus(); } catch { /* ignore */ }
  }
  return { hwnd, requestedMove: !!(hwnd && helperSend) };
}

function parkCaptureOverlay(win, opts = {}) {
  const helperSend = opts.helperSend;
  if (typeof helperSend === "function") helperSend("restorefg");
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return;
  try { win.setOpacity(0); } catch { /* ignore */ }
  try { win.setIgnoreMouseEvents(true); } catch { /* ignore */ }
  try { win.setAlwaysOnTop(false); } catch { /* ignore */ }
  try { win.setFocusable(false); } catch { /* ignore */ }
  try {
    if (win.webContents && typeof win.webContents.send === "function") {
      win.webContents.send("screenshot-session", null);
    }
  } catch { /* ignore */ }
}

function presentInactiveOnCurrentDesktop(win, opts = {}) {
  const hwnd = opts.hwnd || hwndFromWindow(win);
  const helperSend = opts.helperSend;
  pinToAllWorkspaces(win);
  if (hwnd && typeof helperSend === "function") helperSend(`todesktop ${hwnd}`);
  if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return hwnd;
  try {
    if (typeof win.showInactive === "function") win.showInactive();
  } catch {
    try { if (typeof win.show === "function") win.show(); } catch { /* ignore */ }
  }
  return hwnd;
}

module.exports = {
  hwndFromHandle,
  hwndFromWindow,
  pinToAllWorkspaces,
  captureActivateSteps,
  captureParkSteps,
  shouldRecreateOverlay,
  activateCaptureOverlay,
  parkCaptureOverlay,
  presentInactiveOnCurrentDesktop,
};
