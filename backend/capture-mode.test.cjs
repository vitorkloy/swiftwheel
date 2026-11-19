"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCaptureMode,
  resolveStartMode,
  overlayMonitors,
  monitorAtPoint,
  modeBarPosition,
  windowAtPoint,
  physicalRectToOverlay,
  mapWindowsToOverlay,
  displayPhysicalBounds,
} = require("./capture-mode.cjs");

describe("capture-mode", () => {
  it("defaults to rectangular and accepts window/full", () => {
    assert.equal(normalizeCaptureMode(undefined), "region");
    assert.equal(normalizeCaptureMode("WINDOW"), "window");
    assert.equal(normalizeCaptureMode("full"), "full");
    assert.equal(normalizeCaptureMode("nope"), "region");
  });

  it("starts on an explicit shortcut mode, otherwise the last one", () => {
    assert.equal(resolveStartMode("window", "full"), "window");
    assert.equal(resolveStartMode(undefined, "full"), "full");
    assert.equal(resolveStartMode(null, null), "region");
  });

  it("places the bar at the top-center of the cursor monitor", () => {
    const displays = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: 0, width: 1600, height: 900 } },
    ];
    const monitors = overlayMonitors(displays, { x: 0, y: 0 });
    const right = monitorAtPoint(monitors, { x: 2000, y: 40 });
    assert.equal(right.x, 1920);
    assert.equal(right.width, 1600);
    const bar = modeBarPosition(right, 220, 40, 12);
    assert.equal(bar.x, 1920 + Math.round((1600 - 220) / 2));
    assert.equal(bar.y, 12);
    assert.ok(bar.x >= right.x && bar.x + bar.width <= right.x + right.width);
  });

  it("picks the topmost window under the cursor", () => {
    const windows = [
      { x: 100, y: 100, width: 400, height: 300 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ];
    const hit = windowAtPoint(windows, { x: 120, y: 120 });
    assert.equal(hit.width, 400);
    assert.equal(windowAtPoint(windows, { x: 10, y: 10 }).width, 1920);
    assert.equal(windowAtPoint(windows, { x: -1, y: 0 }), null);
  });

  it("maps physical window rects onto the overlay, including mixed DPI mosaics", () => {
    const virtPhys = { x: 0, y: 0, width: 4800, height: 1620 };
    const overlay = { width: 3840, height: 1080 };
    const mapped = physicalRectToOverlay({ x: 1920, y: 0, width: 2880, height: 1620 }, virtPhys, overlay);
    assert.equal(Math.round(mapped.x), 1536);
    assert.equal(Math.round(mapped.width), 2304);
    assert.equal(Math.round(mapped.height), 1080);
    const list = mapWindowsToOverlay([{ x: 0, y: 0, width: 1920, height: 1080 }], virtPhys, overlay);
    assert.equal(list.length, 1);
    assert.ok(list[0].width > 0 && list[0].height > 0);
  });

  it("converts DIP display bounds to physical with scale or dipToScreenRect", () => {
    const display = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.5 };
    const scaled = displayPhysicalBounds(display);
    assert.equal(scaled.width, 2880);
    assert.equal(scaled.height, 1620);
    const converted = displayPhysicalBounds(display, () => ({ x: 1920, y: 0, width: 2880, height: 1620 }));
    assert.equal(converted.width, 2880);
  });
});
