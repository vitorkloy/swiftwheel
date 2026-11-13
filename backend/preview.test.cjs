"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./preview-lib.cjs");
const nav = require("./preview-nav.cjs");

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
    const files = ["vor-preview.cs", "vor-preview-handler.cs"].map((name) =>
      fs.readFileSync(path.join(__dirname, "..", "native", name), "utf8"));
    const src = files.join("\n");
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
    assert.match(src, /AllowSetForegroundWindow/);
    assert.match(src, /OAIF_ALLOW_REGISTRATION/);
    assert.match(src, /OAIF_EXEC/);
    assert.match(src, /OpenAs_RunDLL/);
    assert.match(src, /NavCommand/);
    assert.match(src, /return "launch"/);
    assert.match(src, /return "next"/);
    assert.match(src, /return "prev"/);
    assert.match(src, /openwith/);
    assert.match(src, /openwith-done/);
    assert.match(src, /pinned/);
    assert.match(src, /IsHostForeground/);
    assert.match(src, /cmd == "preview"/);
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
    assert.match(src, /Console\.OutputEncoding = new UTF8Encoding\(false\)/);
    assert.match(src, /UTF8Encoding/);
    assert.match(src, /SetConsoleOutputCP\(65001\)/);
    assert.match(src, /SetConsoleCP\(65001\)/);
    assert.match(src, /WriteFile/);
    assert.match(src, /viewitem/);
    assert.match(src, /selecti/);
    assert.match(src, /fonte da verdade/);
    assert.match(src, /CanonicalExistingPath/);
    assert.match(src, /HammingCloseName/);
    assert.match(src, /ILCombine/);
    assert.match(src, /IPersistFolder2/);
    assert.match(src, /GetCurFolder/);
    assert.match(src, /SHCreateItemWithParent/);
    assert.match(src, /PathFromViewChild/);
    const handler = fs.readFileSync(path.join(__dirname, "..", "native", "vor-preview-handler.cs"), "utf8");
    assert.match(handler, /IPreviewHandler/);
    assert.match(handler, /IInitializeWithFile/);
    assert.match(handler, /IInitializeWithStream/);
    assert.match(handler, /IInitializeWithItem/);
    assert.match(handler, /SHCreateStreamOnFileEx/);
    assert.match(handler, /8895b1c6-b41f-4c1c-a562-0d564250836f/);
    assert.match(handler, /preview-fail/);
    assert.match(handler, /preview-ok/);
    assert.match(handler, /Unload/);
    assert.match(handler, /PREVIEW_TIMEOUT_MS/);
    assert.match(handler, /IsHostForeground/);
    assert.match(handler, /AllowTransparency = false/);
    assert.match(handler, /Color\.FromArgb\(255, 21, 21, 21\)/);
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    assert.match(main, /cmd === "view"/);
    assert.match(main, /cmd === "viewitem"/);
    assert.match(main, /resolveViewItems/);
    assert.match(main, /keepSiblings/);
    assert.match(main, /select \$\{/);
    assert.match(main, /stdin\.write\([^)]*"utf8"\)/);
    assert.match(main, /preview-ok/);
    assert.match(main, /hostrect/);
    assert.match(main, /fillOfficeSession/);
    assert.match(main, /preview-clear/);
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
    assert.match(main, /selectAfter/);
    assert.match(main, /shouldIgnoreSelect/);
    assert.match(main, /preview-nav/);
    assert.match(app, /key=\{session\.path\}/);
    assert.match(app, /key=\{session\.mediaUrl\}/);
    assert.match(app, /removeAttribute\('src'\)/);
    assert.match(app, /function MediaPane/);
  });
});

describe("preview nav state machine", () => {
  const files = [
    "C:\\\\dl\\\\QuickLook Installer.exe",
    "C:\\\\dl\\\\SICREDI_09_2026.pdf",
    "C:\\\\dl\\\\PLANILHA.xlsx",
    "C:\\\\dl\\\\Calendario.pdf",
  ];

  it("moves 5 times rapidly and only the last gen commits", () => {
    let state = nav.createNavState(files, 0);
    const gens = [];
    for (let i = 0; i < 5; i += 1) {
      const moved = nav.move(state, 1);
      assert.ok(moved.action);
      state = moved.state;
      gens.push(moved.action.gen);
    }
    assert.equal(state.index, 1);
    assert.equal(state.paths[state.index], files[1]);
    assert.equal(nav.acceptShow(state, files[0], gens[0]).accepted, false);
    assert.equal(nav.acceptShow(state, files[1], gens[1]).accepted, false);
    const last = nav.acceptShow(state, files[1], gens[4]);
    assert.equal(last.accepted, true);
    assert.equal(last.state.current, files[1]);
  });

  it("PDF→PDF and exe→pdf keep the preview as source of truth", () => {
    let pdfs = nav.createNavState(["a.pdf", "b.pdf"], 0);
    const pdfMove = nav.move(pdfs, 1);
    assert.equal(pdfMove.action.path, "b.pdf");
    assert.equal(pdfMove.action.select, "b.pdf");
    assert.equal(nav.acceptShow(pdfMove.state, "a.pdf", 0).accepted, false);
    assert.equal(nav.acceptShow(pdfMove.state, "b.pdf", pdfMove.action.gen).accepted, true);

    const mixed = nav.move(nav.createNavState(["QuickLook Installer.exe", "SICREDI_09_2026.pdf"], 0), 1);
    assert.equal(mixed.action.path, "SICREDI_09_2026.pdf");
    assert.equal(nav.shouldIgnoreSelect(mixed.state, "SICREDI_09_2026.pdf"), true);
    assert.equal(nav.shouldIgnoreSelect(mixed.state, "QuickLook Installer.exe"), false);
  });

  it("remaps viewitems that point at the wrong folder and drops missing files", () => {
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-dl-"));
    const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-desk-"));
    try {
      fs.writeFileSync(path.join(downloads, "Calendario.pdf"), "a");
      fs.writeFileSync(path.join(downloads, "QuickLook Installer.exe"), "b");
      fs.writeFileSync(path.join(downloads, "SICREDI_09_2026.pdf"), "c");
      const raw = [
        path.join(downloads, "Calendario.pdf"),
        path.join(desktop, "QuickLook Installer.exe"),
        path.join(desktop, "SICREDI_09_2026.pdf"),
        path.join(desktop, "ghost.bin"),
      ];
      const out = nav.resolveViewItems(raw, path.join(downloads, "Calendario.pdf"), 0);
      assert.equal(out.paths.length, 3);
      assert.equal(out.index, 0);
      assert.equal(out.paths[1], path.resolve(path.join(downloads, "QuickLook Installer.exe")));
      assert.equal(out.paths[2], path.resolve(path.join(downloads, "SICREDI_09_2026.pdf")));
      assert.equal(out.warnings.length, 3);
      assert.match(out.warnings[0], /viewitem inexistente \(corrigido\)/);
      assert.match(out.warnings[2], /viewitem inexistente: /);
      assert.doesNotMatch(out.warnings[2], /corrigido/);
    } finally {
      fs.rmSync(downloads, { recursive: true, force: true });
      fs.rmSync(desktop, { recursive: true, force: true });
    }
  });

  it("keeps valid viewitem paths and the helper index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-ok-"));
    try {
      const files = ["a.pdf", "b.pdf", "c.pdf"].map((name) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, name);
        return file;
      });
      const out = nav.resolveViewItems(files, files[1], 1);
      assert.deepEqual(out.paths, files.map((file) => path.resolve(file)));
      assert.equal(out.index, 1);
      assert.equal(out.warnings.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes preview.log only when SWIFTWHEEL debug is on", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-log-"));
    try {
      assert.equal(nav.debugLog("skip", { enabled: false, appData: dir }), null);
      const file = nav.debugLog("hello-nav", { enabled: true, appData: dir });
      assert.equal(file, path.join(dir, "SwiftWheel", "logs", "preview.log"));
      assert.match(fs.readFileSync(file, "utf8"), /hello-nav/);
      nav.debugLog("Calendário · CONCILIAÇÃO", { enabled: true, appData: dir });
      const body = fs.readFileSync(file);
      assert.equal(body.includes(Buffer.from("CONCILIAÇÃO", "utf8")), true);
      assert.equal(body.includes(Buffer.from([0xff, 0xfd])), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview helper encoding", () => {
  it("decodes UTF-8 helper lines and falls back from ACP bytes", () => {
    const utf8 = Buffer.from("open C:\\dl\\Calendário.pdf", "utf8");
    assert.equal(lib.decodeHelperLine(utf8), "open C:\\dl\\Calendário.pdf");
    const acp = Buffer.concat([
      Buffer.from("open C:\\dl\\Calend", "latin1"),
      Buffer.from([0xe1]),
      Buffer.from("rio.pdf", "latin1"),
    ]);
    const asUtf8 = acp.toString("utf8");
    assert.match(asUtf8, /\uFFFD/);
    assert.equal(lib.decodeHelperLine(acp), "open C:\\dl\\Calendário.pdf");
  });

  it("repairs UTF-8 read as latin1 (Ã§Ã£o) and keeps a valid UTF-8 ção", () => {
    const mojibake = Buffer.from("open Z:\\Cartilha_de_integraÃ§Ã£o.pptx", "utf8");
    assert.equal(lib.decodeHelperLine(mojibake), "open Z:\\Cartilha_de_integração.pptx");
    const good = Buffer.from("open Z:\\INTEGRAÇÃO.pptx", "utf8");
    assert.equal(lib.decodeHelperLine(good), "open Z:\\INTEGRAÇÃO.pptx");
    assert.equal(lib.repairUtf8Mojibake("Cartilha_de_integraÃ§Ã£o.pptx"), "Cartilha_de_integração.pptx");
    assert.equal(
      lib.matchDirName(["Cartilha_de_integração.pptx", "INTEGRAÇÃO.pptx"], "Cartilha_de_integrayýo.pptx"),
      "Cartilha_de_integração.pptx"
    );
  });

  it("uses the real directory entry for the display name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-name-"));
    try {
      const real = path.join(dir, "PLANILHA_CONTAS_PAGAS_-_CONCILIAÇÃO.xlsx");
      fs.writeFileSync(real, "x");
      assert.equal(lib.displayName(real), "PLANILHA_CONTAS_PAGAS_-_CONCILIAÇÃO.xlsx");
      assert.equal(lib.fileMeta(real).name, "PLANILHA_CONTAS_PAGAS_-_CONCILIAÇÃO.xlsx");
      assert.equal(lib.canonicalizePath(real), fs.realpathSync(real));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers Cartilha_de_integração from a yýo helper basename (UNC/share)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-preview-mojibake-"));
    try {
      const real = path.join(dir, "Cartilha_de_integração.pptx");
      fs.writeFileSync(real, "x");
      const garbled = path.join(dir, "Cartilha_de_integrayýo.pptx");
      assert.equal(lib.displayName(garbled), "Cartilha_de_integração.pptx");
      assert.equal(lib.canonicalizePath(garbled), path.resolve(real));
      assert.equal(lib.fileMeta(real).name, "Cartilha_de_integração.pptx");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    assert.match(main, /thickFrame:\s*false/);
    assert.match(main, /setHasShadow\(false\)/);
    assert.match(main, /open-with click/);
    assert.match(main, /decodeHelperLine/);
    assert.match(main, /canonicalizePath/);
    assert.match(main, /shell\.showItemInFolder/);
    assert.match(main, /action === "pin"/);
    assert.match(main, /action === "open-with"/);
    assert.match(main, /action === "reveal"/);
    assert.match(css, /\.pv-actions \*/);
    assert.match(css, /-webkit-app-region:\s*no-drag/);
    assert.match(css, /inset:\s*0/);
    assert.match(css, /box-shadow:\s*inset 0 0 0 1px/);
    assert.doesNotMatch(css, /inset:\s*16px/);
    assert.match(css, /\.pv-btn svg/);
    assert.match(css, /pointer-events:\s*none/);
    assert.match(app, /open-with/);
    assert.match(app, /onPointerDown/);
    assert.match(app, /press\("pin"\)/);
    assert.match(app, /press\("open-with"\)/);
    assert.match(app, /press\("reveal"\)/);
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
    assert.equal(lib.classifyKind("a.tsv"), "text");
  });

  it("maps office extensions to word/spreadsheet/presentation", () => {
    assert.equal(lib.classifyKind("a.docx"), "word");
    assert.equal(lib.classifyKind("a.DOC"), "word");
    assert.equal(lib.classifyKind("a.rtf"), "word");
    assert.equal(lib.classifyKind("a.odt"), "word");
    assert.equal(lib.classifyKind("a.xlsx"), "spreadsheet");
    assert.equal(lib.classifyKind("a.xls"), "spreadsheet");
    assert.equal(lib.classifyKind("a.csv"), "spreadsheet");
    assert.equal(lib.classifyKind("a.ods"), "spreadsheet");
    assert.equal(lib.classifyKind("a.pptx"), "presentation");
    assert.equal(lib.classifyKind("a.ppt"), "presentation");
    assert.equal(lib.classifyKind("a.odp"), "presentation");
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
