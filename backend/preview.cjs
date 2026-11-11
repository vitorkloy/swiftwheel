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
const navLib = require("./preview-nav.cjs");
const office = require("./preview-office.cjs");

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
  let nav = navLib.createNavState([], 0);
  let pendingSession = null;
  let opening = false;
  let queuedOpen = null;
  let helperView = null;
  let shownAt = 0;
  let mediaEpoch = 0;
  let openWithBusy = false;
  let openWithBusyTimer = null;
  let nativeEngine = false;
  let previewWait = null;

  const settings = () => ({ ...DEFAULT_PREVIEW, ...(ctx.getPreviewSettings() || {}) });
  const windowsOnly = () => process.platform === "win32";

  const previewDebug = (msg) => {
    ctx.diagLog(`[Preview] ${msg}`);
    if (process.env.SWIFTWHEEL_DEBUG_PREVIEW !== "1") return;
    try {
      const appData = typeof electronApp.getPath === "function" ? electronApp.getPath("appData") : (process.env.APPDATA || "");
      navLib.debugLog(msg, { enabled: true, appData });
    } catch { /* ignore */ }
  };

  const bumpMediaUrl = (kind, filePath) => {
    mediaEpoch += 1;
    const q = `r=${mediaEpoch}&p=${encodeURIComponent(path.basename(filePath))}`;
    return kind === "svg" ? `vor-preview://svg/current?${q}` : `vor-preview://media/current?${q}`;
  };

  protocol.handle("vor-preview", (request) => {
    try {
      const url = new URL(request.url);
      const epoch = url.searchParams.get("r");
      if (epoch && epoch !== String(mediaEpoch)) {
        return new Response("stale", { status: 409 });
      }
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

  const settlePreviewWait = (result) => {
    if (!previewWait) return;
    clearTimeout(previewWait.timer);
    const wait = previewWait;
    previewWait = null;
    wait.resolve(result);
  };

  const sendHostRect = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const bounds = win.getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      const factor = Number(display.scaleFactor) || 1;
      const bar = Math.round(44 * factor);
      const width = Math.round(bounds.width * factor);
      const height = Math.max(8, Math.round(bounds.height * factor) - bar);
      helperSend(`hostrect 0 ${bar} ${width} ${height}`);
    } catch { /* ignore */ }
  };

  const clearNativePreview = () => {
    nativeEngine = false;
    helperSend("preview-clear");
    settlePreviewWait({ ok: false, reason: "cancelled" });
  };

  const tryNativePreview = (filePath) => {
    if (!windowsOnly() || !helperUp) return Promise.resolve({ ok: false, reason: "nohelper" });
    sendHostRect();
    settlePreviewWait({ ok: false, reason: "cancelled" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!previewWait || previewWait.timer !== timer) return;
        previewWait = null;
        helperSend("preview-clear");
        resolve({ ok: false, reason: "timeout" });
      }, 10000);
      previewWait = { resolve, timer, path: filePath };
      helperSend(`preview ${filePath}`);
    });
  };

  const fillOfficeSession = async (session, filePath) => {
    const lang = session.uiLanguage === "en" ? "en" : "pt";
    const guard = office.detectOfficeGuard(filePath, session.size);
    if (guard.reason === "password" || (guard.reason === "too-large" && !guard.allowNative)) {
      nativeEngine = false;
      helperSend("preview-clear");
      session.engine = "info";
      session.office = { reason: guard.reason, message: office.messageFor(guard.reason, lang) };
      if (!session.iconDataUrl) session.iconDataUrl = await iconDataUrl(filePath);
      previewDebug(`office ${guard.reason} ${filePath}`);
      return true;
    }
    if (guard.allowNative && windowsOnly() && helperUp) {
      const native = await tryNativePreview(filePath);
      if (currentPath !== filePath || !visible) return false;
      if (native.ok) {
        nativeEngine = true;
        session.engine = "native";
        session.office = { message: office.messageFor("native", lang) };
        sendHostRect();
        previewDebug(`office native ${filePath}`);
        return true;
      }
      previewDebug(`office native-fail ${native.reason || ""} ${filePath}`);
    }
    nativeEngine = false;
    helperSend("preview-clear");
    if (!guard.allowJs) {
      session.engine = "info";
      session.office = { reason: guard.reason || "too-large", message: office.messageFor(guard.reason || "too-large", lang) };
      if (!session.iconDataUrl) session.iconDataUrl = await iconDataUrl(filePath);
      return true;
    }
    const rendered = await office.renderOfficeJs(filePath, session.kind, session.ext);
    if (currentPath !== filePath || !visible) return false;
    if (rendered.ok) {
      session.engine = "js";
      session.office = office.localizeOffice(rendered.office, lang);
      session.html = rendered.office && rendered.office.html ? rendered.office.html : session.html;
      session.truncated = !!(rendered.office && rendered.office.truncated);
      return true;
    }
    session.engine = "info";
    session.office = office.localizeOffice(rendered.office, lang);
    if (!session.iconDataUrl) session.iconDataUrl = await iconDataUrl(filePath);
    return true;
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
      engine: null,
      office: null,
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
      session.truncated = preview.truncated;
    } else if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
      session.kind = kind;
    } else if (office.isOfficeKind(kind)) {
      session.engine = "pending";
      session.office = { message: office.messageFor("pending", session.uiLanguage) };
      session.iconDataUrl = await iconDataUrl(filePath);
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
    window.on("resize", sendHostRect);
    window.on("move", sendHostRect);
    window.on("blur", () => {
      if (pinned || !visible || openWithBusy || nativeEngine) return;
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
      thickFrame: false,
      resizable: true,
      minimizable: false,
      maximizable: true,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: "#00000000",
      backgroundMaterial: "none",
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
    try { window.setHasShadow(false); } catch { /* ignore */ }
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
    clearNativePreview();
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

  const syncSiblingsFromNav = () => {
    siblings = { paths: nav.paths.slice(), index: nav.index };
  };

  const openPath = async (filePath, { keepPin = false, keepSiblings = false, gen = null, selectAfter = false } = {}) => {
    const target = lib.canonicalizePath(filePath);
    if (!target || !fs.existsSync(target)) {
      previewDebug(`caminho inválido: ${target}`);
      return { ok: false, error: "missing" };
    }
    const requestGen = gen == null ? nav.gen : gen;
    if (opening) {
      queuedOpen = { filePath: target, keepPin, keepSiblings, gen: requestGen, selectAfter };
      previewDebug(`queue gen=${requestGen} ${target}`);
      return { ok: false, error: "busy" };
    }
    opening = true;
    try {
      for (;;) {
        const job = queuedOpen
          ? { filePath: path.resolve(queuedOpen.filePath), keepPin: queuedOpen.keepPin, keepSiblings: queuedOpen.keepSiblings, gen: queuedOpen.gen, selectAfter: queuedOpen.selectAfter }
          : { filePath: target, keepPin, keepSiblings, gen: requestGen, selectAfter };
        queuedOpen = null;
        if (!job.keepPin) pinned = false;
        if (!job.keepSiblings) {
          nav = navLib.applyView(nav, lib.listSiblings(job.filePath).paths, 0);
          const hit = nav.paths.findIndex((p) => navLib.samePath(p, job.filePath));
          if (hit >= 0) nav = { ...nav, index: hit, current: job.filePath };
          syncSiblingsFromNav();
        } else {
          const idx = nav.paths.findIndex((p) => navLib.samePath(p, job.filePath));
          if (idx >= 0) nav = { ...nav, index: idx };
          syncSiblingsFromNav();
        }
        previewDebug(`build gen=${job.gen} currentGen=${nav.gen} ${job.filePath}`);
        const session = await buildSession(job.filePath);
        if (queuedOpen) {
          previewDebug(`skip uncommitted gen=${job.gen} (queued gen=${queuedOpen.gen})`);
          continue;
        }
        const verdict = navLib.acceptShow(nav, job.filePath, job.gen);
        if (!verdict.accepted) {
          previewDebug(`skip stale gen=${job.gen} navGen=${nav.gen} ${job.filePath}`);
          return { ok: true };
        }
        nav = verdict.state;
        syncSiblingsFromNav();
        currentPath = job.filePath;
        if (session.kind === "svg" || session.kind === "image" || session.kind === "video" || session.kind === "audio" || session.kind === "pdf") {
          session.mediaUrl = bumpMediaUrl(session.kind, job.filePath);
        }
        session.index = nav.index;
        session.total = nav.paths.length;
        const window = await ensureWindow();
        if (queuedOpen) {
          previewDebug(`skip after window gen=${job.gen} (queued gen=${queuedOpen.gen})`);
          continue;
        }
        placeWindow();
        window.setAlwaysOnTop(true, "floating");
        window.setSkipTaskbar(pinned);
        if (!office.isOfficeKind(session.kind)) clearNativePreview();
        pushSession(session);
        visible = true;
        setArmed();
        shownAt = Date.now();
        if (!window.isVisible()) window.show();
        sendHostRect();
        if (office.isOfficeKind(session.kind)) {
          const filled = await fillOfficeSession(session, job.filePath);
          if (queuedOpen) {
            previewDebug(`skip office gen=${job.gen} (queued gen=${queuedOpen.gen})`);
            clearNativePreview();
            continue;
          }
          if (filled) pushSession(session);
        }
        if (job.selectAfter) {
          helperSend(`selecti ${nav.index}`);
          helperSend(`select ${job.filePath}`);
        }
        previewDebug(`commit gen=${job.gen} ${job.filePath} ${nav.index + 1}/${nav.paths.length}`);
        return { ok: true };
      }
    } catch (err) {
      previewDebug(`open error: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      opening = false;
      if (queuedOpen) {
        const next = queuedOpen;
        queuedOpen = null;
        void openPath(next.filePath, next);
      }
    }
  };

  const applyHelperView = (currentFile) => {
    if (!helperView || !helperView.paths.length) return false;
    const resolved = navLib.resolveViewItems(
      helperView.paths,
      currentFile || currentPath || nav.current,
      helperView.index,
    );
    for (let i = 0; i < resolved.warnings.length; i += 1) {
      previewDebug(resolved.warnings[i]);
    }
    if (!resolved.paths.length) {
      helperView = null;
      return false;
    }
    nav = navLib.applyView(nav, resolved.paths, resolved.index);
    syncSiblingsFromNav();
    helperView = null;
    return true;
  };

  const navigate = (delta) => {
    const moved = navLib.move(nav, delta);
    if (!moved.action) return Promise.resolve({ ok: false });
    nav = moved.state;
    syncSiblingsFromNav();
    previewDebug(`move delta=${delta} gen=${moved.action.gen} ${moved.action.path} (${moved.action.index + 1}/${moved.action.total})`);
    return openPath(moved.action.path, { keepPin: true, keepSiblings: true, gen: moved.action.gen, selectAfter: true });
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

  const launchOpenAs = (target) => {
    const { spawn } = require("child_process");
    const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", (err) => previewDebug(`open-with rundll32 error ${err.message}`));
    child.unref();
    previewDebug(`open-with rundll32 ${target}`);
  };

  const openWith = () => {
    previewDebug(`open-with click helper=${helperUp ? 1 : 0} path=${currentPath || ""}`);
    if (!currentPath) {
      previewDebug("open-with abort: sem path");
      return { ok: false };
    }
    if (!windowsOnly()) {
      previewDebug("open-with abort: windows-only");
      ctx.diagLog("[Preview] Abrir com... só existe no Windows");
      return { ok: false, error: "windows-only" };
    }
    const target = currentPath;
    ctx.diagLog(`[Preview] Abrir com... ${target}`);
    setOpenWithBusy(true);
    openWithBusyTimer = setTimeout(() => setOpenWithBusy(false), 120000);
    helperSend("fg");
    if (helperUp) {
      helperSend(`openwith ${target}`);
      previewDebug(`open-with helper SHOpenWithDialog ${target}`);
      return { ok: true };
    }
    try {
      launchOpenAs(target);
      clearTimeout(openWithBusyTimer);
      openWithBusyTimer = setTimeout(() => setOpenWithBusy(false), 120000);
      return { ok: true };
    } catch (err) {
      setOpenWithBusy(false);
      previewDebug(`open-with falhou: ${err.message}`);
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
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        let lineBuf = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d) lineBuf = lineBuf.slice(0, -1);
        const line = lib.decodeHelperLine(lineBuf);
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
          const resolved = lib.canonicalizePath(arg);
          const keepSiblings = applyHelperView(resolved);
          if (visible && navLib.shouldIgnoreSelect(nav, resolved)) {
            previewDebug(`ignore explorer echo ${resolved}`);
            nav = navLib.clearIgnoreSelect(nav, resolved);
          } else {
            void openPath(resolved, { keepPin: visible, keepSiblings, gen: nav.gen });
          }
        } else if (cmd === "close") {
          hidePreview();
        } else if (cmd === "next") {
          void navigate(1);
        } else if (cmd === "prev") {
          void navigate(-1);
        } else if (cmd === "launch") {
          void openDefault();
        } else if (cmd === "openwith-done") {
          previewDebug("open-with helper done");
          setOpenWithBusy(false);
        } else if (cmd === "preview-ok") {
          previewDebug("native preview-ok");
          settlePreviewWait({ ok: true });
        } else if (cmd === "preview-fail") {
          previewDebug(`native preview-fail ${arg}`);
          settlePreviewWait({ ok: false, reason: arg || "error" });
        } else if (cmd === "log") {
          previewDebug(`helper ${arg}`);
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
    const action = payload && payload.action;
    const allowed = fromPreview(event);
    previewDebug(`ipc action=${action || ""} fromPreview=${allowed ? 1 : 0} path=${currentPath || ""}`);
    if (!allowed) return { ok: false, error: "origem inválida" };
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
      helperSend("preview-clear");
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
