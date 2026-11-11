"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const XLSX = require("xlsx");
const lib = require("./preview-lib.cjs");
const office = require("./preview-office.cjs");

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
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const data = file.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = file.deflate ? 8 : 0;
    const crc = crc32(raw);
    const flags = file.encrypted ? 1 : 0;
    const local = Buffer.concat([
      Buffer.from("PK\u0003\u0004"), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(raw.length), u16(name.length), u16(0),
      name, data,
    ]);
    const central = Buffer.concat([
      Buffer.from("PK\u0001\u0002"), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(raw.length), u16(name.length), u16(0), u16(0),
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

function writeTemp(name, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-office-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return { dir, file };
}

function minimalDocx(text) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  return storedZip([
    { name: "[Content_Types].xml", data: types, deflate: true },
    { name: "_rels/.rels", data: rels, deflate: true },
    { name: "word/document.xml", data: document, deflate: true },
    { name: "word/_rels/document.xml.rels", data: docRels, deflate: true },
  ]);
}

describe("office routing", () => {
  it("keeps phase-1 kinds unchanged and routes office by extension", () => {
    assert.equal(lib.classifyKind("foto.png"), "image");
    assert.equal(lib.classifyKind("clipe.mp4"), "video");
    assert.equal(lib.classifyKind("som.mp3"), "audio");
    assert.equal(lib.classifyKind("nota.pdf"), "pdf");
    assert.equal(lib.classifyKind("leiame.md"), "markdown");
    assert.equal(lib.classifyKind("pagina.html"), "html");
    assert.equal(lib.classifyKind("pacote.zip"), "zip");
    assert.equal(lib.classifyKind("codigo.ts"), "text");
    assert.equal(lib.classifyKind("contrato.docx"), "word");
    assert.equal(lib.classifyKind("planilha.xlsx"), "spreadsheet");
    assert.equal(lib.classifyKind("dados.csv"), "spreadsheet");
    assert.equal(lib.classifyKind("slides.pptx"), "presentation");
    assert.equal(office.isOfficeKind("word"), true);
    assert.equal(office.isOfficeKind("image"), false);
  });
});

describe("office guards", () => {
  it("blocks oversized files and still allows native below the native cap", () => {
    const { dir, file } = writeTemp("huge.docx", minimalDocx("x"));
    try {
      const nativeCap = office.detectOfficeGuard(file, office.MAX_OFFICE_NATIVE_BYTES + 1);
      assert.equal(nativeCap.reason, "too-large");
      assert.equal(nativeCap.allowNative, false);
      assert.equal(nativeCap.allowJs, false);
      assert.match(nativeCap.message, /grande demais/);
      const jsCap = office.detectOfficeGuard(file, office.MAX_OFFICE_JS_BYTES + 1);
      assert.equal(jsCap.reason, "too-large");
      assert.equal(jsCap.allowNative, true);
      assert.equal(jsCap.allowJs, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects password-protected OOXML (OLE EncryptedPackage) and zip flags", () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
      Buffer.from("EncryptedPackage", "utf16le"),
    ]);
    const { dir, file } = writeTemp("secret.docx", ole);
    try {
      const guard = office.detectOfficeGuard(file, ole.length);
      assert.equal(guard.reason, "password");
      assert.equal(guard.allowJs, false);
      assert.equal(guard.allowNative, false);
      assert.match(guard.message, /senha/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-office-zip-"));
    const zipPath = path.join(zipDir, "locked.xlsx");
    fs.writeFileSync(zipPath, storedZip([
      { name: "EncryptedPackage", data: "x", encrypted: true },
      { name: "EncryptionInfo", data: "y" },
    ]));
    try {
      assert.equal(office.zipLooksEncrypted(zipPath), true);
      const guard = office.detectOfficeGuard(zipPath, fs.statSync(zipPath).size);
      assert.equal(guard.reason, "password");
    } finally {
      fs.rmSync(zipDir, { recursive: true, force: true });
    }
  });
});

describe("office JS fallbacks", () => {
  it("renders docx via mammoth", async () => {
    const { dir, file } = writeTemp("ola.docx", minimalDocx("Olá Word"));
    try {
      const out = await office.renderOfficeJs(file, "word", "docx");
      assert.equal(out.ok, true);
      assert.match(out.office.html, /Olá Word|Olá/);
      assert.doesNotMatch(out.office.html, /<script/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders xlsx with multiple sheets and csv as spreadsheet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-office-xlsx-"));
    try {
      const xlsxPath = path.join(dir, "livro.xlsx");
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Nome", "Valor"], ["Ana", 10], ["Bia", 20]]), "Dados");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["OK"], ["Sim"]]), "Resumo");
      XLSX.writeFile(wb, xlsxPath);
      const out = await office.renderOfficeJs(xlsxPath, "spreadsheet", "xlsx");
      assert.equal(out.ok, true);
      assert.equal(out.office.sheets.length, 2);
      assert.equal(out.office.sheets[0].name, "Dados");
      assert.equal(out.office.sheets[1].name, "Resumo");
      assert.match(out.office.sheets[0].html, /<table>/);
      assert.match(out.office.sheets[0].html, /Ana/);
      assert.doesNotMatch(out.office.sheets[0].html, /<script/i);

      const csvPath = path.join(dir, "dados.csv");
      fs.writeFileSync(csvPath, "colA,colB\n1,2\n3,4\n");
      const csv = await office.renderOfficeJs(csvPath, "spreadsheet", "csv");
      assert.equal(csv.ok, true);
      assert.ok(csv.office.sheets.length >= 1);
      assert.match(csv.office.sheets[0].html, /colA/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts pptx slide text and odt/odp/rtf fallbacks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-office-ppt-"));
    try {
      const pptx = path.join(dir, "deck.pptx");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
      const withImage = storedZip([
        { name: "[Content_Types].xml", data: "<Types></Types>", deflate: true },
        { name: "ppt/presentation.xml", data: "<p:presentation/>", deflate: true },
        { name: "ppt/slides/slide1.xml", data: "<p:sld><a:t>Primeiro slide</a:t></p:sld>", deflate: true },
        { name: "ppt/slides/slide2.xml", data: "<p:sld><a:t>Segundo slide</a:t></p:sld>", deflate: true },
        { name: "ppt/slides/_rels/slide1.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`, deflate: true },
        { name: "ppt/slides/_rels/slide2.xml.rels", data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`, deflate: true },
        { name: "ppt/media/image1.png", data: png },
      ]);
      fs.writeFileSync(pptx, withImage);
      const slides = await office.renderOfficeJs(pptx, "presentation", "pptx");
      assert.equal(slides.ok, true);
      assert.equal(slides.office.slides.length, 2);
      assert.match(slides.office.slides[0].html, /Primeiro slide/);
      assert.match(slides.office.slides[1].html, /Segundo slide/);
      assert.match(slides.office.slides[0].html, /data:image\/png;base64,/);

      const odt = path.join(dir, "nota.odt");
      fs.writeFileSync(odt, storedZip([{
        name: "content.xml",
        deflate: true,
        data: `<?xml version="1.0"?><office:document-content xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>Olá ODT</text:p></office:document-content>`,
      }]));
      const odtOut = await office.renderOfficeJs(odt, "word", "odt");
      assert.equal(odtOut.ok, true);
      assert.match(odtOut.office.html, /Olá ODT/);

      const odp = path.join(dir, "deck.odp");
      fs.writeFileSync(odp, storedZip([{
        name: "content.xml",
        deflate: true,
        data: `<?xml version="1.0"?><office:document-content xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><draw:page><text:p>Slide ODP</text:p></draw:page></office:document-content>`,
      }]));
      const odpOut = await office.renderOfficeJs(odp, "presentation", "odp");
      assert.equal(odpOut.ok, true);
      assert.match(odpOut.office.slides[0].html, /Slide ODP/);

      const rtf = path.join(dir, "nota.rtf");
      fs.writeFileSync(rtf, "{\\rtf1\\ansi Olá\\par mundo}");
      const rtfOut = await office.renderOfficeJs(rtf, "word", "rtf");
      assert.equal(rtfOut.ok, true);
      assert.match(rtfOut.office.html, /Olá/);
      assert.match(office.rtfToText("{\\rtf1\\ansi Hi\\par there}"), /Hi/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clear info card for unsupported binary Office (.doc/.ppt)", async () => {
    const ole = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from("not-encrypted-ole-doc"),
    ]);
    const { dir, file } = writeTemp("legado.doc", ole);
    try {
      const out = await office.renderOfficeJs(file, "word", "doc");
      assert.equal(out.ok, false);
      assert.equal(out.office.reason, "unsupported");
      assert.match(out.office.message, /prévia/i);
      const ppt = await office.renderOfficeJs(file, "presentation", "ppt");
      assert.equal(ppt.ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("office UI and helper wiring", () => {
  it("keeps Portuguese copy and native overlay protocol", () => {
    const app = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "PreviewApp.tsx"), "utf8");
    const css = fs.readFileSync(path.join(__dirname, "..", "src", "preview", "preview.css"), "utf8");
    const main = fs.readFileSync(path.join(__dirname, "preview.cjs"), "utf8");
    const build = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-preview-helper.cjs"), "utf8");
    assert.match(app, /spreadsheet/);
    assert.match(app, /presentation/);
    assert.match(app, /pv-sheet-tabs/);
    assert.match(app, /A carregar prévia/);
    assert.match(app, /Prévia nativa do Windows/);
    assert.match(app, /Prévia parcial/);
    assert.match(css, /\.pv-sheet-tabs/);
    assert.match(css, /\.pv-slides/);
    assert.match(css, /\.pv-native/);
    assert.match(main, /nativeEngine/);
    assert.match(main, /tryNativePreview/);
    assert.match(main, /cmd === "preview-fail"/);
    assert.match(build, /vor-preview-handler\.cs/);
  });
});
