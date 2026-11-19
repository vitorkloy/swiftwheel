"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  fileWheelVisualRadiusPx,
  clampCenterToWorkArea,
  clampHoldMs,
  clampScale,
} = require("./file-wheel-geometry.cjs");

describe("file-wheel-geometry", () => {
  it("keeps the wheel radius inside a typical 1080p work area", () => {
    const radius = fileWheelVisualRadiusPx(1);
    assert.ok(radius >= 100 && radius <= 180);
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const clamped = clampCenterToWorkArea({ x: 960, y: 1030 }, area, radius);
    assert.equal(clamped.x, 960);
    assert.equal(clamped.y, area.height - radius);
    assert.ok(clamped.y - radius >= area.y);
    assert.ok(clamped.y + radius <= area.y + area.height);
  });

  it("clamps a drag near the bottom-left corner of the current monitor", () => {
    const area = { x: 1920, y: 0, width: 1600, height: 900 };
    const radius = 132;
    const clamped = clampCenterToWorkArea({ x: 1925, y: 890 }, area, radius);
    assert.equal(clamped.x, area.x + radius);
    assert.equal(clamped.y, area.y + area.height - radius);
  });

  it("does not overflow a tiny work area", () => {
    const area = { x: 0, y: 0, width: 200, height: 160 };
    const clamped = clampCenterToWorkArea({ x: 10, y: 10 }, area, 400);
    assert.equal(clamped.x, 80);
    assert.equal(clamped.y, 80);
    assert.ok(clamped.x - 80 >= area.x);
    assert.ok(clamped.y - 80 >= area.y);
    assert.ok(clamped.x + 80 <= area.x + area.width);
    assert.ok(clamped.y + 80 <= area.y + area.height);
  });

  it("normalizes hold delay and scale", () => {
    assert.equal(clampHoldMs(undefined), 300);
    assert.equal(clampHoldMs(40), 80);
    assert.equal(clampHoldMs(9000), 1500);
    assert.equal(clampHoldMs(300), 300);
    assert.equal(clampScale(0.2), 0.7);
    assert.equal(clampScale(2), 1.4);
    assert.equal(clampScale(1), 1);
  });
});
