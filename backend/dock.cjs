"use strict";

/**
 * Módulo Dock: janela Electron sem moldura, pílula VOR, helper nativo só no Windows.
 * Desligado: mata o helper, restaura Shell_TrayWnd e esconde a janela.
 * Sem reserva de AppBar — a Dock flutua; auto-hide não encolhe o workArea.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { BrowserWindow, Menu, screen, shell, powerMonitor } = require("electron");
const lib = require("./dock-lib.cjs");
const win32Launch = require("./win32-launch");

const DEFAULT_DOCK = lib.DEFAULT_DOCK;

function installDock(ctx) {
  let win = null;
  let creating = null;
  let helper = null;
  let helperUp = false;
  let helperStopping = false;
  let helperCrashed = false;
  let visible = false;
  let hideTimer = null;
  let pending = null;
  let sessionGen = 0;
  let showGen = 0;
  let running = [];
  let incomingWindows = [];
  let incomingPins = [];
  let seedPins = [];
  let trayStatus = { vol: 50, mute: 0, battery: 100, ac: 1, online: 1, hasbatt: 0 };
  let lastMonitor = { x: 0, y: 0, width: 1920, height: 1080 };
  let placed = false;
  let iconCache = new Map();
  let powerHooks = false;
  let trayHidden = false;
  let appearTimer = null;
  let visibleConfirmed = false;
  let helperPath = ctx.dockHelperPath;

  const settings = () => lib.normalizeDockSettings(ctx.getDockSettings());
  const windowsOnly = () => process.platform === "win32";
  const appearance = () => (typeof ctx.getAppearance === "function" ? ctx.getAppearance() : {
    theme: "black", accent: "#FFFFFF", glass: true, opacity: 0.8,
  });
  const language = () => (typeof ctx.language === "function" && ctx.language() === "en" ? "en" : "pt");

  const helperSend = (line) => {
    if (!lib.helperChildAlive(helper)) return false;
    return lib.writeHelperLine(helper.stdin, line);
  };

  const dockLog = (msg) => {
    if (typeof ctx.diagLog === "function") ctx.diagLog(`[Dock] ${msg}`);
    try {
      const dir = typeof ctx.app?.getPath === "function" ? ctx.app.getPath("userData") : null;
      if (!dir) return;
      const file = path.join(dir, "dock.log");
      fs.appendFile(file, `[${new Date().toISOString()}] ${msg}\n`, () => {});
    } catch { /* ignore */ }
  };

  const resolveHelper = () => {
    const preferred = ctx.dockHelperPath;
    const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
    const unpackedDir = path.join(__dirname, "bin").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    const found = lib.resolveNativeHelper("vor-dock.exe", [
      preferred ? path.dirname(preferred) : "",
      unpackedDir,
      path.join(__dirname, "bin"),
      resources ? path.join(resources, "app.asar.unpacked", "backend", "bin") : "",
      resources ? path.join(resources, "bin") : "",
    ]);
    helperPath = found || preferred;
    return helperPath;
  };

  const restoreTaskbarOnce = () => {
    if (!windowsOnly()) return;
    const exe = resolveHelper();
    if (!exe || !fs.existsSync(exe)) {
      dockLog(`restore skipped — helper ausente (${exe || "?"})`);
      return;
    }
    try { spawn(exe, ["restore"], { windowsHide: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
  };

  const hideWindowsTaskbar = () => {
    if (trayHidden) return;
    helperSend("arm 1");
    trayHidden = true;
    dockLog("taskbar escondida — pílula visível");
  };

  const showWindowsTaskbar = () => {
    helperSend("arm 0");
    trayHidden = false;
    restoreTaskbarOnce();
  };

  const clearAppearWatch = () => {
    if (appearTimer) {
      clearTimeout(appearTimer);
      appearTimer = null;
    }
  };

  const startAppearWatch = () => {
    clearAppearWatch();
    appearTimer = setTimeout(() => {
      appearTimer = null;
      if (visibleConfirmed) return;
      dockLog(`timeout ${lib.DOCK_APPEAR_TIMEOUT_MS}ms — pílula não apareceu`);
      failDock("timeout-visible");
    }, lib.DOCK_APPEAR_TIMEOUT_MS);
  };

  const confirmDockVisible = () => {
    if (!settings().enabled) return;
    if (win && !win.isDestroyed()) {
      try { if (!win.isVisible()) win.showInactive(); } catch { /* ignore */ }
    }
    visibleConfirmed = true;
    clearAppearWatch();
    hideWindowsTaskbar();
    const cfg = settings();
    if (cfg.autoHide && win && !win.isDestroyed()) {
      const cursor = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      if (!lib.pointInRect(bounds, cursor)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          hideDock();
        }, Math.max(cfg.autoHideDelayMs, lib.DOCK_FIRST_HIDE_GRACE_MS));
      }
    }
  };

  const sendToDock = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    try { win.webContents.send(channel, payload); } catch { /* ignore */ }
  };

  const iconFor = async (filePath) => {
    const key = String(filePath || "").trim().toLowerCase();
    if (!key) return "";
    if (iconCache.has(key)) return iconCache.get(key);
    let url = "";
    try {
      if (fs.existsSync(filePath)) {
        const img = await ctx.app.getFileIcon(filePath, { size: "large" });
        url = img ? img.toDataURL() : "";
      }
    } catch { /* ignore */ }
    iconCache.set(key, url);
    return url;
  };

  const mergeItems = (cfg) => lib.mergeDockItems(lib.pinsForMerge(cfg, seedPins), running);

  const buildSession = async () => {
    const gen = ++sessionGen;
    const cfg = settings();
    const items = mergeItems(cfg);
    const withIcons = [];
    for (const item of items) {
      const icon = item.icon || (await iconFor(item.iconPath || item.command));
      withIcons.push({ ...item, icon });
    }
    if (gen !== sessionGen) return pending;
    const session = {
      visible,
      settings: cfg,
      appearance: appearance(),
      language: language(),
      items: withIcons,
      tray: trayStatus,
      position: cfg.position,
    };
    pending = session;
    return session;
  };

  const pushSession = async () => {
    const session = await buildSession();
    if (session) sendToDock("dock-session", session);
    return session;
  };

  const dipToPhysical = (rect) => {
    try {
      if (rect && typeof screen.dipToScreenRect === "function") {
        return screen.dipToScreenRect(win && !win.isDestroyed() ? win : null, rect);
      }
    } catch { /* ignore */ }
    return rect;
  };

  const physicalToDip = (rect) => {
    try {
      if (rect && typeof screen.screenToDipRect === "function") {
        return screen.screenToDipRect(win && !win.isDestroyed() ? win : null, rect);
      }
    } catch { /* ignore */ }
    return rect;
  };

  const displaysOf = () => screen.getAllDisplays().map((d) => ({
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));

  const placeWindow = (monitor) => {
    if (!win || win.isDestroyed()) return null;
    const cfg = settings();
    const items = mergeItems(cfg);
    const bounds = lib.dockWindowBounds(monitor, cfg, items.length);
    lastMonitor = monitor;
    placed = true;
    win.setBounds(bounds);
    const phys = dipToPhysical(bounds) || bounds;
    helperSend(`hostrect ${Math.round(phys.x)} ${Math.round(phys.y)} ${Math.round(phys.width)} ${Math.round(phys.height)}`);
    return bounds;
  };

  const showDock = async (monitor) => {
    const gen = ++showGen;
    if (!settings().enabled) return;
    await ensureWindow();
    if (gen !== showGen || !settings().enabled) return;
    if (!win || win.isDestroyed()) return;
    const mon = monitor || lastMonitor || screen.getPrimaryDisplay().bounds;
    placeWindow(mon);
    visible = true;
    clearTimeout(hideTimer);
    helperSend("list");
    helperSend("status");
    await pushSession();
    if (gen !== showGen || !settings().enabled) return;
    if (!win || win.isDestroyed()) return;
    try { win.setAlwaysOnTop(true, "floating"); } catch { /* ignore */ }
    try { win.showInactive(); } catch { win.show(); }
    dockLog(`janela showInactive ${JSON.stringify(win.getBounds())}`);
    if (visibleConfirmed) hideWindowsTaskbar();
  };

  const hideDock = () => {
    showGen += 1;
    visible = false;
    placed = false;
    clearTimeout(hideTimer);
    helperSend("hostrect 0 0 0 0");
    if (win && !win.isDestroyed()) {
      try { win.hide(); } catch { /* ignore */ }
    }
    void pushSession();
  };

  const scheduleHide = () => {
    const cfg = settings();
    if (!cfg.autoHide) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      hideDock();
    }, cfg.autoHideDelayMs);
  };

  const loadDockPage = async (window) => {
    if (ctx.isDev) await window.loadURL("http://localhost:5173/dock.html");
    else await window.loadFile(ctx.dockHtmlPath);
  };

  const createWindow = () => {
    const window = new BrowserWindow({
      width: 640,
      height: 96,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      thickFrame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
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
    window.setMenuBarVisibility(false);
    window.on("closed", () => { if (win === window) win = null; });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (/^https?:\/\/localhost:5173\//i.test(url) || url.startsWith("file:")) return;
      event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    window.webContents.on("did-fail-load", (_event, code, desc) => {
      dockLog(`load fail ${code} ${desc}`);
      failDock("load-fail");
    });
    window.webContents.on("did-finish-load", () => {
      dockLog("página da pílula carregada");
    });
    return window;
  };

  const ensureWindow = async () => {
    if (win && !win.isDestroyed()) return win;
    if (creating) return creating;
    creating = (async () => {
      const window = createWindow();
      win = window;
      sendDockHwnd();
      await loadDockPage(window);
      if (!settings().enabled) {
        try { window.close(); } catch { /* ignore */ }
        if (win === window) win = null;
        return null;
      }
      return win;
    })();
    try {
      return await creating;
    } finally {
      creating = null;
    }
  };

  const sendDockHwnd = () => {
    if (!win || win.isDestroyed()) return;
    try {
      const handle = win.getNativeWindowHandle();
      const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      helperSend(`hwnd ${hwnd.toString()}`);
    } catch { /* ignore */ }
  };

  const persistPins = (pins) => {
    if (typeof ctx.patchDockPins === "function") {
      ctx.patchDockPins(Array.isArray(pins) ? pins : [], { pinsSeeded: true });
    }
  };

  const applySeedIfNeeded = () => {
    if (settings().pinsSeeded) return;
    persistPins(seedPins);
  };

  const parseStatus = (arg) => {
    const next = { ...trayStatus };
    for (const part of String(arg || "").split(/\s+/)) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const key = part.slice(0, eq);
      const value = Number(part.slice(eq + 1));
      if (key === "vol") next.vol = value;
      else if (key === "mute") next.mute = value;
      else if (key === "battery") next.battery = value;
      else if (key === "ac") next.ac = value;
      else if (key === "online") next.online = value;
      else if (key === "hasbatt") next.hasbatt = value;
    }
    trayStatus = next;
  };

  const onHelperLine = (line) => {
    const sp = line.indexOf(" ");
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const arg = sp < 0 ? "" : line.slice(sp + 1);
    if (cmd === "ready") {
      helperUp = true;
      helperSend(`parent ${process.pid}`);
      syncHelper();
    } else if (cmd === "edge") {
      const parts = arg.split(/\s+/);
      const kind = parts[0];
      const monitor = {
        x: Number(parts[1]) || 0,
        y: Number(parts[2]) || 0,
        width: Number(parts[3]) || lastMonitor.width,
        height: Number(parts[4]) || lastMonitor.height,
      };
      if (kind === "in") {
        clearTimeout(hideTimer);
        const dip = physicalToDip(monitor) || monitor;
        const cfg = settings();
        const chosen = cfg.monitor === "primary"
          ? lib.pickMonitor(displaysOf(), { x: dip.x + dip.width / 2, y: dip.y + dip.height / 2 }, "primary")
          : dip;
        void showDock(chosen);
      } else if (kind === "out") {
        scheduleHide();
      }
    } else if (cmd === "win") {
      const parts = arg.split(/\s+/);
      const hwnd = parts[0];
      const pid = Number(parts[1]) || 0;
      const exe = parts.slice(2).join(" ");
      incomingWindows.push({ hwnd, pid, path: exe, command: exe, hwnds: [hwnd], label: path.basename(exe, ".exe") });
    } else if (cmd === "title") {
      const sp2 = arg.indexOf(" ");
      const hwnd = sp2 < 0 ? arg : arg.slice(0, sp2);
      const title = sp2 < 0 ? "" : arg.slice(sp2 + 1);
      const row = incomingWindows[incomingWindows.length - 1];
      if (row && String(row.hwnd) === String(hwnd) && title) row.label = title;
    } else if (cmd === "wins-end") {
      const grouped = [];
      const byPath = new Map();
      for (const row of incomingWindows) {
        const key = String(row.path || row.command || "").toLowerCase() || `hwnd-${row.hwnd}`;
        if (!byPath.has(key)) {
          const item = { ...row, hwnds: [row.hwnd] };
          byPath.set(key, item);
          grouped.push(item);
        } else {
          byPath.get(key).hwnds.push(row.hwnd);
        }
      }
      incomingWindows = [];
      running = grouped;
      if (visible && placed) placeWindow(lastMonitor);
      void pushSession();
    } else if (cmd === "pin") {
      incomingPins.push(lib.normalizeDockPin({
        id: `winpin-${incomingPins.length + 1}`,
        command: arg,
        label: path.basename(arg, ".exe"),
        iconPath: arg,
      }, incomingPins.length));
    } else if (cmd === "pin-label") {
      if (incomingPins.length) incomingPins[incomingPins.length - 1].label = arg || incomingPins[incomingPins.length - 1].label;
    } else if (cmd === "pins-end") {
      seedPins = incomingPins.filter(Boolean);
      incomingPins = [];
      applySeedIfNeeded();
      void pushSession();
    } else if (cmd === "status") {
      parseStatus(arg);
      void pushSession();
    } else if (cmd === "lock") {
      ctx.diagLog("[Dock] sessão bloqueada — barra do Windows restaurada");
      hideDock();
    } else if (cmd === "unlock") {
      ctx.diagLog("[Dock] sessão desbloqueada");
      if (settings().enabled) syncHelper();
    } else if (cmd === "gone") {
      ctx.diagLog("[Dock] helper perdeu o pai — barra restaurada");
    } else if (cmd === "fail") {
      ctx.diagLog(`[Dock] helper falhou (${arg || "desconhecido"})`);
      failDock(arg || "helper");
    } else if (cmd === "log") {
      ctx.diagLog(`[Dock] ${arg}`);
    }
  };

  const startHelper = () => {
    if (!windowsOnly() || helper) return false;
    const exe = resolveHelper();
    if (!exe || !fs.existsSync(exe)) {
      dockLog(`helper nativo ausente (${exe || ctx.dockHelperPath})`);
      failDock("helper-ausente");
      return false;
    }
    dockLog(`helper ${exe}`);
    running = [];
    incomingWindows = [];
    incomingPins = [];
    seedPins = [];
    helperStopping = false;
    const child = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    helper = child;
    helperUp = false;
    const onGone = (why) => {
      if (helper !== child) return;
      helper = null;
      helperUp = false;
      showWindowsTaskbar();
      hideDock();
      if (helperStopping) return;
      failDock(why);
    };
    lib.guardHelperPipes(child, (err) => {
      const code = err && err.code;
      ctx.diagLog(`[Dock] pipe ${code || (err && err.message) || "error"}`);
      if (code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED") onGone(code || "pipe");
    });
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let nl;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        let lineBuf = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d) lineBuf = lineBuf.slice(0, -1);
        const line = lineBuf.toString("utf8").trim();
        if (line) onHelperLine(line);
      }
    });
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = String(chunk || "").trim();
        if (text) ctx.diagLog(`[Dock] stderr ${text.slice(0, 400)}`);
      });
    }
    child.on("exit", (code, signal) => onGone(`código ${code}${signal ? `/${signal}` : ""}`));
    child.on("close", () => onGone("close"));
    return true;
  };

  const failDock = (why) => {
    helperCrashed = true;
    visibleConfirmed = false;
    clearAppearWatch();
    showWindowsTaskbar();
    hideDock();
    helperStopping = true;
    if (helper) {
      const child = helper;
      helper = null;
      helperUp = false;
      try { if (child) child.kill(); } catch { /* ignore */ }
    }
    ctx.diagLog(`[Dock] a desligar o módulo — ${why || "helper saiu"}`);
    if (typeof ctx.disableDock === "function") ctx.disableDock(String(why || "helper saiu"));
  };

  const stopHelper = () => {
    helperStopping = true;
    visibleConfirmed = false;
    clearAppearWatch();
    helperSend("edge off");
    helperSend("arm 0");
    helperSend("quit");
    const child = helper;
    helper = null;
    helperUp = false;
    trayHidden = false;
    try { if (child && child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* ignore */ }
    try { if (child) child.kill(); } catch { /* ignore */ }
    restoreTaskbarOnce();
  };

  const syncHelper = () => {
    const cfg = settings();
    if (!windowsOnly() || !cfg.enabled) {
      helperCrashed = false;
      visibleConfirmed = false;
      clearAppearWatch();
      stopHelper();
      hideDock();
      return;
    }
    if (helperCrashed) {
      showWindowsTaskbar();
      return;
    }
    if (!lib.helperChildAlive(helper)) {
      helper = null;
      startHelper();
    }
    helperSend(`slop 2`);
    helperSend(cfg.autoHide ? `edge ${cfg.position}` : "edge off");
    sendDockHwnd();
    helperSend("pins");
    helperSend("list");
    helperSend("status");
    const displays = displaysOf();
    const cursor = screen.getCursorScreenPoint();
    const monitor = lib.pickMonitor(displays, cursor, cfg.monitor);
    if (!visibleConfirmed) startAppearWatch();
    void showDock(monitor);
  };

  const fromDock = (event) => win && !win.isDestroyed() && event.sender === win.webContents;

  const launchItem = (item) => {
    if (!item || !item.command) return { ok: false };
    if (typeof ctx.launch === "function") {
      ctx.launch(item.command, item.commandType || "app");
      return { ok: true };
    }
    const command = String(item.command).trim();
    if (item.commandType === "url" || /^https?:/i.test(command) || /^ms-/i.test(command) || /^shell:/i.test(command)) {
      void shell.openExternal(command);
      return { ok: true };
    }
    if (command.includes("!")) {
      try { spawn("explorer.exe", [`shell:AppsFolder\\${command}`], { detached: true, stdio: "ignore" }).unref(); }
      catch { /* ignore */ }
      return { ok: true };
    }
    try {
      const { exe, args } = win32Launch.splitWin32SpawnExeAndArgs(command);
      spawn(exe || command, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
    } catch {
      void shell.openPath(command);
    }
    return { ok: true };
  };

  const activateOrLaunch = (item) => {
    if (item && item.hwnds && item.hwnds.length) {
      helperSend(`activate ${item.hwnds[item.hwnds.length - 1]}`);
      return { ok: true };
    }
    return launchItem(item);
  };

  const findItem = async (id) => {
    const session = pending || await buildSession();
    return (session.items || []).find((item) => item.id === id) || null;
  };

  const popupMenu = async (item) => {
    if (!item) return { ok: false };
    const pt = language() === "en";
    const template = [
      { label: pt ? "Open" : "Abrir", click: () => activateOrLaunch(item) },
    ];
    if (item.running && item.hwnds && item.hwnds.length) {
      template.push({
        label: pt ? "Close window" : "Fechar janela",
        click: () => helperSend(`close ${item.hwnds[item.hwnds.length - 1]}`),
      });
    }
    template.push({ type: "separator" });
    template.push({
      label: item.pinned ? (pt ? "Unpin" : "Desafixar") : (pt ? "Pin" : "Fixar"),
      click: () => {
        const cfg = settings();
        const pins = item.pinned
          ? cfg.pins.filter((pin) => pin.id !== item.id && !lib.sameCommand(pin.command, item.command))
          : [...cfg.pins, lib.normalizeDockPin({
            id: item.id,
            label: item.label,
            command: item.command,
            commandType: item.commandType,
            iconPath: item.iconPath,
          }, cfg.pins.length)].filter(Boolean);
        persistPins(pins);
      },
    });
    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: win || undefined });
    return { ok: true };
  };

  const trayAction = (name) => {
    if (name === "notify") {
      helperSend("status");
      try { spawn("explorer.exe", ["ms-actioncenter:"], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
      catch {
        try { spawn("cmd", ["/c", "start", "", "ms-actioncenter:"], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
      }
      return { ok: true };
    }
    if (name === "sound") {
      try { spawn("explorer.exe", ["ms-settings:sound"], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
      catch { /* ignore */ }
      return { ok: true };
    }
    if (name === "overflow") {
      // Win+B continua no explorer — a barra está só escondida, não destruída.
      try { spawn("explorer.exe", ["shell:::{05d7b0f4-2121-4eff-bf6b-ed3f69b894d9}"], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }
      catch { /* ignore */ }
      return { ok: true };
    }
    return { ok: false };
  };

  ctx.ipcMain.handle("dock-pending", (event) => (fromDock(event) ? pending : null));
  ctx.ipcMain.handle("dock-action", async (event, payload) => {
    if (!fromDock(event)) return { ok: false, error: "origem inválida" };
    const action = payload && payload.action;
    if (action === "ready") {
      sendDockHwnd();
      const session = await pushSession();
      return { ok: true, session };
    }
    if (action === "painted") {
      dockLog("renderer pintou a pílula");
      confirmDockVisible();
      return { ok: true };
    }
    if (action === "pointer-in") {
      clearTimeout(hideTimer);
      return { ok: true };
    }
    if (action === "pointer-out") {
      scheduleHide();
      return { ok: true };
    }
    if (action === "click") {
      const item = await findItem(payload.id);
      return activateOrLaunch(item);
    }
    if (action === "menu") {
      const item = await findItem(payload.id);
      return popupMenu(item);
    }
    if (action === "tray") return trayAction(payload.name);
    return { ok: false, error: "ação desconhecida" };
  });

  if (typeof ctx.onAppearance === "function") {
    ctx.onAppearance(() => { void pushSession(); });
  }

  const attachPower = () => {
    if (powerHooks || !windowsOnly()) return;
    powerHooks = true;
    try {
      powerMonitor.on("lock-screen", () => helperSend("lock"));
      powerMonitor.on("unlock-screen", () => helperSend("unlock"));
      powerMonitor.on("shutdown", () => { showWindowsTaskbar(); stopHelper(); hideDock(); });
      powerMonitor.on("suspend", () => helperSend("lock"));
      powerMonitor.on("resume", () => helperSend("unlock"));
    } catch { /* ignore */ }
  };

  restoreTaskbarOnce();
  attachPower();
  process.on("exit", () => {
    try { restoreTaskbarOnce(); } catch { /* ignore */ }
  });
  queueMicrotask(() => {
    if (settings().enabled) syncHelper();
  });

  return {
    sync: syncHelper,
    dispose: () => {
      showGen += 1;
      clearTimeout(hideTimer);
      clearAppearWatch();
      showWindowsTaskbar();
      stopHelper();
      hideDock();
      if (win && !win.isDestroyed()) {
        try { win.close(); } catch { /* ignore */ }
      }
      win = null;
    },
  };
}

module.exports = {
  DEFAULT_DOCK,
  installDock,
};
