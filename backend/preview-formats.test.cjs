"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const lib = require("./preview-lib.cjs");
const fonts = require("./preview-font.cjs");
const archives = require("./preview-archive.cjs");
const heic = require("./preview-heic.cjs");

function u16be(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function utf16be(text) {
  const le = Buffer.from(String(text), "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function makeNameTable(family) {
  const payload = utf16be(family);
  const rec = Buffer.concat([
    u16be(3), u16be(1), u16be(0x0409), u16be(1), u16be(payload.length), u16be(0),
  ]);
  return Buffer.concat([u16be(0), u16be(1), u16be(6 + 12), rec, payload]);
}

function pad4(buf) {
  const n = (4 - (buf.length % 4)) % 4;
  return n ? Buffer.concat([buf, Buffer.alloc(n)]) : buf;
}

function makeSfnt(family) {
  const table = makeNameTable(family);
  const padded = pad4(table);
  const header = Buffer.concat([
    Buffer.from([0x00, 0x01, 0x00, 0x00]),
    u16be(1),
    u16be(16),
    u16be(0),
    u16be(0),
  ]);
  const record = Buffer.concat([
    Buffer.from("name"),
    u32be(0),
    u32be(header.length + 16),
    u32be(table.length),
  ]);
  return Buffer.concat([header, record, padded]);
}

function makeWoff(family, deflate) {
  const sfnt = makeSfnt(family);
  const table = makeNameTable(family);
  const raw = deflate ? zlib.deflateSync(table) : table;
  const header = Buffer.concat([
    Buffer.from("wOFF"),
    Buffer.from([0x00, 0x01, 0x00, 0x00]),
    u32be(44 + 20 + raw.length),
    u16be(1),
    u16be(0),
    u32be(sfnt.length),
    u16be(0),
    u16be(0),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0),
    u32be(0),
  ]);
  const rec = Buffer.concat([
    Buffer.from("name"),
    u32be(44 + 20),
    u32be(raw.length),
    u32be(table.length),
    u32be(0),
  ]);
  return Buffer.concat([header, rec, raw]);
}

function writeTemp(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-fmt-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { dir, file };
}

describe("preview-lib classifyKind phase 3", () => {
  it("maps fonts, packed archives and heic", () => {
    assert.equal(lib.classifyKind("a.ttf"), "font");
    assert.equal(lib.classifyKind("a.OTF"), "font");
    assert.equal(lib.classifyKind("a.woff"), "font");
    assert.equal(lib.classifyKind("a.woff2"), "font");
    assert.equal(lib.classifyKind("pacote.7z"), "zip");
    assert.equal(lib.classifyKind("pacote.RAR"), "zip");
    assert.equal(lib.classifyKind("foto.heic"), "heic");
    assert.equal(lib.classifyKind("foto.HEIF"), "heic");
    assert.equal(lib.classifyKind("pacote.zip"), "zip");
    assert.equal(lib.mimeFor("woff2"), "font/woff2");
    assert.equal(lib.mimeFor("heic"), "image/heic");
    assert.equal(lib.mimeFor("7z"), "application/x-7z-compressed");
  });
});

describe("preview font name table", () => {
  it("reads the family from ttf and woff", () => {
    const ttf = makeSfnt("SwiftWheel Teste");
    assert.equal(fonts.familyFromFontBuffer(ttf), "SwiftWheel Teste");
    const woff = makeWoff("Família WOFF", false);
    assert.equal(fonts.familyFromFontBuffer(woff), "Família WOFF");
    const packed = makeWoff("Woff Deflate", true);
    assert.equal(fonts.familyFromFontBuffer(packed), "Woff Deflate");
    assert.equal(fonts.familyFromFontBuffer(Buffer.from("wOF2xxxx")), "");
  });

  it("falls back to the filename and flags oversized files", () => {
    const { dir, file } = writeTemp("MinhaFonte.ttf", makeSfnt("Nome Real"));
    try {
      assert.equal(fonts.parseFontFamily(file).family, "Nome Real");
      assert.equal(fonts.parseFontFamily(file, fonts.MAX_FONT_BYTES + 1).tooLarge, true);
      assert.equal(fonts.parseFontFamily(file, fonts.MAX_FONT_BYTES + 1).family, "MinhaFonte");
      assert.match(fonts.messageFor("tooLarge", "pt"), /grande demais/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview 7z/rar listing", () => {
  it("lists 7z entries without writing extracted files", async () => {
    const fixture = path.join(__dirname, "fixtures", "preview", "sample.7z");
    const listed = await archives.listPackedArchive(fixture);
    const names = listed.entries.map((e) => e.name);
    assert.ok(names.includes("example/"));
    assert.ok(names.includes("example/README.md"));
    const readme = listed.entries.find((e) => e.name === "example/README.md");
    assert.equal(readme.size, 144);
    assert.equal(readme.isDir, false);
    assert.equal(listed.truncated, false);
    assert.equal(listed.error, undefined);
  });

  it("lists rar entries with name size and folder", async () => {
    const fixture = path.join(__dirname, "fixtures", "preview", "sample-v4.rar");
    const listed = await archives.listPackedArchive(fixture);
    const names = listed.entries.map((e) => e.name);
    assert.ok(names.includes("example/README.md"));
    const folder = listed.entries.find((e) => e.isDir);
    assert.ok(folder, "esperava uma pasta");
    const readme = listed.entries.find((e) => e.name === "example/README.md");
    assert.equal(readme.size, 144);
  });

  it("rejects archives over the size cap", async () => {
    const fixture = path.join(__dirname, "fixtures", "preview", "sample.7z");
    const listed = await archives.listPackedArchive(fixture, archives.MAX_ARCHIVE_BYTES + 1);
    assert.equal(listed.error, "tooLarge");
    assert.equal(listed.entries.length, 0);
    assert.match(archives.messageFor("tooLarge", "pt"), /grande demais/);
  });
});

describe("preview heic conversion", () => {
  it("refuses oversized files and invalid payloads", async () => {
    const { dir, file } = writeTemp("foto.heic", Buffer.from("not-a-heic"));
    try {
      const big = await heic.convertHeicPreview(file, heic.MAX_HEIC_BYTES + 1);
      assert.equal(big.ok, false);
      assert.equal(big.reason, "tooLarge");
      const bad = await heic.convertHeicPreview(file);
      assert.equal(bad.ok, false);
      assert.equal(bad.reason, "error");
      assert.match(heic.messageFor("tooLarge", "pt"), /grande demais/);
      assert.match(heic.messageFor("error", "pt"), /Não foi possível/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview phase-3 wiring", () => {
  it("serves fonts and converted heic, lists packed archives, uses FontFace", () => {
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "PreviewApp.tsx"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "preview.css"), "utf8");
    const archiveSrc = fs.readFileSync(path.join(__dirname, "preview-archive.cjs"), "utf8");
    const heicSrc = fs.readFileSync(path.join(__dirname, "preview-heic.cjs"), "utf8");
    assert.match(main, /vor-preview:\/\/blob\/current/);
    assert.match(main, /fillHeicSession/);
    assert.match(main, /listPackedArchive/);
    assert.match(main, /parseFontFamily/);
    assert.match(main, /kind === "font"/);
    assert.match(app, /new FontFace/);
    assert.match(app, /function FontPane/);
    assert.match(app, /A rápida raposa marrom/);
    assert.match(app, /FONT_SIZES = \[12, 18, 24, 36, 48, 72\]/);
    assert.match(app, /session\.kind === 'heic'/);
    assert.match(app, /session\.zip\.error/);
    assert.match(css, /\.pv-font/);
    assert.match(css, /background: var\(--pv-solid\)/);
    assert.match(archiveSrc, /libarchive-wasm/);
    assert.match(archiveSrc, /skipData|entries\(\)/);
    assert.doesNotMatch(archiveSrc, /writeFileSync|os\.tmpdir/);
    assert.match(heicSrc, /heic-convert/);
    assert.match(heicSrc, /MAX_HEIC_BYTES/);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert.match(pkg.scripts["test:preview"], /preview-formats\.test\.cjs/);
    assert.ok((pkg.build.asarUnpack || []).some((item) => String(item).includes("libarchive-wasm")));
    assert.ok((pkg.build.asarUnpack || []).some((item) => String(item).includes("libheif-js")));
  });
});
