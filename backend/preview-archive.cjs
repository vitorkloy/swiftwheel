"use strict";

/**
 * Lista 7z/rar em memória com libarchive-wasm (MIT, libarchive BSD).
 * Só lê cabeçalhos: skipData, nada vai para o disco.
 */
const fs = require("fs");
const path = require("path");
const lib = require("./preview-lib.cjs");

const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;

const MESSAGES = {
  pt: {
    tooLarge: "Arquivo grande demais para prévia. Abra-o no aplicativo.",
    error: "Não foi possível listar este arquivo.",
  },
  en: {
    tooLarge: "File is too large to preview. Open it in the app.",
    error: "Could not list this archive.",
  },
};

function messageFor(reason, lang) {
  const pack = lang === "en" ? MESSAGES.en : MESSAGES.pt;
  return pack[reason] || pack.error;
}

function resolveUnpacked(filePath) {
  const unpacked = String(filePath).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  return unpacked !== filePath && fs.existsSync(unpacked) ? unpacked : filePath;
}

let archiveModPromise = null;

function loadArchiveMod() {
  if (archiveModPromise) return archiveModPromise;
  archiveModPromise = (async () => {
    const { ArchiveReader, libarchiveWasm } = require("libarchive-wasm");
    const glue = require.resolve("libarchive-wasm/dist/libarchive.js");
    const wasmFile = resolveUnpacked(path.join(path.dirname(glue), "libarchive.wasm"));
    const wasmBinary = new Uint8Array(fs.readFileSync(wasmFile));
    const mod = await libarchiveWasm({ wasmBinary });
    return { ArchiveReader, mod };
  })();
  return archiveModPromise;
}

function isDirEntry(entry) {
  const name = entry.getPathname() || "";
  const type = entry.getFiletype();
  return type === "Directory" || name.endsWith("/") || name.endsWith("\\");
}

async function listPackedArchive(filePath, size) {
  const bytes = size == null ? fs.statSync(filePath).size : Number(size) || 0;
  if (bytes > MAX_ARCHIVE_BYTES) return { entries: [], truncated: false, error: "tooLarge" };
  if (bytes < 8) return { entries: [], truncated: false, error: "error" };
  let reader;
  try {
    const { ArchiveReader, mod } = await loadArchiveMod();
    const data = new Int8Array(fs.readFileSync(filePath));
    reader = new ArchiveReader(mod, data);
    const entries = [];
    let seen = 0;
    let truncated = false;
    // entries() chama skipData no free de cada item — não extrai conteúdo nem escreve no disco.
    for (const entry of reader.entries()) {
      const name = entry.getPathname() || "";
      if (!name) continue;
      seen += 1;
      if (entries.length >= lib.MAX_ZIP_ENTRIES) {
        truncated = true;
        continue;
      }
      const dir = isDirEntry(entry);
      entries.push({ name, size: dir ? 0 : Number(entry.getSize()) || 0, isDir: dir });
    }
    return { entries, truncated: truncated || seen > lib.MAX_ZIP_ENTRIES };
  } catch {
    return { entries: [], truncated: false, error: "error" };
  } finally {
    try { if (reader) reader.free(); } catch { /* ignore */ }
  }
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  messageFor,
  listPackedArchive,
};
