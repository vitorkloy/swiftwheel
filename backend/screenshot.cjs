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
  let warmShell = null;
  let busy = false;
  let frameFile = "";
  let pendingSession = null;
  let revealOverlay = () => {};
  let revealTimer = null;
  let grabMs = 0;
  let openedAt = 0;
  let shortcutsPaused = false;
  let busySince = 0;
  let overlayActive = false;
  let overlayHwnd = "";
  let helperHideTimer = null;
  let helper = null;
  let helperUp = false;
  let helperRestarts = 0;
  let helperBindSpec = "";
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
        "content-type": frameFile.endsWith(".bmp") ? "image/bmp" : "image/png",
        "content-length": String(body.length),
        "cache-control": "no-store",
      },
    });
  });

  const publishFrame = (pngBuffer) => {
    const dir = path.join(os.tmpdir(), "vor-shot-frame");
    fs.mkdirSync(dir, { recursive: true });
    frameFile = path.join(dir, "frame.png");
    fs.writeFileSync(frameFile, pngBuffer);
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

  /**
   * A janela do overlay nunca faz show/hide depois do arranque (#33): o Windows animava o show com
   * zoom+fade (o "pulo"). Ociosa fica visível mas transparente, atravessável por cliques, sem foco,
   * fora do Alt+Tab e sem alwaysOnTop (não atrapalha jogos em tela cheia). Na captura sobe ao topo.
   */
  const parkWindow = (win) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(false);
      win.setFocusable(false);
      win.webContents.send("screenshot-session", null);
    } catch (e) { ctx.diagLog(`[Screenshot] park: ${e.message}`); }
  };
  const activateWindow = (win) => {
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
    // focus() antes do topmost: ao trocar o foreground o shell reergue a Shell_TrayWnd
    // (também topmost) por cima; por isso o topmost vem depois e é reafirmado.
    win.focus();
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
    const reassert = () => {
      if (!overlayActive || overlay !== win || win.isDestroyed()) return;
      try { win.moveTop(); } catch { /* ignore */ }
      if (overlayHwnd) helperSend(`top ${overlayHwnd}`);
    };
    for (const ms of [30, 150, 400]) setTimeout(reassert, ms);
  };

  const closeOverlay = () => {
    clearTimeout(revealTimer);
    clearTimeout(helperHideTimer);
    helperSend("armed 0");
    helperSend("hide");
    pendingSession = null;
    revealOverlay = () => {};
    overlayActive = false;
    const win = overlay;
    overlay = null;
    if (!win || win.isDestroyed()) {
      queueMicrotask(() => { void primeWarmShell(); });
      return;
    }
    parkWindow(win);
    if (warmShell && warmShell !== win && !warmShell.isDestroyed()) {
      try { warmShell.close(); } catch { /* ignore */ }
    }
    warmShell = win;
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
  };

  const virtualDesktopBounds = () => {
    const displays = screen.getAllDisplays();
    if (!displays.length) throw new Error("nenhum monitor");
    const originX = Math.min(...displays.map((item) => item.bounds.x));
    const originY = Math.min(...displays.map((item) => item.bounds.y));
    const right = Math.max(...displays.map((item) => item.bounds.x + item.bounds.width));
    const bottom = Math.max(...displays.map((item) => item.bounds.y + item.bounds.height));
    return {
      displays,
      origin: { x: originX, y: originY },
      bounds: {
        x: originX,
        y: originY,
        width: Math.max(1, Math.round(right - originX)),
        height: Math.max(1, Math.round(bottom - originY)),
      },
    };
  };

  const pickSource = (sources, display, index) => (
    sources.find((item) => String(item.display_id) === String(display.id))
    || sources[index]
    || sources[0]
  );

  /**
   * Congela todos os monitores à resolução física nativa, sem reamostrar. O `desktopCapturer` usa
   * um único `thumbnailSize` para todas as telas (aspect-fit): com 1366×768 + 1600×900 o primário
   * era ampliado para 1600×900 e depois reduzido para 1366×768 — 6,8% dos pixels mudavam e o
   * "freeze" não batia com o ecrã real (o salto ao abrir/fechar). Agora há um pedido por resolução
   * física distinta e cada bitmap é copiado 1:1 para o mosaico (em px físicos = DIP × escala).
   */
  const grabVirtualDesktop = async () => {
    const { displays, origin, bounds } = virtualDesktopBounds();
    const scale = Math.max(...displays.map((d) => d.scaleFactor || 1));
    const physical = (d) => ({
      width: Math.max(1, Math.round(d.size.width * (d.scaleFactor || 1))),
      height: Math.max(1, Math.round(d.size.height * (d.scaleFactor || 1))),
    });
    const sizeKeys = [...new Set(displays.map((d) => { const p = physical(d); return `${p.width}x${p.height}`; }))];
    const lists = await Promise.all(sizeKeys.map((key) => {
      const [width, height] = key.split("x").map(Number);
      return desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height }, fetchWindowIcons: false });
    }));
    const shots = displays.map((display, index) => {
      const p = physical(display);
      const source = pickSource(lists[sizeKeys.indexOf(`${p.width}x${p.height}`)], display, index);
      if (!source || source.thumbnail.isEmpty()) return null;
      let image = source.thumbnail;
      // Só com DPIs diferentes entre monitores (escala do mosaico ≠ escala do monitor) há reamostragem.
      const want = {
        width: Math.max(1, Math.round(display.bounds.width * scale)),
        height: Math.max(1, Math.round(display.bounds.height * scale)),
      };
      const got = image.getSize();
      if (got.width !== want.width || got.height !== want.height) image = image.resize({ ...want, quality: "best" });
      return { image, size: want, left: Math.round((display.bounds.x - origin.x) * scale), top: Math.round((display.bounds.y - origin.y) * scale) };
    }).filter(Boolean);
    if (!shots.length) throw new Error("captura vazia");
    const W = Math.max(1, Math.round(bounds.width * scale));
    const H = Math.max(1, Math.round(bounds.height * scale));
    let image;
    if (shots.length === 1 && shots[0].size.width === W && shots[0].size.height === H) {
      image = shots[0].image;
    } else {
      const out = Buffer.alloc(W * H * 4);
      new Uint32Array(out.buffer, out.byteOffset, W * H).fill(0xff000000);
      for (const shot of shots) {
        const src = shot.image.toBitmap();
        const rowBytes = shot.size.width * 4;
        for (let y = 0; y < shot.size.height; y += 1) {
          const ty = shot.top + y;
          if (ty < 0 || ty >= H) continue;
          src.copy(out, (ty * W + shot.left) * 4, y * rowBytes, y * rowBytes + Math.min(rowBytes, (W - shot.left) * 4));
        }
      }
      image = nativeImage.createFromBitmap(out, { width: W, height: H, scaleFactor: 1 });
    }
    if (image.isEmpty()) throw new Error("captura vazia");
    return { image, png: image.toPNG(), origin, bounds };
  };

  /**
   * Sem transições do DWM na janela de captura (DWMWA_TRANSITIONS_FORCEDISABLED = 3): o Windows
   * animava show/hide da janela (zoom/fade do MinAnimate), o "pulo" ao abrir e ao fechar. Chamado
   * uma vez por janela (ela é reaproveitada); o PowerShell termina logo, custo zero em repouso.
   */
  const disableTransitions = (win) => {
    if (process.platform !== "win32" || !win || win.isDestroyed()) return;
    try {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      const script = [
        "Add-Type -Namespace V -Name D -MemberDefinition '[DllImport(\"dwmapi.dll\")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);'",
        "$v = 1",
        `[V.D]::DwmSetWindowAttribute([IntPtr]${hwnd.toString()}, 3, [ref]$v, 4)`,
      ].join("; ");
      const { spawn } = require("child_process");
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let hr = "";
      child.stdout.on("data", (chunk) => { hr += chunk.toString(); });
      child.on("close", () => ctx.diagLog(`[Screenshot] DWMWA_TRANSITIONS_FORCEDISABLED hr=${hr.trim() || "?"}`));
      child.on("error", (e) => ctx.diagLog(`[Screenshot] dwm: ${e.message}`));
    } catch (e) {
      ctx.diagLog(`[Screenshot] dwm: ${e.message}`);
    }
  };

  const activeWindowRect = async (origin, virtual) => {
    const getActive = ctx.getActiveWin();
    if (!getActive) return null;
    let info = null;
    try { info = await getActive(); } catch { return null; }
    const bounds = info && info.bounds;
    if (!bounds || !Number.isFinite(bounds.width) || bounds.width < 8) return null;
    if (info.owner?.processId === process.pid) return null;
    let { x, y, width, height } = bounds;
    const nearest = screen.getDisplayNearestPoint({
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
    });
    const scale = nearest.scaleFactor || 1;
    if (scale > 1 && (width > nearest.bounds.width * 1.25 || height > nearest.bounds.height * 1.25)) {
      x /= scale;
      y /= scale;
      width /= scale;
      height /= scale;
    }
    const left = Math.max(virtual.x, x);
    const top = Math.max(virtual.y, y);
    const right = Math.min(virtual.x + virtual.width, x + width);
    const bottom = Math.min(virtual.y + virtual.height, y + height);
    if (right - left < 8 || bottom - top < 8) return null;
    return {
      x: Math.round(left - origin.x),
      y: Math.round(top - origin.y),
      width: Math.round(right - left),
      height: Math.round(bottom - top),
    };
  };

  const attachShellLifecycle = (win) => {
    win.removeMenu();
    win.on("closed", () => {
      if (overlay === win) overlay = null;
      if (warmShell === win) warmShell = null;
    });
  };

  const buildOverlayShell = async (bounds) => {
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      /**
       * Transparente e criada escondida no arranque (warm shell). Enquanto o renderer não confirma
       * que pintou o frame congelado, qualquer frame apresentado pelo DWM é transparente — por
       * baixo está exatamente a mesma imagem, portanto nada pisca. Antes era opaca (#000) e o
       * primeiro frame podia sair preto/cinza, o "piscar" ao ativar a captura.
       */
      transparent: true,
      alwaysOnTop: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
      paintWhenInitiallyHidden: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      autoHideMenuBar: true,
      backgroundColor: "#00000000",
      focusable: false,
      webPreferences: {
        preload: ctx.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    attachShellLifecycle(win);
    if (ctx.isDev) await win.loadURL("http://localhost:5173/capture.html");
    else await win.loadFile(ctx.captureHtmlPath);
    if (!win.isDestroyed()) {
      win.setBounds(bounds);
      win.setIgnoreMouseEvents(true);
      // Único show da vida da janela, ainda transparente (renderer sem sessão).
      win.showInactive();
      // Uma janela transparente mostrada depois de carregar escondida pode ficar com a superfície
      // opaca (cinza) até o próximo paint: força um repaint transparente.
      win.setBackgroundColor("#00000000");
      win.webContents.invalidate();
      setTimeout(() => { if (!win.isDestroyed()) win.webContents.invalidate(); }, 250);
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      overlayHwnd = hwnd.toString();
      helperSend(`toolwindow ${overlayHwnd}`);
    }
    return win;
  };

  const primeWarmShell = async () => {
    if (warmShell && !warmShell.isDestroyed()) return warmShell;
    if (overlay && !overlay.isDestroyed()) return null;
    try {
      const { bounds } = virtualDesktopBounds();
      const win = await buildOverlayShell(bounds);
      if (overlay && !overlay.isDestroyed()) {
        if (!win.isDestroyed()) win.close();
        return null;
      }
      warmShell = win;
      return win;
    } catch (e) {
      ctx.diagLog(`[Screenshot] warm: ${e.message}`);
      return null;
    }
  };

  const takeOverlayShell = async (bounds) => {
    // Reaproveita sempre a mesma janela: criar outra mostrava uma janela nova (com a animação do
    // Windows) — era o que ainda fazia o pulo quando se carregava no atalho com a captura aberta.
    if (overlay && !overlay.isDestroyed()) {
      if (warmShell && warmShell !== overlay && !warmShell.isDestroyed()) {
        try { warmShell.close(); } catch { /* ignore */ }
      }
      warmShell = null;
      return overlay;
    }
    const warm = warmShell && !warmShell.isDestroyed() ? warmShell : null;
    warmShell = null;
    if (warm) {
      if (overlay && overlay !== warm && !overlay.isDestroyed()) {
        try { overlay.close(); } catch { /* ignore */ }
      }
      overlay = warm;
      if (!warm.isDestroyed()) warm.setBounds(bounds);
      return warm;
    }
    if (overlay && !overlay.isDestroyed()) {
      try { overlay.close(); } catch { /* ignore */ }
      overlay = null;
    }
    const win = await buildOverlayShell(bounds);
    overlay = win;
    return win;
  };

  const openOverlay = async (bounds, session, prepared) => {
    const win = prepared && !prepared.isDestroyed()
      ? prepared
      : await takeOverlayShell(bounds);
    if (win.isDestroyed()) return;
    overlay = win;
    let revealed = false;
    const reveal = () => {
      if (revealed || win.isDestroyed() || overlay !== win) return;
      revealed = true;
      clearTimeout(revealTimer);
      ctx.diagLog(`[Screenshot] grab ${grabMs} ms, revelada ${Date.now() - openedAt} ms depois`);
      const b = win.getBounds();
      if (b.x !== bounds.x || b.y !== bounds.y || b.width !== bounds.width || b.height !== bounds.height) win.setBounds(bounds);
      overlayActive = true;
      activateWindow(win);
      win.webContents.send("screenshot-visible");
      ctx.setGrabbing(false);
      // O congelado nativo fica por baixo até o renderer confirmar que pintou ("painted").
      clearTimeout(helperHideTimer);
      helperHideTimer = setTimeout(() => {
        ctx.diagLog("[Screenshot] painted não chegou em 800 ms, a esconder o congelado");
        helperSend("hide");
      }, 800);
    };
    revealOverlay = reveal;
    pendingSession = session;
    win.webContents.send("screenshot-session", session);
    // Fallback se o frame não disparar "ready". O congelado nativo continua por cima, logo não pisca.
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      ctx.diagLog("[Screenshot] ready não chegou em 700 ms (fallback)");
      reveal();
    }, 700);
  };

  const capture = async (mode) => {
    const cfg = settings();
    if (cfg.enabled === false) return;
    if (busy && Date.now() - busySince > 5000) {
      ctx.diagLog("[Screenshot] busy preso há >5 s, a recuperar");
      busy = false;
    }
    if (busy) return;
    if (overlay && !overlay.isDestroyed()) {
      // Overlay visível = sessão ativa. Escondido/preso (ready nunca chegou) = recupera em vez de ignorar.
      if (overlayActive) return;
      ctx.diagLog("[Screenshot] overlay preso sem sessão ativa, a recuperar");
      closeOverlay();
    }
    if (helperReady()) {
      // Caminho nativo: o helper congela a tela e responde com "shot".
      busy = true;
      busySince = Date.now();
      ctx.setGrabbing(true);
      helperSend(`grab ${mode}`);
      return;
    }
    busy = true;
    busySince = Date.now();
    ctx.setGrabbing(true);
    let shell = null;
    try {
      const point = screen.getCursorScreenPoint();
      const virtual = virtualDesktopBounds();
      const cursor = {
        x: point.x - virtual.origin.x,
        y: point.y - virtual.origin.y,
      };
      let preset = null;
      if (mode === "window") preset = await activeWindowRect(virtual.origin, virtual.bounds);
      else if (mode === "region" && cfg.rememberRegion && cfg.lastRegion) preset = cfg.lastRegion;

      const shellPromise = mode === "full"
        ? Promise.resolve(null)
        : takeOverlayShell(virtual.bounds);
      hideOurWindows();
      const t0 = Date.now();
      const { image, png, bounds } = await grabVirtualDesktop();
      grabMs = Date.now() - t0;
      openedAt = Date.now();
      shell = await shellPromise;

      if (mode === "full") {
        clipboard.writeImage(image);
        toast(ctx.language() === "pt" ? "Tela copiada." : "Screen copied.");
        return;
      }

      const language = ctx.language() === "pt" ? "pt" : "en";
      await openOverlay(bounds, {
        frameUrl: publishFrame(png),
        mode: mode === "window" ? "window" : "region",
        width: bounds.width,
        height: bounds.height,
        preset,
        cursor: cfg.includeCursor ? cursor : null,
        hintAt: cursor,
        copyOnSelect: !!cfg.copyOnSelect,
        format: cfg.format === "jpeg" || cfg.format === "webp" ? cfg.format : "png",
        quality: Math.min(100, Math.max(50, Number(cfg.quality) || 92)),
        language,
      }, shell);
    } catch (e) {
      ctx.diagLog(`[Screenshot] ${e.message}`);
      toast(ctx.language() === "pt" ? "Não foi possível capturar a tela." : "Could not capture the screen.");
      if (shell && !shell.isDestroyed()) {
        overlay = shell;
        closeOverlay();
      }
    } finally {
      ctx.setGrabbing(false);
      busy = false;
    }
  };

  /**
   * Helper nativo (backend/bin/vor-capture.exe). Faz o que o Lightshot faz: atalho tratado num
   * processo próprio que responde ao hook na hora, BitBlt do desktop virtual e uma janela topmost
   * que mostra o frame congelado sem ativação. O `node-global-key-listener` esperava a resposta do
   * Node a cada tecla do sistema; com o main ocupado (grab de 300–850 ms) o hook estourava o
   * LowLevelHooksTimeout e o Windows removia-o em silêncio: o atalho morria e o resto do VOR seguia.
   */
  const helperReady = () => !!(helper && helperUp && !helper.killed);
  const helperSend = (line) => {
    if (!helperReady()) return;
    try { helper.stdin.write(`${line}\n`); } catch { /* ignore */ }
  };
  const onHelperShot = async (parts) => {
    // shot <mode> <x> <y> <w> <h> <grabMs> <shownMs> <file...>
    const mode = parts[1];
    if (overlayActive) {
      // Atalho de novo com a captura já aberta: ignora, mantém a sessão atual.
      ctx.diagLog("[Screenshot] atalho com captura aberta, ignorado");
      helperSend("hide");
      return;
    }
    grabMs = Number(parts[6]) || 0;
    const file = parts.slice(8).join(" ");
    openedAt = Date.now();
    ctx.diagLog(`[Screenshot] nativo: BitBlt ${grabMs} ms, congelado visível em ${parts[7]} ms`);
    const cfg = settings();
    try {
      hideOurWindows();
      const virtual = virtualDesktopBounds();
      const point = screen.getCursorScreenPoint();
      const cursor = { x: point.x - virtual.origin.x, y: point.y - virtual.origin.y };
      let preset = null;
      if (mode === "window") preset = await activeWindowRect(virtual.origin, virtual.bounds);
      else if (mode === "region" && cfg.rememberRegion && cfg.lastRegion) preset = cfg.lastRegion;
      const shell = await takeOverlayShell(virtual.bounds);
      frameFile = file;
      helperSend("armed 1");
      await openOverlay(virtual.bounds, {
        frameUrl: `vor-shot://frame/${Date.now()}`,
        mode: mode === "window" ? "window" : "region",
        width: virtual.bounds.width,
        height: virtual.bounds.height,
        preset,
        cursor: cfg.includeCursor ? cursor : null,
        hintAt: cursor,
        copyOnSelect: !!cfg.copyOnSelect,
        format: cfg.format === "jpeg" || cfg.format === "webp" ? cfg.format : "png",
        quality: Math.min(100, Math.max(50, Number(cfg.quality) || 92)),
        language: ctx.language() === "pt" ? "pt" : "en",
      }, shell);
    } catch (e) {
      ctx.diagLog(`[Screenshot] nativo: ${e.message}`);
      helperSend("hide");
      closeOverlay();
    } finally {
      ctx.setGrabbing(false);
      busy = false;
    }
  };
  const startHelper = () => {
    if (process.platform !== "win32" || helper) return false;
    const exe = ctx.captureHelperPath;
    if (!exe || !fs.existsSync(exe)) {
      ctx.diagLog(`[Screenshot] helper nativo ausente (${exe}), a usar o listener antigo`);
      return false;
    }
    const { spawn } = require("child_process");
    const child = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    helper = child;
    helperUp = false;
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const parts = line.split(" ");
        if (parts[0] === "ready") {
          helperUp = true;
          if (helperBindSpec) helperSend(`bind ${shortcutsPaused ? "" : helperBindSpec}`);
          if (overlayHwnd) helperSend(`toolwindow ${overlayHwnd}`);
        } else if (parts[0] === "status") {
          onHelperStatus(line);
        } else if (parts[0] === "shot") void onHelperShot(parts);
        else if (parts[0] === "full") {
          busy = false;
          ctx.setGrabbing(false);
          toast(ctx.language() === "pt" ? "Tela copiada." : "Screen copied.");
        } else if (parts[0] === "esc") {
          if (overlay && !overlay.isDestroyed()) closeOverlay();
          else helperSend("hide");
        } else if (parts[0] === "log") {
          ctx.diagLog(`[Screenshot] helper: ${parts.slice(1).join(" ")}`);
          if (parts[1] === "grab-error") { busy = false; ctx.setGrabbing(false); }
        }
      }
    });
    const onGone = (why) => {
      if (helper !== child) return;
      helper = null;
      helperUp = false;
      busy = false;
      ctx.diagLog(`[Screenshot] helper saiu (${why}), a reiniciar`);
      helperRestarts += 1;
      if (helperRestarts < 20) setTimeout(() => startHelper(), Math.min(5000, 300 * helperRestarts));
    };
    child.on("exit", (code) => onGone(`código ${code}`));
    child.on("error", (e) => onGone(e.message));
    child.stdin.on("error", () => {});
    return true;
  };

  /**
   * Saúde do atalho (#33): a cada 30 s o helper reporta hook, nº de bindings e última tecla. Se os
   * bindings sumiram sem pausa, re-sincroniza; se o helper não responde, é reiniciado.
   */
  let statusPending = 0;
  const expectedBindings = () => (helperBindSpec ? helperBindSpec.split(";").filter(Boolean).length : 0);
  const onHelperStatus = (line) => {
    statusPending = 0;
    const get = (key) => Number((new RegExp(`${key}=(-?\\d+)`).exec(line) || [])[1]);
    const want = shortcutsPaused ? 0 : expectedBindings();
    if (get("hook") !== 1) ctx.diagLog(`[Screenshot] helper sem hook: ${line}`);
    if (get("armed") === 1 && !overlayActive && !busy) {
      ctx.diagLog("[Screenshot] helper armado sem captura aberta, a desarmar");
      helperSend("armed 0");
    }
    if (get("bindings") !== want) {
      ctx.diagLog(`[Screenshot] bindings ${get("bindings")} ≠ ${want}, a re-sincronizar`);
      helperSend(`bind ${shortcutsPaused ? "" : helperBindSpec}`);
    }
  };
  const statusTimer = setInterval(() => {
    if (!helperReady()) return;
    if (statusPending && Date.now() - statusPending > 5000) {
      ctx.diagLog("[Screenshot] helper não respondeu ao status, a reiniciar");
      statusPending = 0;
      try { helper.kill(); } catch { /* ignore */ }
      return;
    }
    statusPending = Date.now();
    helperSend("status");
  }, 30000);
  if (statusTimer.unref) statusTimer.unref();

  let pauseTimer = null;
  const setPaused = (value, why) => {
    const next = !!value;
    clearTimeout(pauseTimer);
    if (next) {
      // Nunca fica pausado para sempre: se o resume se perder, volta sozinho em 15 s.
      pauseTimer = setTimeout(() => setPaused(false, "timeout 15 s"), 15000);
    }
    if (shortcutsPaused === next) return;
    shortcutsPaused = next;
    ctx.diagLog(`[Screenshot] atalhos ${next ? "pausados" : "retomados"} (${why})`);
    helperSend(`bind ${next ? "" : helperBindSpec}`);
  };

  const restartShortcut = () => {
    ctx.diagLog("[Screenshot] reiniciar atalho de captura (manual)");
    setPaused(false, "manual");
    busy = false;
    if (overlay && !overlay.isDestroyed() && !overlayActive) closeOverlay();
    helperRestarts = 0;
    if (helper) { try { helper.kill(); } catch { /* ignore */ } } else startHelper();
  };

  /** Mesma ordem de modificadores que o helper monta: ctrl, alt, shift, super, tecla. */
  const canonicalAccelerator = (raw) => {
    const parts = normalizeAccelerator(raw).toLowerCase().split("+").filter(Boolean);
    const order = ["commandorcontrol", "alt", "shift", "super"];
    const mods = order.filter((m) => parts.includes(m));
    const key = parts.filter((p) => !order.includes(p)).pop() || "";
    return key ? [...mods, key].join("+") : "";
  };

  const ensureShortcutListener = () => {
    if (shortcutListener) return;
    try {
      const { GlobalKeyboardListener } = require("node-global-key-listener");
      shortcutListener = new GlobalKeyboardListener();
      void shortcutListener.addListener((event, down) => {
        shortcutTracker.note(event);
        const pressed = shortcutTracker.format(event, down);
        if (pressed && overlay && !overlay.isDestroyed() && normalizeAccelerator(pressed).toLowerCase() === "escape") {
          closeOverlay();
          return true;
        }
        if (shortcutsPaused) return;
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
    if (cfg.enabled === false) {
      helperBindSpec = "";
      helperSend("bind ");
      return;
    }
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
    helperBindSpec = pairs
      .map(([raw, mode]) => [canonicalAccelerator(raw), mode])
      .filter(([accel]) => accel)
      .map(([accel, mode]) => `${accel}=${mode}`)
      .join(";");
    if (helper || startHelper()) {
      helperSend(`bind ${shortcutsPaused ? "" : helperBindSpec}`);
      return;
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
      if (action === "painted") {
        clearTimeout(helperHideTimer);
        ctx.diagLog(`[Screenshot] pintado ${Date.now() - openedAt} ms após o frame`);
        helperSend("hide");
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

  queueMicrotask(() => { void primeWarmShell(); });

  return {
    capture,
    registerShortcuts,
    normalizeAccelerator,
    // Enquanto o utilizador grava um atalho nas definições, o helper não pode engolir a tecla.
    setShortcutsPaused: (value, why = "ipc") => setPaused(value, why),
    restartShortcut,
    dispose: () => { helperSend("quit"); },
  };
}

module.exports = {
  DEFAULT_SCREENSHOT,
  installScreenshot,
  normalizeAccelerator,
  createShortcutTracker,
};
