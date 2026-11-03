"use strict";

/**
 * Captura de tela offline. O frame vem do desktopCapturer no processo principal,
 * antes de a janela de anotação existir, para o VOR não sair na foto.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  BrowserWindow,
  clipboard,
  desktopCapturer,
  nativeImage,
  Notification,
  protocol,
  screen,
} = require("electron");

const DEFAULT_SCREENSHOT = {
  enabled: true,
  shortcutRegion: "PrintScreen",
  shortcutFull: "Shift+PrintScreen",
  shortcutWindow: "Alt+PrintScreen",
  format: "png",
  quality: 92,
  copyOnSelect: false,
  showToasts: true,
  rememberRegion: false,
  includeCursor: false,
  saveDirectory: "",
  lastRegion: null,
  wheelSeeded: false,
};

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function normalizeAccelerator(raw) {
  const parts = String(raw || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = [];
  let key = "";
  for (const part of parts) {
    const token = part.toLowerCase().replace(/\s+/g, "");
    if (token === "ctrl" || token === "control" || token === "commandorcontrol") mods.push("CommandOrControl");
    else if (token === "alt" || token === "option") mods.push("Alt");
    else if (token === "shift") mods.push("Shift");
    else if (token === "super" || token === "meta" || token === "win" || token === "cmd" || token === "command") mods.push("Super");
    else if (token === "printscreen" || token === "prtsc" || token === "snapshot") key = "PrintScreen";
    else key = part.length === 1 ? part.toUpperCase() : part;
  }
  return [...mods, key].filter(Boolean).join("+");
}

const MODIFIER_KEYS = new Set([
  "LEFT CTRL", "RIGHT CTRL", "LEFT ALT", "RIGHT ALT",
  "LEFT SHIFT", "RIGHT SHIFT", "LEFT META", "RIGHT META", "WINDOWS",
]);

/**
 * O Print Screen do Windows chega com um Shift fantasma (o prefixo E0 2A).
 * Um Shift carregado de verdade já estava premido antes desse instante.
 */
function createShortcutTracker() {
  let shiftAt = 0;
  return {
    note(event) {
      const name = String(event && event.name || "");
      if (!name.includes("SHIFT")) return;
      if (event.state === "DOWN") {
        if (!shiftAt) shiftAt = Date.now();
      } else {
        shiftAt = 0;
      }
    },
    format(event, down) {
      if (!event || event.state !== "DOWN") return "";
      const name = String(event.name || "");
      if (!name || MODIFIER_KEYS.has(name)) return "";
      let key = name;
      if (/print\s*screen|prtsc|snapshot/i.test(key)) key = "PrintScreen";
      else if (key === "SPACE") key = "Space";
      else if (key === "ESCAPE") key = "Escape";
      else if (key.length === 1) key = key.toUpperCase();
      const mods = { ctrl: false, alt: false, shift: false, meta: false };
      for (const [keyName, held] of Object.entries(down || {})) {
        if (!held) continue;
        if (keyName.includes("CTRL")) mods.ctrl = true;
        if (keyName.includes("ALT")) mods.alt = true;
        if (keyName.includes("SHIFT")) mods.shift = true;
        if (keyName.includes("META") || keyName.includes("WINDOWS")) mods.meta = true;
      }
      if (key === "PrintScreen" && mods.shift && shiftAt && Date.now() - shiftAt < 40) {
        mods.shift = false;
      }
      const parts = [];
      if (mods.ctrl) parts.push("Ctrl");
      if (mods.alt) parts.push("Alt");
      if (mods.shift) parts.push("Shift");
      if (mods.meta) parts.push("Super");
      parts.push(key);
      return parts.join("+");
    },
  };
}

function bufferFromDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error("imagem inválida");
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("imagem fora do tamanho aceite");
  return { mime: match[1].toLowerCase(), buffer };
}

function extensionFor(mime, format) {
  if (mime.includes("jpeg") || format === "jpeg") return "jpg";
  if (mime.includes("webp") || format === "webp") return "webp";
  return "png";
}

function installScreenshot(ctx) {
  let overlay = null;
  let busy = false;
  let frameFile = "";
  let pendingSession = null;
  let revealOverlay = () => {};
  let shortcutsPaused = false;
  /** @type {Map<string, "region" | "full" | "window">} */
  let shortcutBindings = new Map();
  let shortcutListener = null;
  const shortcutTracker = createShortcutTracker();
  const pins = new Set();

  protocol.handle("vor-shot", () => {
    if (!frameFile || !fs.existsSync(frameFile)) {
      return new Response("missing", { status: 404 });
    }
    const body = fs.readFileSync(frameFile);
    return new Response(body, {
      headers: {
        "content-type": "image/png",
        "content-length": String(body.length),
        "cache-control": "no-store",
      },
    });
  });

  const publishFrame = (image) => {
    const dir = path.join(os.tmpdir(), "vor-shot-frame");
    fs.mkdirSync(dir, { recursive: true });
    frameFile = path.join(dir, "frame.png");
    fs.writeFileSync(frameFile, image.toPNG());
    return `vor-shot://frame/${Date.now()}`;
  };

  const settings = () => ({ ...DEFAULT_SCREENSHOT, ...(ctx.getScreenshotSettings() || {}) });

  const toast = (body) => {
    if (!settings().showToasts || !body) return;
    try {
      new Notification({ title: "VOR", body: String(body) }).show();
    } catch (e) {
      ctx.diagLog(`[Screenshot] toast: ${e.message}`);
    }
  };

  const saveDirectory = () => {
    const configured = String(settings().saveDirectory || "").trim();
    if (configured && fs.existsSync(configured)) return configured;
    const dir = path.join(ctx.app.getPath("pictures"), "Capturas de Tela");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const stampName = (ext) => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `VOR_${stamp}.${ext}`;
  };

  const writeImage = (dataUrl, format) => {
    const decoded = bufferFromDataUrl(dataUrl);
    const ext = extensionFor(decoded.mime, format);
    const file = path.join(saveDirectory(), stampName(ext));
    fs.writeFileSync(file, decoded.buffer);
    return file;
  };

  const copyImage = (dataUrl) => {
    const decoded = bufferFromDataUrl(dataUrl);
    const image = nativeImage.createFromBuffer(decoded.buffer);
    if (image.isEmpty()) throw new Error("não foi possível ler a imagem para o clipboard");
    clipboard.writeImage(image);
  };

  const closeOverlay = () => {
    pendingSession = null;
    const win = overlay;
    overlay = null;
    if (win && !win.isDestroyed()) win.close();
  };

  const pinImage = (dataUrl, width, height) => {
    const decoded = bufferFromDataUrl(dataUrl);
    const png = nativeImage.createFromBuffer(decoded.buffer);
    const buffer = png.isEmpty() ? decoded.buffer : png.toPNG();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vor-pin-"));
    fs.writeFileSync(path.join(dir, "shot.png"), buffer);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#111;overflow:hidden}
        img{width:100%;height:100%;object-fit:contain;display:block;-webkit-app-region:drag}
      </style></head><body><img src="shot.png" alt=""><script>
        document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.close(); });
      </script></body></html>`,
    );
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const win = new BrowserWindow({
      width: Math.max(160, Math.min(Math.round(width || 480), area.width - 48)),
      height: Math.max(120, Math.min(Math.round(height || 320), area.height - 48)),
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      autoHideMenuBar: true,
      backgroundColor: "#111111",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    pins.add(win);
    win.on("closed", () => {
      pins.delete(win);
      fs.rm(dir, { recursive: true, force: true }, () => {});
    });
    win.removeMenu();
    void win.loadFile(path.join(dir, "index.html"));
  };

  const hideOurWindows = () => {
    const main = ctx.getMainWindow();
    if (main && !main.isDestroyed() && main.isVisible()) {
      try { main.hide(); } catch { /* ignore */ }
    }
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) {
      try { overlay.hide(); } catch { /* ignore */ }
    }
  };

  const grabDisplay = async (display) => {
    const scale = display.scaleFactor || 1;
    const width = Math.max(1, Math.round(display.size.width * scale));
    const height = Math.max(1, Math.round(display.size.height * scale));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const displays = screen.getAllDisplays();
    const index = displays.findIndex((item) => item.id === display.id);
    const source = sources.find((item) => String(item.display_id) === String(display.id))
      || sources[index]
      || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("captura vazia");
    return source.thumbnail;
  };

  const activeWindowRect = async (display) => {
    const getActive = ctx.getActiveWin();
    if (!getActive) return null;
    let info = null;
    try { info = await getActive(); } catch { return null; }
    const bounds = info && info.bounds;
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width < 8) return null;
    if (info.owner?.processId === process.pid) return null;
    let { x, y, width, height } = bounds;
    const scale = display.scaleFactor || 1;
    const screenBounds = display.bounds;
    if (scale > 1 && (width > screenBounds.width * 1.25 || height > screenBounds.height * 1.25)) {
      x /= scale;
      y /= scale;
      width /= scale;
      height /= scale;
    }
    const left = Math.max(screenBounds.x, x);
    const top = Math.max(screenBounds.y, y);
    const right = Math.min(screenBounds.x + screenBounds.width, x + width);
    const bottom = Math.min(screenBounds.y + screenBounds.height, y + height);
    if (right - left < 8 || bottom - top < 8) return null;
    return {
      x: Math.round(left - screenBounds.x),
      y: Math.round(top - screenBounds.y),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
    };
  };

  const openOverlay = async (display, session) => {
    closeOverlay();
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      autoHideMenuBar: true,
      backgroundColor: "#000000",
      opacity: 0,
      webPreferences: {
        preload: ctx.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    overlay = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.removeMenu();
    win.on("closed", () => {
      if (overlay === win) overlay = null;
    });
    let revealed = false;
    const fadeIn = () => {
      if (win.isDestroyed()) return;
      const started = Date.now();
      const duration = 140;
      const tick = () => {
        if (win.isDestroyed()) return;
        const t = Math.min(1, (Date.now() - started) / duration);
        const eased = 1 - (1 - t) * (1 - t);
        win.setOpacity(eased);
        if (t < 1) setTimeout(tick, 16);
        else win.setOpacity(1);
      };
      tick();
    };
    const reveal = () => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      win.setOpacity(0);
      win.show();
      win.focus();
      fadeIn();
      win.webContents.send("screenshot-visible");
    };
    revealOverlay = reveal;
    pendingSession = session;
    if (ctx.isDev) await win.loadURL("http://localhost:5173/capture.html");
    else await win.loadFile(ctx.captureHtmlPath);
    if (win.isDestroyed()) return;
    win.setBounds(display.bounds);
    win.webContents.send("screenshot-session", session);
    const timer = setTimeout(reveal, 900);
    win.once("closed", () => clearTimeout(timer));
  };

  const capture = async (mode) => {
    const cfg = settings();
    if (cfg.enabled === false || busy) return;
    if (overlay && !overlay.isDestroyed()) return;
    busy = true;
    ctx.setGrabbing(true);
    try {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      const cursor = {
        x: point.x - display.bounds.x,
        y: point.y - display.bounds.y,
      };
      let preset = null;
      if (mode === "window") preset = await activeWindowRect(display);
      else if (mode === "region" && cfg.rememberRegion && cfg.lastRegion) preset = cfg.lastRegion;
      hideOurWindows();
      await new Promise((resolve) => setTimeout(resolve, 40));
      hideOurWindows();
      const image = await grabDisplay(display);

      if (mode === "full") {
        clipboard.writeImage(image);
        toast(ctx.language() === "pt" ? "Tela copiada." : "Screen copied.");
        return;
      }

      const language = ctx.language() === "pt" ? "pt" : "en";
      await openOverlay(display, {
        frameUrl: publishFrame(image),
        mode: mode === "window" ? "window" : "region",
        width: display.bounds.width,
        height: display.bounds.height,
        preset,
        cursor: cfg.includeCursor ? cursor : null,
        copyOnSelect: !!cfg.copyOnSelect,
        format: cfg.format === "jpeg" || cfg.format === "webp" ? cfg.format : "png",
        quality: Math.min(100, Math.max(50, Number(cfg.quality) || 92)),
        language,
      });
    } catch (e) {
      ctx.diagLog(`[Screenshot] ${e.message}`);
      toast(ctx.language() === "pt" ? "Não foi possível capturar a tela." : "Could not capture the screen.");
    } finally {
      ctx.setGrabbing(false);
      busy = false;
    }
  };

  const ensureShortcutListener = () => {
    if (shortcutListener) return;
    try {
      const { GlobalKeyboardListener } = require("node-global-key-listener");
      shortcutListener = new GlobalKeyboardListener();
      void shortcutListener.addListener((event, down) => {
        shortcutTracker.note(event);
        if (shortcutsPaused) return;
        const pressed = shortcutTracker.format(event, down);
        if (!pressed) return;
        const mode = shortcutBindings.get(normalizeAccelerator(pressed).toLowerCase());
        if (!mode) return;
        void capture(mode);
        return true;
      }).catch((e) => ctx.diagLog(`[Screenshot] listener: ${e.message}`));
    } catch (e) {
      ctx.diagLog(`[Screenshot] listener: ${e.message}`);
    }
  };

  const registerShortcuts = () => {
    let cfg = settings();
    const region = normalizeAccelerator(cfg.shortcutRegion);
    const full = normalizeAccelerator(cfg.shortcutFull);
    if (region && region.toLowerCase() === full.toLowerCase() && typeof ctx.replaceScreenshotSettings === "function") {
      cfg = {
        ...cfg,
        shortcutRegion: DEFAULT_SCREENSHOT.shortcutRegion,
        shortcutFull: DEFAULT_SCREENSHOT.shortcutFull,
        shortcutWindow: DEFAULT_SCREENSHOT.shortcutWindow,
      };
      ctx.replaceScreenshotSettings(cfg);
    }
    shortcutBindings = new Map();
    if (cfg.enabled === false) return;
    const pairs = [
      [cfg.shortcutRegion, "region"],
      [cfg.shortcutFull, "full"],
      [cfg.shortcutWindow, "window"],
    ];
    for (const [raw, mode] of pairs) {
      const accelerator = normalizeAccelerator(raw).toLowerCase();
      if (!accelerator || shortcutBindings.has(accelerator)) continue;
      shortcutBindings.set(accelerator, mode);
      ctx.diagLog(`[Screenshot] atalho ${accelerator} → ${mode}`);
    }
    ensureShortcutListener();
  };

  ctx.ipcMain.handle("screenshot-action", async (event, payload) => {
    if (!overlay || overlay.isDestroyed() || event.sender !== overlay.webContents) {
      return { ok: false, error: "origem inválida" };
    }
    const action = payload && payload.action;
    try {
      if (action === "ready") {
        revealOverlay();
        return { ok: true };
      }
      if (action === "cancel") {
        closeOverlay();
        return { ok: true };
      }
      if (action === "remember") {
        if (!settings().rememberRegion) return { ok: true };
        const region = payload.region;
        if (region && Number.isFinite(region.x) && Number.isFinite(region.width) && region.width > 4) {
          ctx.rememberRegion({
            x: Math.round(region.x),
            y: Math.round(region.y),
            width: Math.round(region.width),
            height: Math.round(region.height),
          });
        }
        return { ok: true };
      }
      if (action === "copy") {
        copyImage(payload.pngDataUrl || payload.dataUrl);
        toast(ctx.language() === "pt" ? "Captura copiada." : "Capture copied.");
        return { ok: true };
      }
      if (action === "save" || action === "wheel") {
        const file = writeImage(payload.dataUrl, settings().format);
        if (action === "save") {
          toast(ctx.language() === "pt" ? "Captura guardada." : "Capture saved.");
          return { ok: true, file };
        }
        closeOverlay();
        const built = ctx.buildFileWheel(file);
        const point = screen.getCursorScreenPoint();
        setTimeout(() => ctx.showFileWheelAtCursor(built, point.x, point.y), 60);
        return { ok: true, file };
      }
      if (action === "pin") {
        pinImage(payload.pngDataUrl || payload.dataUrl, payload.width, payload.height);
        closeOverlay();
        return { ok: true };
      }
      return { ok: false, error: "ação desconhecida" };
    } catch (e) {
      ctx.diagLog(`[Screenshot] ${action}: ${e.message}`);
      return { ok: false, error: e.message };
    }
  });

  ctx.ipcMain.handle("screenshot-pending", () => pendingSession);

  ctx.ipcMain.handle("start-screenshot", async (_event, mode) => {
    const next = mode === "full" || mode === "window" ? mode : "region";
    await capture(next);
    return { ok: true };
  });

  return {
    capture,
    registerShortcuts,
    normalizeAccelerator,
    setShortcutsPaused: (value) => { shortcutsPaused = !!value; },
  };
}

module.exports = {
  DEFAULT_SCREENSHOT,
  installScreenshot,
  normalizeAccelerator,
  createShortcutTracker,
};
