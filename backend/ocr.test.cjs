"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  normalizeOcrText,
  ocrOutcome,
  preferredOcrLanguages,
  pickOcrLanguage,
} = require("./ocr.cjs");

describe("ocr", () => {
  it("trims recognized text and reports empty vs copied", () => {
    assert.equal(normalizeOcrText("  ola\r\n  mundo  \n"), "ola\nmundo");
    const empty = ocrOutcome("   ", "pt");
    assert.equal(empty.ok, false);
    assert.equal(empty.empty, true);
    assert.equal(empty.toast, "Nenhum texto encontrado");
    const copied = ocrOutcome("SwiftWheel", "pt");
    assert.equal(copied.ok, true);
    assert.equal(copied.text, "SwiftWheel");
    assert.equal(copied.toast, "Texto copiado");
    assert.equal(ocrOutcome("hi", "en").toast, "Text copied");
    assert.equal(ocrOutcome("", "en").toast, "No text found");
  });

  it("prefers pt-BR then English, and the inverse when the UI is English", () => {
    assert.deepEqual(preferredOcrLanguages("pt").slice(0, 2), ["pt-BR", "pt"]);
    assert.equal(preferredOcrLanguages("en")[0], "en");
    assert.equal(pickOcrLanguage(["fr-FR", "pt-br", "en-US"], ["pt-BR", "en"]), "pt-br");
    assert.equal(pickOcrLanguage(["en-GB"], ["pt-BR", "en"]), "en-gb");
    assert.equal(pickOcrLanguage(["ja"], ["pt-BR", "en"]), "ja");
    assert.equal(pickOcrLanguage([], ["pt-BR"]), null);
  });

  it("uses Windows.Media.Ocr from a C# 4 helper with no extra package", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "native", "vor-ocr.cs"), "utf8");
    assert.match(src, /Windows\.Media\.Ocr/);
    assert.match(src, /TryCreateFromLanguage/);
    assert.match(src, /pt-BR/);
    assert.doesNotMatch(src, /\$"/);
    assert.doesNotMatch(src, /\?\./);
    assert.doesNotMatch(src, /\basync\b/);
    const capture = fs.readFileSync(path.join(__dirname, "..", "native", "vor-capture.cs"), "utf8");
    assert.match(capture, /wins-end/);
    assert.match(capture, /ListCaptureWindows/);
    assert.doesNotMatch(capture, /Clipboard\.SetImage/);
  });
});
