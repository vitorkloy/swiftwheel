"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  hasProfile,
  migrateUserDataIfNeeded,
  USER_DATA_DIRNAME,
} = require("./user-data-migrate.cjs");

let tmp;

function write(file, content = "{}") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swiftwheel-migrate-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("hasProfile", () => {
  it("rejects missing and Chromium-only folders", () => {
    assert.equal(hasProfile(path.join(tmp, "missing")), false);
    const empty = path.join(tmp, "empty");
    fs.mkdirSync(empty);
    write(path.join(empty, "GPUCache", "data_0"), "x");
    write(path.join(empty, "Code Cache", "js", "index"), "x");
    assert.equal(hasProfile(empty), false);
  });

  it("accepts config-v2, settings and custom-icons", () => {
    const a = path.join(tmp, "a");
    write(path.join(a, "config-v2.json"), '{"config":{}}');
    assert.equal(hasProfile(a), true);
    const b = path.join(tmp, "b");
    write(path.join(b, "settings.json"), "{}");
    assert.equal(hasProfile(b), true);
    const c = path.join(tmp, "c");
    fs.mkdirSync(path.join(c, "custom-icons"), { recursive: true });
    assert.equal(hasProfile(c), true);
  });
});

describe("migrateUserDataIfNeeded", () => {
  it("creates an empty SwiftWheel folder when nothing to migrate", () => {
    const result = migrateUserDataIfNeeded(tmp);
    assert.equal(result.userDataDir, path.join(tmp, USER_DATA_DIRNAME));
    assert.equal(result.migratedFrom, null);
    assert.deepEqual(result.copied, []);
    assert.equal(fs.existsSync(result.userDataDir), true);
  });

  it("copies VOR prefs, workspaces, wheels extras and nested icons; keeps the source", () => {
    const vor = path.join(tmp, "VOR");
    write(vor + "/config-v2.json", '{"config":{"workspaces":[{"id":"w1"}]}}');
    write(vor + "/config-v2.json.bak", "{}");
    write(vor + "/settings.json", '{"openAtLogin":true}');
    write(vor + "/license-device.json", '{"deviceId":"abc"}');
    write(vor + "/icon-cache.json", "{}");
    write(vor + "/custom-icons/logo.png", "png");
    write(vor + "/.env.local", "X=1");
    write(vor + "/GPUCache/data_0", "cache-should-skip");
    write(vor + "/Code Cache/js/index", "cache-should-skip");

    const result = migrateUserDataIfNeeded(tmp);
    const dest = path.join(tmp, "SwiftWheel");
    assert.equal(result.migratedFrom, vor);
    assert.equal(result.userDataDir, dest);
    assert.equal(fs.readFileSync(path.join(dest, "config-v2.json"), "utf8"), '{"config":{"workspaces":[{"id":"w1"}]}}');
    assert.equal(fs.readFileSync(path.join(dest, "settings.json"), "utf8"), '{"openAtLogin":true}');
    assert.equal(fs.existsSync(path.join(dest, "custom-icons", "logo.png")), true);
    assert.equal(fs.existsSync(path.join(dest, ".env.local")), true);
    assert.equal(fs.existsSync(path.join(dest, "GPUCache", "data_0")), false);
    assert.equal(fs.existsSync(path.join(vor, "config-v2.json")), true);
    assert.equal(fs.existsSync(path.join(vor, "custom-icons", "logo.png")), true);
  });

  it("is a no-op when SwiftWheel already has a profile", () => {
    write(path.join(tmp, "VOR", "config-v2.json"), '{"from":"vor"}');
    write(path.join(tmp, "SwiftWheel", "config-v2.json"), '{"from":"swift"}');
    const result = migrateUserDataIfNeeded(tmp);
    assert.equal(result.skipped, true);
    assert.equal(result.migratedFrom, null);
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "config-v2.json"), "utf8"), '{"from":"swift"}');
  });

  it("migrates onto a Chromium-only SwiftWheel folder without overwriting later files", () => {
    write(path.join(tmp, "VOR", "config-v2.json"), '{"from":"vor"}');
    write(path.join(tmp, "VOR", "settings.json"), '{"a":1}');
    write(path.join(tmp, "SwiftWheel", "GPUCache", "x"), "cache");
    const first = migrateUserDataIfNeeded(tmp);
    assert.equal(first.migratedFrom, path.join(tmp, "VOR"));
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "config-v2.json"), "utf8"), '{"from":"vor"}');

    fs.writeFileSync(path.join(tmp, "VOR", "config-v2.json"), '{"from":"vor-newer"}');
    fs.writeFileSync(path.join(tmp, "SwiftWheel", "settings.json"), '{"a":"kept"}');
    const second = migrateUserDataIfNeeded(tmp);
    assert.equal(second.skipped, true);
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "config-v2.json"), "utf8"), '{"from":"vor"}');
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "settings.json"), "utf8"), '{"a":"kept"}');
  });

  it("prefers VOR over Zenith when both exist", () => {
    write(path.join(tmp, "VOR", "config-v2.json"), '{"from":"vor"}');
    write(path.join(tmp, "Zenith OS", "config-v2.json"), '{"from":"zenith"}');
    const result = migrateUserDataIfNeeded(tmp);
    assert.equal(result.migratedFrom, path.join(tmp, "VOR"));
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "config-v2.json"), "utf8"), '{"from":"vor"}');
  });

  it("falls back to Zenith when VOR has no profile", () => {
    write(path.join(tmp, "Zenith OS", "settings.json"), '{"from":"zenith"}');
    const result = migrateUserDataIfNeeded(tmp);
    assert.equal(result.migratedFrom, path.join(tmp, "Zenith OS"));
    assert.equal(fs.readFileSync(path.join(tmp, "SwiftWheel", "settings.json"), "utf8"), '{"from":"zenith"}');
  });

  it("second call after a successful migrate is idempotent and does not delete the old folder", () => {
    write(path.join(tmp, "VOR", "config-v2.json"), '{"ok":true}');
    write(path.join(tmp, "VOR", "custom-icons", "a.png"), "a");
    migrateUserDataIfNeeded(tmp);
    const again = migrateUserDataIfNeeded(tmp);
    assert.equal(again.skipped, true);
    assert.deepEqual(again.copied, []);
    assert.equal(fs.existsSync(path.join(tmp, "VOR", "config-v2.json")), true);
    assert.equal(fs.existsSync(path.join(tmp, "VOR", "custom-icons", "a.png")), true);
  });
});
