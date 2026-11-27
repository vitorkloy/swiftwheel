"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const lib = require("./dock-lib.cjs");
const prefs = require("./prefs.cjs");

describe("dock-lib", () => {
  it("defaults: desligada, lift 6 px, auto-hide 150 ms, sem magnificação", () => {
    const cfg = lib.normalizeDockSettings(undefined);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.liftPx, 6);
    assert.equal(cfg.autoHide, true);
    assert.equal(cfg.autoHideDelayMs, 150);
    assert.equal(cfg.magnification, false);
    assert.equal(cfg.position, "bottom");
    assert.equal(cfg.monitor, "follow-mouse");
    assert.deepEqual(cfg.pins, []);
    assert.equal(cfg.pinsSeeded, false);
  });

  it("pins vazios depois de pinsSeeded não voltam à semente da taskbar", () => {
    const seed = [{ id: "s1", label: "Edge", command: "msedge" }];
    assert.equal(lib.pinsForMerge({ pins: [], pinsSeeded: false }, seed).length, 1);
    assert.equal(lib.pinsForMerge({ pins: [], pinsSeeded: true }, seed).length, 0);
    assert.equal(lib.pinsForMerge({ pins: [{ command: "notepad" }], pinsSeeded: false }, seed).length, 1);
    assert.equal(lib.pinsForMerge({ pins: [{ command: "notepad" }], pinsSeeded: false }, seed)[0].command, "notepad");
  });

  it("preserva pins e recusa comando vazio", () => {
    const cfg = lib.normalizeDockSettings({
      enabled: true,
      pins: [
        { id: "a", label: "Edge", command: "msedge" },
        { label: "vazio", command: "  " },
      ],
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.pins.length, 1);
    assert.equal(cfg.pins[0].command, "msedge");
  });

  it("não usa workArea: a janela senta no bounds cheio do monitor", () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
    const bounds = lib.dockWindowBounds(monitor, { autoHide: true, iconSize: 48, liftPx: 6 }, 4);
    assert.equal(bounds.y + bounds.height, 1080);
    assert.ok(bounds.x > 0);
    assert.ok(bounds.x + bounds.width < 1920);
  });

  it("na lateral a altura cobre os ícones empilhados, o tray e o padding da pílula", () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
    const cfg = { position: "left", iconSize: 48, liftPx: 6 };
    const n = 6;
    const bounds = lib.dockWindowBounds(monitor, cfg, n);
    const chrome = lib.dockChrome(cfg);
    const itemsH = n * chrome.itemButton + (n - 1) * chrome.gap;
    const needed = chrome.rootPad + chrome.pillPadSide + itemsH + chrome.pillGap + chrome.trayVertical;
    assert.ok(bounds.height >= Math.min(monitor.height - 16, needed));
    assert.ok(bounds.height <= monitor.height - 16);
    assert.equal(bounds.x, 0);
  });

  it("detecta a borda inferior com slop de 2 px", () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
    assert.equal(lib.cursorOnEdge(monitor, { x: 100, y: 1079 }, "bottom", 2), true);
    assert.equal(lib.cursorOnEdge(monitor, { x: 100, y: 500 }, "bottom", 2), false);
    assert.equal(lib.cursorOnEdge(monitor, { x: 1, y: 500 }, "left", 2), true);
  });

  it("segue o ponteiro ou fica no principal", () => {
    const displays = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true },
      { bounds: { x: 1920, y: 0, width: 1600, height: 900 }, primary: false },
    ];
    const follow = lib.pickMonitor(displays, { x: 2000, y: 10 }, "follow-mouse");
    assert.equal(follow.x, 1920);
    const primary = lib.pickMonitor(displays, { x: 2000, y: 10 }, "primary");
    assert.equal(primary.x, 0);
  });

  it("junta pins e janelas abertas sem duplicar o mesmo comando", () => {
    const items = lib.mergeDockItems(
      [{ id: "p1", label: "Edge", command: "C:\\\\Program Files\\\\msedge.exe" }],
      [{ path: "C:\\\\Program Files\\\\msedge.exe", hwnd: 1, label: "Guia" }, { path: "C:\\\\Windows\\\\notepad.exe", hwnd: 2, label: "Notepad" }],
    );
    assert.equal(items.length, 2);
    assert.equal(items[0].pinned, true);
    assert.equal(items[0].running, true);
    assert.equal(items[1].pinned, false);
    assert.equal(items[1].label, "Notepad");
  });
});

describe("prefs.dock", () => {
  it("módulo Dock nasce desligado, mesmo sem chave", () => {
    const modules = prefs.normalizeModules({});
    assert.equal(modules.dock, false);
    assert.equal(prefs.moduleOn({}, "dock"), false);
    assert.equal(prefs.moduleOn({ dock: true }, "dock"), true);
  });

  it("herda dock.enabled de um config antigo sem modules.dock", () => {
    const modules = prefs.normalizeModules({}, { enabled: true }, { enabled: true }, { enabled: true });
    assert.equal(modules.dock, true);
  });
});

describe("native helper source", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "native", "vor-dock.cs"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "dock.cjs"), "utf8");
  const settings = fs.readFileSync(path.join(__dirname, "..", "src", "components", "PrecisionSettings.tsx"), "utf8");

  it("fica no C# 4 para o csc do Framework 4", () => {
    assert.doesNotMatch(src, /\$"/);
    assert.doesNotMatch(src, /\?\./);
    assert.doesNotMatch(src, /\basync\b/);
    assert.doesNotMatch(src, /nameof\s*\(/);
  });

  it("esconde e restaura Shell_TrayWnd sem AppBar e sem injetar no explorer", () => {
    assert.match(src, /Shell_TrayWnd/);
    assert.match(src, /Shell_SecondaryTrayWnd/);
    assert.match(src, /ShowWindow/);
    assert.match(src, /SW_HIDE/);
    assert.match(src, /SW_SHOW/);
    assert.match(src, /WaitForSingleObject/);
    assert.match(src, /WTS_SESSION_LOCK/);
    assert.match(src, /UnhandledException/);
    assert.match(src, /restore/);
    assert.doesNotMatch(src, /SHAppBarMessage/);
    assert.doesNotMatch(src, /ReadProcessMemory/);
    assert.doesNotMatch(src, /CreateRemoteThread/);
    assert.doesNotMatch(src, /SetWindowsHookEx\([^)]*explorer/i);
  });

  it("usa WH_MOUSE_LL e não instala hook de teclado — Win\\+número fica com o Explorer", () => {
    assert.match(src, /WH_MOUSE_LL/);
    assert.doesNotMatch(src, /WH_KEYBOARD_LL/);
    assert.doesNotMatch(src, /RegisterHotKey/);
    assert.match(src, /CallNextHookEx/);
  });

  it("GetModuleHandle vem do kernel32 e o hook de rato só liga com edge on", () => {
    assert.match(src, /\[DllImport\("kernel32\.dll"[^\n]*GetModuleHandle/);
    assert.doesNotMatch(src, /\[DllImport\("user32\.dll"[^\n]*GetModuleHandle/);
    assert.match(src, /MSG_HOOK_ON/);
    assert.match(src, /MSG_HOOK_OFF/);
    assert.match(src, /RequestMouseHook\(false\)/);
    assert.match(src, /UnhookWindowsHookEx/);
    assert.match(src, /catch \(Exception ex\)/);
  });

  it("refresca a lista de janelas com SetWinEventHook, sem poll", () => {
    assert.match(src, /SetWinEventHook/);
    assert.match(src, /EVENT_OBJECT_SHOW/);
    assert.match(src, /WINEVENT_OUTOFCONTEXT/);
    assert.match(src, /UnhookWinEvent/);
  });

  it("a janela Electron não reserva área e o auto-hide usa o delay do settings", () => {
    assert.match(main, /dockWindowBounds/);
    assert.match(main, /autoHideDelayMs/);
    assert.match(main, /showInactive/);
    assert.match(main, /powerMonitor/);
    assert.match(main, /lock-screen/);
    assert.match(main, /não encolhe o workArea/);
    assert.match(main, /dipToScreenRect/);
    assert.match(main, /screenToDipRect/);
    assert.match(main, /pinsSeeded/);
    assert.match(main, /showGen/);
    assert.match(main, /creating/);
    assert.match(settings, /id: 'dock'/);
    assert.match(settings, /dock-enabled/);
    assert.match(settings, /150/);
  });
});

describe("ci", () => {
  it("unit tests no workflow usam shell bash", () => {
    const yml = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-windows.yml"), "utf8");
    assert.match(yml, /name: Unit tests\s+shell: bash/);
  });
});
