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

  it("a janela Electron não reserva área e o auto-hide usa o delay do settings", () => {
    assert.match(main, /dockWindowBounds/);
    assert.match(main, /autoHideDelayMs/);
    assert.match(main, /showInactive/);
    assert.match(main, /powerMonitor/);
    assert.match(main, /lock-screen/);
    assert.match(main, /não encolhe o workArea/);
    assert.match(settings, /id: 'dock'/);
    assert.match(settings, /dock-enabled/);
    assert.match(settings, /150/);
  });
});
