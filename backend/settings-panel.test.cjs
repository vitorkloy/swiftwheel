"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  shouldKeepSettingsPanel,
  createMainWindowVisibilityGuard,
} = require("./settings-panel.cjs");

describe("settings-panel", () => {
  it("mantém Definições na roda se o painel está visível mesmo sem overlayActive", () => {
    assert.equal(shouldKeepSettingsPanel({ panelVisible: true, overlayActive: false }), true);
    assert.equal(shouldKeepSettingsPanel({ panelVisible: false, overlayActive: true }), true);
    assert.equal(shouldKeepSettingsPanel({ panelVisible: true, overlayActive: true }), true);
    assert.equal(shouldKeepSettingsPanel({ panelVisible: false, overlayActive: false }), false);
    assert.equal(shouldKeepSettingsPanel({}), false);
  });

  it("esconde a main só se estiver visível e devolve-a com showInactive", () => {
    const calls = [];
    const win = {
      isDestroyed: () => false,
      isVisible: () => calls.filter((c) => c === "hide").length === 0,
      hide: () => calls.push("hide"),
      showInactive: () => calls.push("showInactive"),
      show: () => calls.push("show"),
    };
    const guard = createMainWindowVisibilityGuard(() => win);
    assert.equal(guard.hideForCapture(), true);
    assert.equal(guard.wasHidden(), true);
    assert.deepEqual(calls, ["hide"]);
    assert.equal(guard.restoreAfterCapture(), true);
    assert.equal(guard.wasHidden(), false);
    assert.deepEqual(calls, ["hide", "showInactive"]);
    assert.equal(guard.restoreAfterCapture(), false);
  });

  it("não esconde de novo se a janela já não está visível", () => {
    const guard = createMainWindowVisibilityGuard(() => ({
      isDestroyed: () => false,
      isVisible: () => false,
      hide: () => {
        throw new Error("não deveria hide");
      },
    }));
    assert.equal(guard.hideForCapture(), false);
    assert.equal(guard.wasHidden(), false);
  });

  it("restore após destroy não lança e limpa o flag", () => {
    const guard = createMainWindowVisibilityGuard(() => ({
      isDestroyed: () => true,
      isVisible: () => true,
      hide: () => {},
    }));
    const live = createMainWindowVisibilityGuard(() => ({
      isDestroyed: () => false,
      isVisible: () => true,
      hide: () => {},
      showInactive: () => {},
    }));
    assert.equal(live.hideForCapture(), true);
    assert.equal(live.restoreAfterCapture(), true);
    assert.equal(guard.hideForCapture(), false);
  });

  it("captura, roda e Escape não fecham Definições", () => {
    const screenshot = fs.readFileSync(path.join(__dirname, "screenshot.cjs"), "utf8");
    assert.match(screenshot, /createMainWindowVisibilityGuard/);
    assert.match(screenshot, /restoreAfterCapture/);
    assert.match(screenshot, /BitBlt nativo já correu/);
    const main = fs.readFileSync(path.join(__dirname, "electron-main.js"), "utf8");
    assert.match(main, /shouldKeepSettingsPanel/);
    assert.match(main, /Já escondida \(captura\/roda\)/);
    const radial = fs.readFileSync(path.join(__dirname, "..", "src", "components", "RadialMenu.tsx"), "utf8");
    assert.match(radial, /e\.stopPropagation\(\)/);
    const settings = fs.readFileSync(path.join(__dirname, "..", "src", "components", "PrecisionSettings.tsx"), "utf8");
    assert.match(settings, /event\.defaultPrevented/);
  });
});
