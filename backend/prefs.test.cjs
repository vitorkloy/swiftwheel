"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const prefs = require("./prefs.cjs");

describe("prefs", () => {
  it("liga tudo por omissão, menos o início de conversão", () => {
    const n = prefs.normalizeNotifications(undefined);
    assert.equal(n.master, true);
    assert.equal(n.captureCopied, true);
    assert.equal(n.fileConverted, true);
    assert.equal(n.fileConvertError, true);
    assert.equal(n.fileConvertStart, false);
    assert.equal(prefs.allowsNotification(undefined, "captureCopied"), true);
    assert.equal(prefs.allowsNotification(undefined, "fileConvertStart"), false);
  });

  it("o interruptor mestre silencia qualquer tipo", () => {
    assert.equal(prefs.allowsNotification({ master: false, captureCopied: true }, "captureCopied"), false);
    assert.equal(prefs.allowsSound({ master: false, wheelOpen: true }, "wheelOpen"), false);
  });

  it("respeita o toggle individual", () => {
    assert.equal(prefs.allowsNotification({ captureSaved: false }, "captureSaved"), false);
    assert.equal(prefs.allowsNotification({ captureSaved: false }, "captureCopied"), true);
    assert.equal(prefs.allowsSound({ convertDone: false }, "convertDone"), false);
    assert.equal(prefs.allowsSound({ convertDone: false }, "wheelOpen"), true);
  });

  it("herda captura/prévia desligadas do settings antigo", () => {
    const modules = prefs.normalizeModules({}, { enabled: false }, { enabled: false });
    assert.equal(modules.capture, false);
    assert.equal(modules.preview, false);
    assert.equal(modules.radial, true);
    assert.equal(modules.shiftdrop, true);
    assert.equal(modules.dock, false);
  });

  it("moduleOn trata ausência como ligado", () => {
    assert.equal(prefs.moduleOn(undefined, "shiftdrop"), true);
    assert.equal(prefs.moduleOn({ shiftdrop: false }, "shiftdrop"), false);
  });
});
