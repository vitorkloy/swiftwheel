"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  hwndFromHandle,
  hwndFromWindow,
  pinToAllWorkspaces,
  captureActivateSteps,
  captureParkSteps,
  shouldRecreateOverlay,
  activateCaptureOverlay,
  parkCaptureOverlay,
  presentInactiveOnCurrentDesktop,
} = require("./window-desktop.cjs");

describe("window-desktop", () => {
  it("lê HWND de 32 e 64 bits e ignora nulo", () => {
    const buf64 = Buffer.alloc(8);
    buf64.writeBigUInt64LE(42n);
    assert.equal(hwndFromHandle(buf64), "42");
    const buf32 = Buffer.alloc(4);
    buf32.writeUInt32LE(7);
    assert.equal(hwndFromHandle(buf32), "7");
    assert.equal(hwndFromHandle(Buffer.alloc(8)), "");
    assert.equal(hwndFromHandle(null), "");
    assert.equal(hwndFromHandle(Buffer.alloc(2)), "");
  });

  it("hwndFromWindow tolera janela destruída ou sem handle", () => {
    assert.equal(hwndFromWindow(null), "");
    assert.equal(hwndFromWindow({ isDestroyed: () => true }), "");
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(99n);
    assert.equal(hwndFromWindow({
      isDestroyed: () => false,
      getNativeWindowHandle: () => buf,
    }), "99");
  });

  it("activate nunca faz focus antes de todesktop / showInactive", () => {
    const steps = captureActivateSteps({ hwnd: "1", helperReady: true, movedToCurrentDesktop: true });
    assert.ok(steps.indexOf("todesktop") < steps.indexOf("show-inactive"));
    assert.ok(steps.indexOf("show-inactive") < steps.indexOf("focus"));
    const withoutMove = captureActivateSteps({ hwnd: "1", helperReady: true, movedToCurrentDesktop: false });
    assert.ok(!withoutMove.includes("focus"));
  });

  it("park devolve o foreground antes de desligar o foco", () => {
    const steps = captureParkSteps({ helperReady: true });
    assert.deepEqual(steps, ["restorefg", "unfocus"]);
    assert.deepEqual(captureParkSteps({ helperReady: false }), ["unfocus"]);
  });

  it("recria o overlay se o HWND ficou noutro desktop", () => {
    assert.equal(shouldRecreateOverlay({ movedToCurrentDesktop: true, platform: "win32" }), false);
    assert.equal(shouldRecreateOverlay({ movedToCurrentDesktop: false, platform: "win32" }), true);
    assert.equal(shouldRecreateOverlay({ movedToCurrentDesktop: undefined, platform: "win32" }), true);
    assert.equal(shouldRecreateOverlay({ movedToCurrentDesktop: undefined, platform: "linux" }), false);
  });

  it("activateCaptureOverlay pede todesktop e showInactive; focus só se permitido", () => {
    const calls = [];
    const hwnd = Buffer.alloc(8);
    hwnd.writeBigUInt64LE(42n);
    const win = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => hwnd,
      setVisibleOnAllWorkspaces: () => calls.push("pin"),
      setFocusable: () => calls.push("focusable"),
      setIgnoreMouseEvents: () => calls.push("mouse"),
      showInactive: () => calls.push("showInactive"),
      setAlwaysOnTop: () => calls.push("topmost"),
      moveTop: () => calls.push("moveTop"),
      focus: () => calls.push("focus"),
    };
    const helper = [];
    const result = activateCaptureOverlay(win, {
      helperSend: (line) => helper.push(line),
      allowFocus: false,
    });
    assert.equal(result.hwnd, "42");
    assert.equal(helper[0], "todesktop 42");
    assert.ok(calls.indexOf("pin") < calls.indexOf("showInactive"));
    assert.ok(calls.includes("showInactive"));
    assert.ok(!calls.includes("focus"));

    calls.length = 0;
    activateCaptureOverlay(win, { hwnd: "42", helperSend: () => {}, allowFocus: true });
    assert.ok(calls.includes("focus"));
    assert.ok(calls.indexOf("showInactive") < calls.indexOf("focus"));
  });

  it("parkCaptureOverlay manda restorefg antes de setFocusable(false)", () => {
    const calls = [];
    parkCaptureOverlay({
      isDestroyed: () => false,
      setOpacity: () => calls.push("opacity"),
      setIgnoreMouseEvents: () => calls.push("mouse"),
      setAlwaysOnTop: () => calls.push("topmost"),
      setFocusable: (value) => calls.push(`focusable:${value}`),
      webContents: { send: (channel) => calls.push(`send:${channel}`) },
    }, { helperSend: (line) => calls.push(line) });
    assert.equal(calls[0], "restorefg");
    assert.ok(calls.indexOf("restorefg") < calls.indexOf("focusable:false"));
    assert.ok(calls.includes("send:screenshot-session"));
  });

  it("presentInactiveOnCurrentDesktop não chama show()/focus()", () => {
    const calls = [];
    presentInactiveOnCurrentDesktop({
      isDestroyed: () => false,
      getNativeWindowHandle: () => {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(8n);
        return buf;
      },
      setVisibleOnAllWorkspaces: () => calls.push("pin"),
      showInactive: () => calls.push("showInactive"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    }, { helperSend: (line) => calls.push(line) });
    assert.ok(calls.includes("todesktop 8"));
    assert.ok(calls.includes("showInactive"));
    assert.ok(!calls.includes("show"));
    assert.ok(!calls.includes("focus"));
  });

  it("pinToAllWorkspaces engole janela destruída", () => {
    assert.equal(pinToAllWorkspaces(null), false);
    assert.equal(pinToAllWorkspaces({ isDestroyed: () => true }), false);
    assert.equal(pinToAllWorkspaces({
      isDestroyed: () => false,
      setVisibleOnAllWorkspaces: () => {},
    }), true);
  });
});
