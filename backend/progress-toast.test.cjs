"use strict";

const { afterEach, describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { createProgressToast } = require("./progress-toast.cjs");

function mockWindow() {
  const calls = { hide: 0, destroy: 0, showInactive: 0 };
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive: () => { calls.showInactive += 1; },
    hide: () => { calls.hide += 1; },
    destroy: () => { calls.destroy += 1; },
    setIgnoreMouseEvents: () => {},
    setAlwaysOnTop: () => {},
    loadURL: async () => {},
    webContents: { executeJavaScript: async () => {} },
  };
  return { win, calls };
}

describe("progress-toast", () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it("cancela o hide de 180 ms se um show novo chegar no meio da saída", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { win, calls } = mockWindow();
    const toast = createProgressToast({
      BrowserWindow: function BrowserWindow() { return win; },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
      getAppearance: () => ({ theme: "black", accent: "#ffffff" }),
    });

    toast.show("Procurando atualizações…", -1);
    toast.hide(0);
    mock.timers.tick(0);
    assert.equal(calls.hide, 0);

    toast.show("Você está na versão mais recente (v0.2.17)", 1);
    mock.timers.tick(180);
    assert.equal(calls.hide, 0);
  });

  it("esconde depois dos 180 ms quando não há trabalho novo", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { win, calls } = mockWindow();
    const toast = createProgressToast({
      BrowserWindow: function BrowserWindow() { return win; },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
      getAppearance: () => ({ theme: "black", accent: "#ffffff" }),
    });

    toast.show("Procurando atualizações…", -1);
    toast.hide(0);
    mock.timers.tick(0);
    mock.timers.tick(180);
    assert.equal(calls.hide, 1);
  });
});
