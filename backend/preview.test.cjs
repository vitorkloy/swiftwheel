"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./preview-lib.cjs");

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.concat([
      Buffer.from("PK\u0003\u0004"), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\u0001\u0002"), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    Buffer.from("PK\u0005\u0006"), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("native helper source", () => {
  it("stays on C# 4 syntax so Framework 4 csc can compile it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "native", "vor-preview.cs"), "utf8");
    assert.match(src, /bind <accel>/);
    assert.match(src, /IShellWindows|Shell\.Application/);
    assert.match(src, /GUI_CARETBLINKING/);
    assert.doesNotMatch(src, /\$"/);
    assert.doesNotMatch(src, /\?\./);
    assert.doesNotMatch(src, /\basync\b/);
  });

  it("handles Esc/arrows/Enter while armed and Open With via SHOpenWithDialog", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "native", "vor-preview.cs"), "utf8");
    assert.match(src, /SHOpenWithDialog/);
    assert.match(src, /NavCommand/);
    assert.match(src, /return "launch"/);
    assert.match(src, /return "next"/);
    assert.match(src, /return "prev"/);
    assert.match(src, /openwith/);
    assert.match(src, /openwith-done/);
    assert.match(src, /pinned/);
  });

  it("enumerates and selects Explorer view items over UTF-8 stdout", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "native", "vor-preview.cs"), "utf8");
    assert.match(src, /IFolderView/);
    assert.match(src, /SVGIO_ALLVIEW/);
    assert.match(src, /SVGIO_FLAG_VIEWORDER/);
    assert.match(src, /SVSI_SELECT/);
    assert.match(src, /SVSI_DESELECTOTHERS/);
    assert.match(src, /SVSI_ENSUREVISIBLE/);
    assert.match(src, /SVSI_FOCUSED/);
    assert.match(src, /Console\.OutputEncoding/);
    assert.match(src, /UTF8Encoding/);
    assert.match(src, /WriteFile/);
    assert.match(src, /viewitem/);
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    assert.match(main, /cmd === "view"/);
    assert.match(main, /cmd === "viewitem"/);
    assert.match(main, /keepSiblings/);
    assert.match(main, /select \$\{/);
    assert.match(main, /stdin\.write\([^)]*"utf8"\)/);
  });
});

describe("preview media reload", () => {
  it("cache-busts viewer URLs and remounts the renderer per path", () => {
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "PreviewApp.tsx"), "utf8");
    assert.match(main, /bumpMediaUrl/);
    assert.match(main, /mediaEpoch/);
    assert.match(main, /vor-preview:\/\/media\/current\?\$\{q\}/);
    assert.match(main, /status: 409/);
    assert.match(main, /queuedOpen \|\| seq !== openSeq/);
    assert.match(app, /key=\{session\.path\}/);
    assert.match(app, /key=\{session\.mediaUrl\}/);
    assert.match(app, /removeAttribute\('src'\)/);
    assert.match(app, /function MediaPane/);
  });
});

describe("preview toolbar wiring", () => {
  it("does not hide Open With and keeps toolbar buttons out of the drag region", () => {
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "preview.css"), "utf8");
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "PreviewApp.tsx"), "utf8");
    assert.match(main, /windowsHide:\s*false/);
    assert.match(main, /OpenAs_RunDLL/);
    assert.match(main, /openWithBusy/);
    assert.match(main, /shell\.showItemInFolder/);
    assert.match(main, /action === "pin"/);
    assert.match(main, /action === "open-with"/);
    assert.match(main, /action === "reveal"/);
    assert.match(css, /\.pv-actions \*/);
    assert.match(css, /-webkit-app-region:\s*no-drag/);
    assert.match(css, /\.pv-btn svg/);
    assert.match(css, /pointer-events:\s*none/);
    assert.match(app, /open-with/);
    assert.match(app, /run\('pin'\)/);
    assert.match(app, /run\('reveal'\)/);
    assert.match(app, /Abrir com/);
  });
});

describe("preview-lib navigation keys", () => {
  it("maps Esc/Space/Enter/arrows", () => {
    assert.equal(lib.previewNavCommand("Escape"), "close");
    assert.equal(lib.previewNavCommand(" "), "close");
    assert.equal(lib.previewNavCommand("Enter"), "launch");
    assert.equal(lib.previewNavCommand("ArrowRight"), "next");
    assert.equal(lib.previewNavCommand("ArrowLeft"), "prev");
    assert.equal(lib.previewNavCommand("a"), null);
  });
});

describe("preview-lib classifyKind", () => {
  it("maps phase-1 extensions", () => {
    assert.equal(lib.classifyKind("a.png"), "image");
    assert.equal(lib.classifyKind("a.JPG"), "image");
    assert.equal(lib.classifyKind("a.svg"), "svg");
    assert.equal(lib.classifyKind("a.mp4"), "video");
    assert.equal(lib.classifyKind("a.mp3"), "audio");
    assert.equal(lib.classifyKind("a.pdf"), "pdf");
    assert.equal(lib.classifyKind("a.md"), "markdown");
    assert.equal(lib.classifyKind("a.html"), "html");
    assert.equal(lib.classifyKind("a.zip"), "zip");
    assert.equal(lib.classifyKind("a.ts"), "text");
    assert.equal(lib.classifyKind("a.docx"), "fallback");
  });

  it("treats directories as folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-"));
    try {
      assert.equal(lib.classifyKind(dir, fs.statSync(dir)), "folder");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview-lib accelerator", () => {
  it("canonicalizes Space and modifiers in helper order", () => {
    assert.equal(lib.canonicalAccelerator("Space"), "space");
    assert.equal(lib.canonicalAccelerator("Ctrl+Space"), "commandorcontrol+space");
    assert.equal(lib.canonicalAccelerator("Shift+Alt+Space"), "alt+shift+space");
  });
});

describe("preview-lib markdown and sanitizers", () => {
  it("renders headings lists and code without raw HTML", () => {
    const html = lib.renderMarkdown("# Título\n\n- um\n\n```js\n<script>x</script>\n```\n\n[ok](https://example.com) [bad](javascript:alert(1))");
    assert.match(html, /<h1>/);
    assert.match(html, /<ul>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.doesNotMatch(html, /javascript:/);
    assert.doesNotMatch(html, /<script>/);
  });

  it("strips script handlers from HTML and SVG", () => {
    const html = lib.sanitizeHtmlDocument(`<p onclick="alert(1)">x</p><script>evil()</script><a href="javascript:1">a</a>`);
    assert.doesNotMatch(html, /onclick/i);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /javascript:/i);
    const svg = lib.sanitizeSvg(`<svg onload="alert(1)"><script>x</script><foreignObject></foreignObject><rect/></svg>`);
    assert.doesNotMatch(svg, /onload/i);
    assert.doesNotMatch(svg, /<script/i);
    assert.doesNotMatch(svg, /foreignObject/i);
  });
});

describe("preview-lib zip and folder", () => {
  it("lists stored zip entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-zip-"));
    const zipPath = path.join(dir, "sample.zip");
    fs.writeFileSync(zipPath, storedZip([
      { name: "readme.txt", data: "hello" },
      { name: "folder/", data: "" },
      { name: "folder/a.png", data: "xxxx" },
    ]));
    try {
      const listed = lib.listZipEntries(zipPath);
      const names = listed.entries.map((e) => e.name);
      assert.ok(names.includes("readme.txt"));
      assert.ok(names.includes("folder/"));
      assert.ok(names.includes("folder/a.png"));
      const readme = listed.entries.find((e) => e.name === "readme.txt");
      assert.equal(readme.size, 5);
      assert.equal(readme.isDir, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists folder items and siblings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-dir-"));
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.mkdirSync(path.join(dir, "sub"));
    try {
      const folder = lib.listFolder(dir);
      assert.equal(folder.files, 2);
      assert.equal(folder.folders, 1);
      assert.equal(folder.count, 3);
      const sib = lib.listSiblings(path.join(dir, "b.txt"));
      assert.ok(sib.paths.length >= 3);
      assert.ok(sib.index >= 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads text and rejects obvious binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-txt-"));
    const txt = path.join(dir, "n.txt");
    const bin = path.join(dir, "n.bin");
    fs.writeFileSync(txt, "olá mundo");
    fs.writeFileSync(bin, Buffer.from([0, 1, 2, 0, 0, 0, 0, 9, 0, 0]));
    try {
      const text = lib.readTextPreview(txt);
      assert.equal(text.binary, false);
      assert.match(text.text, /olá/);
      const asBin = lib.readTextPreview(bin);
      assert.equal(asBin.binary, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
