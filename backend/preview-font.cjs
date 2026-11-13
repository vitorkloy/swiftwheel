"use strict";

/**
 * Família da fonte a partir da tabela name (TTF/OTF/WOFF). WOFF2 usa o nome do arquivo.
 * A amostra em si é o FontFace no renderer, com o ficheiro servido pelo protocolo.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MAX_FONT_BYTES = 8 * 1024 * 1024;

const MESSAGES = {
  pt: {
    tooLarge: "Arquivo grande demais para prévia. Abra-o no aplicativo.",
    error: "Não foi possível carregar esta fonte.",
  },
  en: {
    tooLarge: "File is too large to preview. Open it in the app.",
    error: "Could not load this font.",
  },
};

function messageFor(reason, lang) {
  const pack = lang === "en" ? MESSAGES.en : MESSAGES.pt;
  return pack[reason] || pack.error;
}

function fallbackName(filePath) {
  const base = path.basename(String(filePath || ""));
  return base.replace(/\.(ttf|otf|woff2?)$/i, "") || base || "Fonte";
}

function decodeName(buf, platform, encoding) {
  if (!buf || !buf.length) return "";
  if (platform === 3 && (encoding === 1 || encoding === 10)) {
    if (buf.length % 2) return "";
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString("utf16le").replace(/\0/g, "").trim();
  }
  if (platform === 0) {
    if (buf.length % 2) return buf.toString("utf8").replace(/\0/g, "").trim();
    const swapped = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString("utf16le").replace(/\0/g, "").trim();
  }
  return buf.toString("latin1").replace(/\0/g, "").trim();
}

function parseNameTable(table) {
  if (!table || table.length < 6) return "";
  const count = table.readUInt16BE(2);
  const stringOff = table.readUInt16BE(4);
  const picks = [];
  for (let i = 0; i < count; i += 1) {
    const rec = 6 + i * 12;
    if (rec + 12 > table.length) break;
    const platform = table.readUInt16BE(rec);
    const encoding = table.readUInt16BE(rec + 2);
    const nameId = table.readUInt16BE(rec + 6);
    const length = table.readUInt16BE(rec + 8);
    const offset = table.readUInt16BE(rec + 10);
    if (nameId !== 16 && nameId !== 1 && nameId !== 4) continue;
    const start = stringOff + offset;
    if (start < 0 || start + length > table.length) continue;
    const text = decodeName(table.subarray(start, start + length), platform, encoding);
    if (!text) continue;
    const rank = (nameId === 16 ? 30 : nameId === 1 ? 20 : 10)
      + (platform === 3 ? 2 : 0)
      + (encoding === 1 || encoding === 10 ? 1 : 0);
    picks.push({ rank, text });
  }
  picks.sort((a, b) => b.rank - a.rank);
  return picks.length ? picks[0].text : "";
}

function readTable(buf, offset, length) {
  if (offset < 0 || length < 0 || offset + length > buf.length) return null;
  return buf.subarray(offset, offset + length);
}

function familyFromSfnt(buf) {
  if (!buf || buf.length < 12) return "";
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) break;
    const tag = buf.toString("ascii", rec, rec + 4);
    if (tag !== "name") continue;
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    const table = readTable(buf, offset, length);
    return table ? parseNameTable(table) : "";
  }
  return "";
}

function familyFromWoff(buf) {
  if (!buf || buf.length < 44 || buf.toString("ascii", 0, 4) !== "wOFF") return "";
  const numTables = buf.readUInt16BE(12);
  for (let i = 0; i < numTables; i += 1) {
    const rec = 44 + i * 20;
    if (rec + 20 > buf.length) break;
    const tag = buf.toString("ascii", rec, rec + 4);
    if (tag !== "name") continue;
    const offset = buf.readUInt32BE(rec + 4);
    const compLength = buf.readUInt32BE(rec + 8);
    const origLength = buf.readUInt32BE(rec + 12);
    const raw = readTable(buf, offset, compLength);
    if (!raw) return "";
    let table = raw;
    if (compLength !== origLength) {
      try { table = zlib.inflateSync(raw); } catch { return ""; }
    }
    if (table.length > origLength) table = table.subarray(0, origLength);
    return parseNameTable(table);
  }
  return "";
}

function familyFromFontBuffer(buf) {
  if (!buf || buf.length < 4) return "";
  const tag = buf.toString("ascii", 0, 4);
  if (tag === "wOFF") return familyFromWoff(buf);
  if (tag === "wOF2") return "";
  if (tag === "OTTO" || tag === "true" || tag === "typ1") return familyFromSfnt(buf);
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return familyFromSfnt(buf);
  return "";
}

function parseFontFamily(filePath, size) {
  const bytes = size == null ? fs.statSync(filePath).size : Number(size) || 0;
  const fallback = fallbackName(filePath);
  if (bytes > MAX_FONT_BYTES) return { family: fallback, tooLarge: true };
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return { family: fallback, tooLarge: false }; }
  const family = familyFromFontBuffer(buf);
  return { family: family || fallback, tooLarge: false };
}

module.exports = {
  MAX_FONT_BYTES,
  messageFor,
  fallbackName,
  familyFromFontBuffer,
  parseFontFamily,
};
