"use strict";

/**
 * Módulo Preview: janela Electron sem moldura, pré-aquecida, renderer isolado.
 * O helper nativo (vor-preview.exe) só existe no Windows; nas outras plataformas
 * a janela ainda abre pela ação Visualizar do ShiftDrop, sem gancho de teclado.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { BrowserWindow, app: electronApp, net, protocol, screen, shell } = require("electron");
const lib = require("./preview-lib.cjs");

const DEFAULT_PREVIEW = {
  enabled: true,
  shortcut: "Space",
};

const DEFAULT_WIDTH = 920;
const DEFAULT_HEIGHT = 640;

function installPreview(ctx) {
  let win = null;
  let helper = null;
  let helperUp = false;
  let helperRestarts = 0;
  let helperBindSpec = "";
  let shortcutsPaused = false;
  let visible = false;
  let pinned = false;
  let currentPath = "";
  let currentKind = "fallback";
  let sanitizedSvg = "";
  let siblings = { paths: [], index: 0 };
  let pendingSession = null;
  let opening = false;
  let queuedOpen = null;
  let helperView = null;
  let shownAt = 0;
  let openWithBusy = false;
  let openWithBusyTimer = null;

  const settings = () => ({ ...DEFAULT_PREVIEW, ...(ctx.getPreviewSettings() || {}) });
  const windowsOnly = () => process.platform === "win32";

  protocol.handle("vor-preview", (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === "svg") {
        if (!sanitizedSvg) return new Response("missing", { status: 404 });
        return new Response(sanitizedSvg, {
          headers: {
            "content-type": "image/svg+xml; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          },
        });
      }
      if (url.hostname !== "media" || !currentPath) {
        return new Response("forbidden", { status: 403 });
      }
      if (!fs.existsSync(currentPath) || fs.statSync(currentPath).isDirectory()) {
        return new Response("missing", { status: 404 });
      }
      const mime = lib.mimeFor(lib.extOf(currentPath), currentKind);
      const range = request.headers.get("range");
      const fetchHeaders = {};
      if (range) fetchHeaders.Range = range;
      return net.fetch(pathToFileURL(currentPath).href, { headers: fetchHeaders }).then((response) => {
        const headers = new Headers(response.headers);
        headers.set("content-type", mime);
        headers.set("cache-control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      });
    } catch (err) {
      ctx.diagLog(`[Preview] protocol: ${err.message}`);
      return new Response("error", { status: 500 });
    }
  });

  const helperSend = (line) => {
    if (!helper || !helper.stdin || helper.stdin.destroyed) return;
    try { helper.stdin.write(`${line}\n`, "utf8"); } catch { /* ignore */ }
  };

  const sendPreviewHwnd = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      helperSend(`hwnd ${hwnd.toString()}`);
    } catch { /* ignore */ }
  };

  const setArmed = () => {
    sendPreviewHwnd();
    helperSend(`pinned ${pinned ? 1 : 0}`);
    helperSend(`armed ${visible ? 1 : 0}`);
  };

  const appearance = () => {
    const a = typeof ctx.getAppearance === "function" ? ctx.getAppearance() : {};
    return {
      theme: a.theme === "white" ? "white" : "black",
      accent: /^#[0-9a-f]{6}$/i.test(String(a.accent || "")) ? String(a.accent) : "#FFFFFF",
      glass: a.glass !== false,
      opacity: Math.min(1, Math.max(0.35, Number(a.opacity) || 0.8)),
    };
  };

  const language = () => (typeof ctx.language === "function" ? ctx.language() : "pt");

  const sendToPreview = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send(channel, payload); } catch { /* ignore */ }
  };

  const iconDataUrl = async (filePath) => {
    try {
      const img = await electronApp.getFileIcon(filePath, { size: "large" });
      return img && !img.isEmpty() ? img.toDataURL() : null;
    } catch {
      return null;
    }
  };

  const buildSession = async (filePath) => {
    const st = fs.statSync(filePath);
    let kind = lib.classifyKind(filePath, st);
    const meta = lib.fileMeta(filePath, st);
    const session = {
      kind,
      path: filePath,
      mediaUrl: null,
      mime: lib.mimeFor(meta.ext, kind),
      languageHint: lib.langFor(meta.ext),
      text: null,
      html: null,
      truncated: false,
      folder: null,
      zip: null,
      iconDataUrl: null,
      pinned,
      index: siblings.index,
      total: siblings.paths.length,
      appearance: appearance(),
      uiLanguage: language() === "en" ? "en" : "pt",
      ...meta,
    };

    if (kind === "folder") {
      session.folder = lib.listFolder(filePath);
      session.sizeLabel = lib.formatBytes(session.folder.totalSize);
      session.iconDataUrl = await iconDataUrl(filePath);
    } else if (kind === "zip") {
      session.zip = lib.listZipEntries(filePath);
      session.iconDataUrl = await iconDataUrl(filePath);
    } else if (kind === "markdown") {
      const preview = lib.readTextPreview(filePath);
      session.text = preview.text;
      session.html = preview.text ? lib.renderMarkdown(preview.text) : "";
      session.truncated = preview.truncated;
      if (preview.binary) {
        kind = "fallback";
        session.kind = kind;
      }
    } else if (kind === "html") {
      const preview = lib.readTextPreview(filePath);
      session.html = preview.text ? lib.sanitizeHtmlDocument(preview.text) : "";
      session.truncated = preview.truncated;
      if (preview.binary) {
        kind = "fallback";
        session.kind = kind;
      }
    } else if (kind === "text") {
      const preview = lib.readTextPreview(filePath);
      session.text = preview.text;
      session.truncated = preview.truncated;
      if (preview.binary || preview.text == null) {
        kind = "fallback";
        session.kind = kind;
        session.text = null;
      }
    } else if (kind === "svg") {
      const preview = lib.readTextPreview(filePath, 4 * 1024 * 1024);
      sanitizedSvg = preview.text ? lib.sanitizeSvg(preview.text) : "";
      session.mediaUrl = "vor-preview://svg/current";
      session.truncated = preview.truncated;
    } else if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
      session.mediaUrl = "vor-preview://media/current";
    } else {
      // Fallback: se parecer texto pequeno, mostra como texto; senão ícone/metadados.
      if (!st.isDirectory() && st.size <= lib.MAX_TEXT_BYTES) {
        try {
          const preview = lib.readTextPreview(filePath);
          if (!preview.binary && preview.text != null) {
            kind = "text";
            session.kind = kind;
            session.text = preview.text;
            session.truncated = preview.truncated;
            session.languageHint = "text";
          }
        } catch { /* binário */ }
      }
      if (session.kind === "fallback") session.iconDataUrl = await iconDataUrl(filePath);
    }

    currentKind = session.kind;
    if (session.kind !== "svg") sanitizedSvg = "";
    return session;
  };

  const targetDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  const placeWindow = () => {
    if (!win || win.isDestroyed()) return;
    const area = targetDisplay().workArea;
    const width = Math.min(DEFAULT_WIDTH, Math.max(480, area.width - 80));
    const height = Math.min(DEFAULT_HEIGHT, Math.max(360, area.height - 80));
    const x = Math.round(area.x + (area.width - width) / 2);
    const y = Math.round(area.y + (area.height - height) / 2);
    win.setBounds({ x, y, width, height });
  };

  const attachLifecycle = (window) => {
    window.removeMenu();
    window.on("closed", () => {
      if (win === window) win = null;
      visible = false;
      setArmed();
    });
    // Teclas com a janela realmente em primeiro plano (clique na prévia, PDF, etc.).
    // O caso Explorer-ainda-focado é o helper nativo: o Windows recusa SetForegroundWindow.
    window.webContents.on("before-input-event", (event, input) => {
      if (!visible || input.type !== "keyDown") return;
      const nav = lib.previewNavCommand(input.key);
      if (!nav) return;
      if (nav === "close" && pinned && input.key !== "Escape") return;
      event.preventDefault();
      if (nav === "close") hidePreview();
      else if (nav === "launch") void openDefault();
      else if (nav === "next") void navigate(1);
      else if (nav === "prev") void navigate(-1);
    });
    window.on("blur", () => {
      if (pinned || !visible || openWithBusy) return;
      // O foco a saltar no instante em que a janela nasce (ShiftDrop a fechar) não pode
      // engolir a prévia. Um clique fora, depois disso, fecha — excepto se estiver fixada.
      // «Abrir com» também desfoca: sem este guarda o diálogo nativo some com a janela.
      const opened = shownAt;
      setTimeout(() => {
        if (pinned || !visible || openWithBusy || opened !== shownAt) return;
        if (Date.now() - shownAt < 280) return;
        if (win && !win.isDestroyed() && !win.isFocused()) hidePreview();
      }, 80);
    });
  };

  const loadPreviewPage = async (window) => {
    if (ctx.isDev) await window.loadURL("http://localhost:5173/preview.html");
    else await window.loadFile(ctx.previewHtmlPath);
  };

  const createWindow = async () => {
    const window = new BrowserWindow({
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      minimizable: false,
      maximizable: true,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: "#00000000",
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: ctx.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    attachLifecycle(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (/^https?:\/\/localhost:5173\//i.test(url) || url.startsWith("file:")) return;
      event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    await loadPreviewPage(window);
    return window;
  };

  const ensureWindow = async () => {
    if (win && !win.isDestroyed()) return win;
    win = await createWindow();
    sendPreviewHwnd();
    return win;
  };

  const hidePreview = () => {
    if (currentPath) helperSend(`select ${currentPath}`);
    visible = false;
    pendingSession = null;
    currentPath = "";
    sanitizedSvg = "";
    openWithBusy = false;
    clearTimeout(openWithBusyTimer);
    openWithBusyTimer = null;
    setArmed();
    if (!win || win.isDestroyed()) return;
    try {
      win.setSkipTaskbar(true);
      win.hide();
    } catch { /* ignore */ }
  };

  const pushSession = (session) => {
    pendingSession = session;
    sendToPreview("preview-session", session);
  };

  const openPath = async (filePath, { keepPin = false, keepSiblings = false } = {}) => {
    const target = path.resolve(String(filePath || ""));
    if (!target || !fs.existsSync(target)) {
      ctx.diagLog(`[Preview] caminho inválido: ${target}`);
      return { ok: false, error: "missing" };
    }
    if (opening) {
      queuedOpen = { filePath: target, keepPin, keepSiblings };
      return { ok: false, error: "busy" };
    }
    opening = true;
    try {
      if (!keepPin) pinned = false;
      if (!keepSiblings) siblings = lib.listSiblings(target);
      else {
        const idx = siblings.paths.findIndex((p) => p.toLowerCase() === target.toLowerCase());
        if (idx >= 0) siblings.index = idx;
      }
      currentPath = target;
      const session = await buildSession(target);
      const window = await ensureWindow();
      placeWindow();
      window.setAlwaysOnTop(true, "floating");
      window.setSkipTaskbar(pinned);
      pushSession(session);
      visible = true;
      setArmed();
      shownAt = Date.now();
      if (!window.isVisible()) window.show();
      // Não roubar o foreground: o Windows recusa, o Explorer fica com as teclas, e o helper
      // trata Esc/setas/Enter enquanto a prévia está armada. Um clique na janela dá-lhe foco.
      return { ok: true };
    } catch (err) {
      ctx.diagLog(`[Preview] open: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      opening = false;
      if (queuedOpen) {
        const next = queuedOpen;
        queuedOpen = null;
        void openPath(next.filePath, { keepPin: next.keepPin, keepSiblings: next.keepSiblings });
      }
    }
  };

  const applyHelperView = () => {
    if (!helperView || !helperView.paths.length) return false;
    const paths = helperView.paths.map((p) => path.resolve(p));
    let idx = helperView.index;
    if (idx < 0 || idx >= paths.length) idx = 0;
    siblings = { paths, index: idx };
    helperView = null;
    return true;
  };

  const navigate = (delta) => {
    if (!siblings.paths.length) return Promise.resolve({ ok: false });
    const next = (siblings.index + delta + siblings.paths.length) % siblings.paths.length;
    const target = siblings.paths[next];
    if (!target || !fs.existsSync(target)) return Promise.resolve({ ok: false });
    helperSend(`select ${target}`);
    siblings = { paths: siblings.paths, index: next };
    return openPath(target, { keepPin: true, keepSiblings: true });
  };

  const openDefault = async () => {
    if (!currentPath) return { ok: false };
    const target = currentPath;
    hidePreview();
    try {
      await shell.openPath(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  const setOpenWithBusy = (value) => {
    openWithBusy = !!value;
    clearTimeout(openWithBusyTimer);
    openWithBusyTimer = null;
    if (!win || win.isDestroyed()) return;
    try {
      // Sem alwaysOnTop o diálogo nativo não fica atrás da prévia frameless.
      win.setAlwaysOnTop(!openWithBusy, "floating");
    } catch { /* ignore */ }
  };

  const openWith = () => {
    if (!currentPath) return { ok: false };
    if (!windowsOnly()) {
      ctx.diagLog("[Preview] Abrir com... só existe no Windows");
      return { ok: false, error: "windows-only" };
    }
    const target = currentPath;
    ctx.diagLog(`[Preview] Abrir com... ${target}`);
    setOpenWithBusy(true);
    openWithBusyTimer = setTimeout(() => setOpenWithBusy(false), 120000);
    // SHOpenWithDialog no helper (STA). rundll32 com windowsHide:true escondia o diálogo.
    if (helperUp) {
      helperSend(`openwith ${target}`);
      return { ok: true };
    }
    try {
      const { spawn } = require("child_process");
      spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
      // O rundll32 não avisa quando o diálogo fecha; liberta o alwaysOnTop assim que ele nascer.
      clearTimeout(openWithBusyTimer);
      openWithBusyTimer = setTimeout(() => setOpenWithBusy(false), 1500);
      return { ok: true };
    } catch (err) {
      setOpenWithBusy(false);
      ctx.diagLog(`[Preview] Abrir com falhou: ${err.message}`);
      return { ok: false, error: err.message };
    }
  };

  const reveal = () => {
    if (!currentPath) return { ok: false };
    shell.showItemInFolder(currentPath);
    return { ok: true };
  };

  const togglePin = () => {
    pinned = !pinned;
    if (win && !win.isDestroyed()) {
      win.setSkipTaskbar(pinned ? false : true);
      win.setAlwaysOnTop(true, "floating");
    }
    setArmed();
    if (pendingSession) {
      pendingSession = { ...pendingSession, pinned };
      sendToPreview("preview-session", pendingSession);
    }
    return { ok: true, pinned };
  };

  const startHelper = () => {
    if (!windowsOnly() || helper) return false;
    const exe = ctx.previewHelperPath;
    if (!exe || !fs.existsSync(exe)) {
      ctx.diagLog(`[Preview] helper nativo ausente (${exe})`);
      return false;
    }
    const { spawn } = require("child_process");
    const child = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    helper = child;
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const sp = line.indexOf(" ");
        const cmd = sp < 0 ? line : line.slice(0, sp);
        const arg = sp < 0 ? "" : line.slice(sp + 1);
        if (cmd === "ready") {
          helperUp = true;
          helperSend(`bind ${shortcutsPaused ? "" : helperBindSpec}`);
          setArmed();
        } else if (cmd === "view") {
          const parts = String(arg || "").split(/\s+/);
          helperView = { index: Number(parts[0]) || 0, count: Number(parts[1]) || 0, paths: [] };
        } else if (cmd === "viewitem") {
          if (!helperView) helperView = { index: 0, count: 0, paths: [] };
          if (arg) helperView.paths.push(arg);
        } else if (cmd === "open") {
          const keepSiblings = applyHelperView();
          void openPath(arg, { keepPin: visible, keepSiblings });
        } else if (cmd === "close") {
          hidePreview();
        } else if (cmd === "next") {
          void navigate(1);
        } else if (cmd === "prev") {
          void navigate(-1);
        } else if (cmd === "launch") {
          void openDefault();
        } else if (cmd === "openwith-done") {
          setOpenWithBusy(false);
        } else if (cmd === "log") {
          ctx.diagLog(`[Preview] ${arg}`);
        }
      }
    });
    child.on("exit", () => {
      helper = null;
      helperUp = false;
      if (!windowsOnly() || settings().enabled === false) return;
      helperRestarts += 1;
      if (helperRestarts > 20) return;
      const wait = Math.min(8000, 400 * helperRestarts);
      setTimeout(() => startHelper(), wait);
    });
    return true;
  };

  const registerShortcuts = () => {
    const cfg = settings();
    helperBindSpec = "";
    if (!windowsOnly() || cfg.enabled === false) {
      helperSend("bind ");
      helperSend("armed 0");
      if (visible && !pinned) hidePreview();
      return;
    }
    helperBindSpec = lib.canonicalAccelerator(cfg.shortcut || DEFAULT_PREVIEW.shortcut);
    if (helper || startHelper()) {
      helperSend(`bind ${shortcutsPaused ? "" : helperBindSpec}`);
      setArmed();
    }
    void ensureWindow().catch((err) => ctx.diagLog(`[Preview] warm: ${err.message}`));
  };

  let pauseTimer = null;
  const setPaused = (value, why) => {
    const next = !!value;
    clearTimeout(pauseTimer);
    if (next) pauseTimer = setTimeout(() => setPaused(false, "timeout 15 s"), 15000);
    if (shortcutsPaused === next) return;
    shortcutsPaused = next;
    ctx.diagLog(`[Preview] atalhos ${next ? "pausados" : "retomados"} (${why})`);
    helperSend(`bind ${next ? "" : helperBindSpec}`);
  };

  const fromPreview = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

  ctx.ipcMain.handle("preview-pending", (event) => (fromPreview(event) ? pendingSession : null));
  ctx.ipcMain.handle("preview-action", async (event, payload) => {
    if (!fromPreview(event)) return { ok: false, error: "origem inválida" };
    const action = payload && payload.action;
    if (action === "ready") return { ok: true };
    if (action === "close") { hidePreview(); return { ok: true }; }
    if (action === "pin") return togglePin();
    if (action === "open") return openDefault();
    if (action === "open-with") return openWith();
    if (action === "reveal") return reveal();
    if (action === "next") return navigate(1);
    if (action === "prev") return navigate(-1);
    return { ok: false, error: "ação desconhecida" };
  });

  queueMicrotask(() => {
    if (settings().enabled === false) return;
    void ensureWindow().catch((err) => ctx.diagLog(`[Preview] warm: ${err.message}`));
  });

  if (typeof ctx.onAppearance === "function") {
    ctx.onAppearance(() => {
      const next = appearance();
      sendToPreview("preview-appearance", next);
      if (pendingSession) pendingSession = { ...pendingSession, appearance: next };
    });
  }

  return {
    open: (filePath) => openPath(filePath),
    hide: hidePreview,
    registerShortcuts,
    setShortcutsPaused: (value, why = "ipc") => setPaused(value, why),
    dispose: () => {
      helperSend("quit");
      try { if (helper) helper.kill(); } catch { /* ignore */ }
      helper = null;
      if (win && !win.isDestroyed()) {
        try { win.close(); } catch { /* ignore */ }
      }
    },
  };
}

module.exports = {
  DEFAULT_PREVIEW,
  installPreview,
};
