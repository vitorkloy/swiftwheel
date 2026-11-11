"use strict";

/**
 * Prévia de Office: deteção (senha / tamanho) e fallback JS.
 * Word: mammoth (docx) + XML (odt) + RTF; Excel: SheetJS; PowerPoint: ZIP/XML.
 * Sem LibreOffice. O handler nativo do Windows fica no helper C#.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const lib = require("./preview-lib.cjs");

const MAX_OFFICE_JS_BYTES = 25 * 1024 * 1024;
const MAX_OFFICE_NATIVE_BYTES = 80 * 1024 * 1024;
const MAX_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_ROWS = 400;
const MAX_COLS = 32;
const MAX_SHEETS = 16;
const MAX_SLIDES = 40;
const MAX_SLIDE_IMAGES = 6;
const MAX_IMAGE_BYTES = 800 * 1024;

const MESSAGES = {
  pt: {
    password: "Este arquivo está protegido por senha. Abra-o no aplicativo para desbloquear.",
    tooLarge: "Arquivo grande demais para prévia. Abra-o no aplicativo.",
    unsupported: "Não foi possível gerar a prévia deste formato.",
    error: "Falha ao gerar a prévia.",
    native: "Prévia nativa do Windows",
    pending: "A carregar prévia…",
    truncated: "Prévia parcial",
  },
  en: {
    password: "This file is password-protected. Open it in the app to unlock.",
    tooLarge: "File is too large to preview. Open it in the app.",
    unsupported: "Could not generate a preview for this format.",
    error: "Failed to generate the preview.",
    native: "Windows native preview",
    pending: "Loading preview…",
    truncated: "Partial preview",
  },
};

function isOfficeKind(kind) {
  return kind === "word" || kind === "spreadsheet" || kind === "presentation";
}

function messageFor(reason, lang) {
  const pack = lang === "en" ? MESSAGES.en : MESSAGES.pt;
  return pack[reason] || pack.error;
}

function sniffMagic(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    if (n >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
    if (n >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return "ole";
    const head = buf.toString("ascii", 0, Math.min(n, 5));
    if (head === "{\\rtf") return "rtf";
    return "unknown";
  } finally {
    fs.closeSync(fd);
  }
}

function oleLooksEncrypted(filePath) {
  const st = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const n = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return buf.includes(Buffer.from("EncryptedPackage", "utf16le"))
      || buf.includes(Buffer.from("EncryptionInfo", "utf16le"));
  } finally {
    fs.closeSync(fd);
  }
}

function readZipCentral(filePath) {
  const st = fs.statSync(filePath);
  if (st.size < 22) return { names: [], encrypted: false, records: [], error: "short" };
  const fd = fs.openSync(filePath, "r");
  try {
    const tailLen = Math.min(st.size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { names: [], encrypted: false, records: [], error: "eocd" };
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset >= st.size || cdSize > st.size) return { names: [], encrypted: false, records: [], error: "zip64" };
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const records = [];
    const names = [];
    let encrypted = false;
    let offset = 0;
    let seen = 0;
    while (offset + 46 <= cd.length && seen < total) {
      if (cd[offset] !== 0x50 || cd[offset + 1] !== 0x4b || cd[offset + 2] !== 0x01 || cd[offset + 3] !== 0x02) break;
      const flags = cd.readUInt16LE(offset + 8);
      const method = cd.readUInt16LE(offset + 10);
      const compressed = cd.readUInt32LE(offset + 20);
      const uncompressed = cd.readUInt32LE(offset + 24);
      const nameLen = cd.readUInt16LE(offset + 28);
      const extraLen = cd.readUInt16LE(offset + 30);
      const commentLen = cd.readUInt16LE(offset + 32);
      const localOffset = cd.readUInt32LE(offset + 42);
      const name = cd.toString("utf8", offset + 46, offset + 46 + nameLen);
      if (flags & 1) encrypted = true;
      names.push(name);
      records.push({ name, flags, method, compressed, uncompressed, localOffset });
      offset += 46 + nameLen + extraLen + commentLen;
      seen += 1;
    }
    return { names, encrypted, records };
  } catch (err) {
    return { names: [], encrypted: false, records: [], error: err.message };
  } finally {
    fs.closeSync(fd);
  }
}

function extractZip(filePath, { want, maxUncompressed = MAX_UNCOMPRESSED } = {}) {
  const central = readZipCentral(filePath);
  if (central.error) return { files: {}, encrypted: !!central.encrypted, error: central.error };
  const fd = fs.openSync(filePath, "r");
  const files = {};
  let used = 0;
  try {
    for (const rec of central.records) {
      if (want && !want(rec.name)) continue;
      if (rec.flags & 1) continue;
      if (rec.uncompressed > maxUncompressed) continue;
      if (used + rec.uncompressed > maxUncompressed) break;
      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, rec.localOffset);
      if (local[0] !== 0x50 || local[1] !== 0x4b) continue;
      const nameLen = local.readUInt16LE(26);
      const extraLen = local.readUInt16LE(28);
      const dataOff = rec.localOffset + 30 + nameLen + extraLen;
      const payload = Buffer.alloc(rec.compressed);
      fs.readSync(fd, payload, 0, rec.compressed, dataOff);
      let raw;
      if (rec.method === 0) raw = payload;
      else if (rec.method === 8) {
        try { raw = zlib.inflateRawSync(payload); }
        catch { continue; }
      } else continue;
      files[rec.name.replace(/\\/g, "/")] = raw;
      used += rec.uncompressed;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files, encrypted: central.encrypted, names: central.names };
}

function zipLooksEncrypted(filePath) {
  const central = readZipCentral(filePath);
  if (central.encrypted) return true;
  return (central.names || []).some((n) => /encryptedpackage/i.test(n) || /encryptioninfo/i.test(n));
}

function detectOfficeGuard(filePath, size, stat) {
  const bytes = size == null ? (stat ? stat.size : fs.statSync(filePath).size) : size;
  if (bytes > MAX_OFFICE_NATIVE_BYTES) {
    return {
      reason: "too-large",
      allowNative: false,
      allowJs: false,
      message: MESSAGES.pt.tooLarge,
    };
  }
  let magic = "unknown";
  try { magic = sniffMagic(filePath); } catch { /* ignore */ }
  let password = false;
  try {
    if (magic === "ole") password = oleLooksEncrypted(filePath);
    else if (magic === "zip") password = zipLooksEncrypted(filePath);
  } catch { /* ignore */ }
  if (password) {
    return {
      reason: "password",
      allowNative: false,
      allowJs: false,
      message: MESSAGES.pt.password,
    };
  }
  if (bytes > MAX_OFFICE_JS_BYTES) {
    return {
      reason: "too-large",
      allowNative: true,
      allowJs: false,
      message: MESSAGES.pt.tooLarge,
    };
  }
  return { reason: null, allowNative: true, allowJs: true, message: "", magic };
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code ? String.fromCharCode(code) : "";
    })
    .replace(/&amp;/g, "&");
}

function xmlText(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function stripTags(xml) {
  return decodeXml(String(xml || "")
    .replace(/<text:tab\b[^/]*\/>/gi, "\t")
    .replace(/<text:line-break\b[^/]*\/>/gi, "\n")
    .replace(/<[^>]+>/g, ""));
}

function rtfToText(rtf) {
  let s = String(rtf || "");
  s = s.replace(/\\'[0-9a-fA-F]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)));
  s = s.replace(/\\u(-?\d+)\??/g, (_, n) => {
    const code = Number(n) & 0xffff;
    return code ? String.fromCharCode(code) : "";
  });
  s = s.replace(/\\par[d]?/gi, "\n");
  s = s.replace(/\\line\b/gi, "\n");
  s = s.replace(/\\tab\b/gi, "\t");
  s = s.replace(/\\[a-zA-Z]+\-?\d* ?/g, "");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function paragraphsToHtml(lines) {
  return lines
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .map((line) => `<p>${lib.escapeHtml(line)}</p>`)
    .join("\n");
}

async function renderDocx(filePath) {
  let mammoth;
  try { mammoth = require("mammoth"); }
  catch { return { ok: false, reason: "unsupported" }; }
  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        try {
          const buf = await image.read();
          if (!buf || buf.length > MAX_IMAGE_BYTES) return { src: "" };
          const type = image.contentType || "image/png";
          return { src: `data:${type};base64,${Buffer.from(buf).toString("base64")}` };
        } catch {
          return { src: "" };
        }
      }),
    },
  );
  const html = lib.sanitizeHtmlDocument(result.value || "");
  return { ok: true, html, truncated: false };
}

function renderOdt(filePath) {
  const zip = extractZip(filePath, { want: (n) => n === "content.xml" });
  const xml = zip.files["content.xml"] ? zip.files["content.xml"].toString("utf8") : "";
  if (!xml) return { ok: false, reason: "unsupported" };
  const blocks = xmlText(xml, "text:p").concat(xmlText(xml, "text:h"));
  const html = paragraphsToHtml(blocks.map(stripTags));
  return { ok: !!html, html, reason: html ? null : "unsupported" };
}

function renderRtf(filePath) {
  const preview = lib.readTextPreview(filePath, MAX_OFFICE_JS_BYTES);
  if (preview.binary || preview.text == null) return { ok: false, reason: "unsupported" };
  const text = rtfToText(preview.text);
  return { ok: !!text, html: paragraphsToHtml(text.split("\n")), truncated: preview.truncated };
}

function loadXlsx() {
  try { return require("xlsx"); }
  catch { return null; }
}

function cellString(value) {
  if (value == null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  return String(value);
}

function sheetToHtml(XLSX, sheet) {
  if (!sheet) return { html: "<table></table>", truncated: false };
  const ref = sheet["!ref"] || "A1";
  const range = XLSX.utils.decode_range(ref);
  const maxR = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
  const maxC = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
  const truncated = range.e.r > maxR || range.e.c > maxC;
  const rows = [];
  rows.push("<table>");
  for (let r = range.s.r; r <= maxR; r += 1) {
    rows.push("<tr>");
    for (let c = range.s.c; c <= maxC; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      const raw = cell && cell.w != null ? cell.w : (cell ? cell.v : "");
      const tag = r === range.s.r ? "th" : "td";
      rows.push(`<${tag}>${lib.escapeHtml(cellString(raw))}</${tag}>`);
    }
    rows.push("</tr>");
  }
  rows.push("</table>");
  return { html: rows.join(""), truncated };
}

function renderSpreadsheet(filePath, ext) {
  const XLSX = loadXlsx();
  if (!XLSX) return { ok: false, reason: "unsupported" };
  let workbook;
  try {
    if (ext === "csv" || ext === "tsv") {
      const preview = lib.readTextPreview(filePath, MAX_OFFICE_JS_BYTES);
      if (preview.binary || preview.text == null) return { ok: false, reason: "unsupported" };
      workbook = XLSX.read(preview.text, { type: "string", raw: false, FS: ext === "tsv" ? "\t" : "," });
    } else {
      workbook = XLSX.readFile(filePath, { cellDates: true, sheetRows: MAX_ROWS + 1 });
    }
  } catch {
    return { ok: false, reason: "error" };
  }
  const names = (workbook.SheetNames || []).slice(0, MAX_SHEETS);
  if (!names.length) return { ok: false, reason: "unsupported" };
  let truncated = (workbook.SheetNames || []).length > MAX_SHEETS;
  const sheets = names.map((name) => {
    const built = sheetToHtml(XLSX, workbook.Sheets[name]);
    if (built.truncated) truncated = true;
    return { name, html: built.html, truncated: built.truncated };
  });
  return { ok: true, sheets, truncated };
}

function dataUrlFor(name, buf) {
  const ext = path.extname(name).replace(".", "").toLowerCase();
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" }[ext];
  if (!mime || !buf || buf.length > MAX_IMAGE_BYTES) return "";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function zipGet(files, name) {
  if (!name) return null;
  const n = String(name).replace(/\\/g, "/").replace(/^\/+/, "");
  if (files[n]) return files[n];
  const guessed = [
    n.replace(/^\.\.\//, ""),
    path.posix.normalize(`ppt/slides/${n}`),
    `ppt/media/${path.posix.basename(n)}`,
  ];
  for (let i = 0; i < guessed.length; i += 1) {
    if (files[guessed[i]]) return files[guessed[i]];
  }
  const base = path.posix.basename(n);
  const key = Object.keys(files).find((k) => path.posix.basename(k) === base);
  return key ? files[key] : null;
}

function parseRels(xml) {
  const map = {};
  const re = /Id="([^"]+)"[^>]*Target="([^"]+)"/gi;
  let m;
  while ((m = re.exec(xml))) map[m[1]] = m[2].replace(/\\/g, "/");
  return map;
}

function renderPptx(filePath) {
  const zip = extractZip(filePath, {
    want: (n) => /^ppt\/(slides\/|media\/|presentation\.xml)/i.test(n) || /\[Content_Types\]\.xml/i.test(n),
  });
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)/i) || [])[1] || 0);
      const nb = Number((b.match(/slide(\d+)/i) || [])[1] || 0);
      return na - nb;
    })
    .slice(0, MAX_SLIDES);
  if (!names.length) return { ok: false, reason: "unsupported" };
  const truncated = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).length > MAX_SLIDES;
  const slides = names.map((name, index) => {
    const xml = zip.files[name].toString("utf8");
    const texts = xmlText(xml, "a:t").map(stripTags).filter(Boolean);
    const relsName = `ppt/slides/_rels/${path.posix.basename(name)}.rels`;
    const relsXml = zip.files[relsName] ? zip.files[relsName].toString("utf8") : "";
    const rels = parseRels(relsXml);
    const images = [];
    Object.keys(rels).forEach((id) => {
      if (images.length >= MAX_SLIDE_IMAGES) return;
      const target = rels[id];
      if (!target || /slideLayout|notesSlide|hyperlink/i.test(target)) return;
      const buf = zipGet(zip.files, target);
      const url = dataUrlFor(target, buf);
      if (url) images.push(url);
    });
    const html = [
      texts.length ? texts.map((t) => `<p>${lib.escapeHtml(t)}</p>`).join("") : `<p class="muted">${lib.escapeHtml("Slide " + (index + 1))}</p>`,
      images.map((src) => `<img src="${src}" alt="">`).join(""),
    ].join("");
    return { label: `Slide ${index + 1}`, html };
  });
  return { ok: true, slides, truncated };
}

function renderOdp(filePath) {
  const zip = extractZip(filePath, { want: (n) => n === "content.xml" || /^Pictures\//i.test(n) || /^media\//i.test(n) });
  const xml = zip.files["content.xml"] ? zip.files["content.xml"].toString("utf8") : "";
  if (!xml) return { ok: false, reason: "unsupported" };
  const pages = xml.split(/<draw:page\b/i).slice(1);
  if (!pages.length) return { ok: false, reason: "unsupported" };
  const truncated = pages.length > MAX_SLIDES;
  const slides = pages.slice(0, MAX_SLIDES).map((chunk, index) => {
    const texts = xmlText(chunk, "text:p").concat(xmlText(chunk, "text:h")).map(stripTags).filter(Boolean);
    const html = texts.length
      ? texts.map((t) => `<p>${lib.escapeHtml(t)}</p>`).join("")
      : `<p class="muted">Slide ${index + 1}</p>`;
    return { label: `Slide ${index + 1}`, html };
  });
  return { ok: true, slides, truncated };
}

async function renderOfficeJs(filePath, kind, ext) {
  const extension = String(ext || lib.extOf(filePath)).toLowerCase();
  try {
    if (kind === "word") {
      if (extension === "docx") {
        const out = await renderDocx(filePath);
        return wrapWord(out);
      }
      if (extension === "odt") return wrapWord(renderOdt(filePath));
      if (extension === "rtf") return wrapWord(renderRtf(filePath));
      return fail("unsupported");
    }
    if (kind === "spreadsheet") {
      const out = renderSpreadsheet(filePath, extension);
      if (!out.ok) return fail(out.reason || "error");
      return {
        ok: true,
        office: { sheets: out.sheets, truncated: out.truncated, reason: null },
      };
    }
    if (kind === "presentation") {
      if (extension === "pptx") {
        const out = renderPptx(filePath);
        return wrapSlides(out);
      }
      if (extension === "odp") return wrapSlides(renderOdp(filePath));
      return fail("unsupported");
    }
    return fail("unsupported");
  } catch (err) {
    return fail("error", err && err.message);
  }
}

function wrapWord(out) {
  if (!out || !out.ok) return fail(out && out.reason || "unsupported");
  return { ok: true, office: { html: out.html || "", truncated: !!out.truncated, reason: null } };
}

function wrapSlides(out) {
  if (!out || !out.ok) return fail(out && out.reason || "unsupported");
  return { ok: true, office: { slides: out.slides || [], truncated: !!out.truncated, reason: null } };
}

function fail(reason) {
  return {
    ok: false,
    office: {
      reason: reason || "error",
      message: messageFor(reason || "error", "pt"),
    },
  };
}

function localizeOffice(office, lang) {
  if (!office) return office;
  const reason = office.reason;
  return {
    ...office,
    message: office.message && !reason ? office.message : (reason ? messageFor(reason, lang) : office.message),
  };
}

module.exports = {
  MAX_OFFICE_JS_BYTES,
  MAX_OFFICE_NATIVE_BYTES,
  MAX_ROWS,
  MAX_COLS,
  MESSAGES,
  isOfficeKind,
  messageFor,
  sniffMagic,
  detectOfficeGuard,
  rtfToText,
  renderOfficeJs,
  localizeOffice,
  extractZip,
  zipLooksEncrypted,
  oleLooksEncrypted,
};
