"use strict";

/**
 * Leitura e classificação da prévia — só no processo principal.
 * O renderer isolado recebe texto já sanitizado e URLs do protocolo vor-preview.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mkv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "flac"]);
const PDF_EXT = new Set(["pdf"]);
const MARKDOWN_EXT = new Set(["md", "markdown"]);
const HTML_EXT = new Set(["html", "htm"]);
const ZIP_EXT = new Set(["zip"]);
const TEXT_EXT = new Set([
  "txt", "log", "csv", "tsv", "ini", "cfg", "conf", "env", "gitignore", "gitattributes",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "css", "scss", "less",
  "py", "rb", "php", "rs", "go", "java", "kt", "kts", "swift", "cs", "c", "h", "cpp", "hpp", "cc",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "xml", "yml", "yaml", "toml", "sql",
  "vue", "svelte", "graphql", "mdx", "dockerfile", "makefile", "cmake", "gradle",
  "rtf", "tex", "diff", "patch", "properties", "editorconfig",
]);

const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  json: "json", css: "css", scss: "css", less: "css",
  py: "python", rb: "ruby", php: "php", rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", cs: "csharp",
  c: "c", h: "c", cpp: "c", hpp: "c", cc: "c",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "bash", cmd: "bash",
  xml: "markup", html: "markup", htm: "markup", vue: "markup", svelte: "markup",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", md: "markdown", markdown: "markdown",
  graphql: "graphql",
};

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac",
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  zip: "application/zip", json: "application/json",
};

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4000;
const MAX_FOLDER_ENTRIES = 2000;
const MAX_FOLDER_WALK = 8000;

function extOf(filePath) {
  const base = path.basename(String(filePath || ""));
  if (/^dockerfile$/i.test(base) || /^makefile$/i.test(base)) return base.toLowerCase();
  return path.extname(base).replace(/^\./, "").toLowerCase();
}

function mimeFor(ext, kind) {
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (kind === "text" || kind === "markdown" || kind === "html") return "text/plain";
  return "application/octet-stream";
}

function langFor(ext) {
  return LANG_BY_EXT[ext] || "text";
}

function classifyKind(filePath, stat) {
  if (stat && stat.isDirectory()) return "folder";
  const ext = extOf(filePath);
  if (IMAGE_EXT.has(ext)) return ext === "svg" ? "svg" : "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (PDF_EXT.has(ext)) return "pdf";
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (HTML_EXT.has(ext)) return "html";
  if (ZIP_EXT.has(ext)) return "zip";
  if (TEXT_EXT.has(ext)) return "text";
  return "fallback";
}

function looksLikeText(buffer) {
  if (!buffer || !buffer.length) return true;
  const sample = buffer.length > 8000 ? buffer.subarray(0, 8000) : buffer;
  let nuls = 0;
  for (let i = 0; i < sample.length; i += 1) if (sample[i] === 0) nuls += 1;
  return nuls / sample.length < 0.02;
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString("utf16le");
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  return buffer.toString("utf8", start);
}

function readTextPreview(filePath, maxBytes = MAX_TEXT_BYTES) {
  const st = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    if (!looksLikeText(buf)) return { text: null, truncated: false, binary: true };
    return { text: decodeText(buf), truncated: st.size > maxBytes, binary: false };
  } finally {
    fs.closeSync(fd);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripUnsafeMarkup(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<form\b[\s\S]*?<\/form>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/vbscript:/gi, "")
    .replace(/data:text\/html/gi, "data:text/plain");
}

function sanitizeSvg(svg) {
  return stripUnsafeMarkup(String(svg || ""))
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "");
}

function sanitizeHtmlDocument(html) {
  return stripUnsafeMarkup(html);
}

function safeHref(href) {
  const raw = String(href || "").trim();
  if (/^https?:\/\//i.test(raw) || raw.startsWith("mailto:")) return escapeHtml(raw);
  return "";
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = safeHref(href);
    if (!safe) return label;
    return `<a href="${safe}" rel="noreferrer noopener">${label}</a>`;
  });
  return out;
}

function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let listType = null;
  const closeList = () => {
    if (!listType) return;
    html.push(listType === "ol" ? "</ol>" : "</ul>");
    listType = null;
  };
  const flushCode = () => {
    html.push(`<pre><code class="lang-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    codeLang = "";
    inCode = false;
  };
  for (const line of lines) {
    if (inCode) {
      if (/^```/.test(line)) flushCode();
      else codeLines.push(line);
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      inCode = true;
      codeLang = fence[1] || "text";
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      html.push("<hr/>");
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const n = heading[1].length;
      html.push(`<h${n}>${inlineMarkdown(heading[2])}</h${n}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (listType !== "ul") { closeList(); html.push("<ul>"); listType = "ul"; }
      html.push(`<li>${inlineMarkdown(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (listType !== "ol") { closeList(); html.push("<ol>"); listType = "ol"; }
      html.push(`<li>${inlineMarkdown(ol[1])}</li>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) flushCode();
  closeList();
  return html.join("\n");
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

function listZipEntries(filePath) {
  const st = fs.statSync(filePath);
  if (st.size < 22) return { entries: [], truncated: false };
  const fd = fs.openSync(filePath, "r");
  try {
    const tailLen = Math.min(st.size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    const eocd = findEocd(tail);
    if (eocd < 0) return { entries: [], truncated: false, error: "zip-eocd" };
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset >= st.size || cdSize > st.size) return { entries: [], truncated: false, error: "zip64" };
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    let offset = 0;
    let seen = 0;
    while (offset + 46 <= cd.length && seen < total) {
      if (cd[offset] !== 0x50 || cd[offset + 1] !== 0x4b || cd[offset + 2] !== 0x01 || cd[offset + 3] !== 0x02) break;
      const nameLen = cd.readUInt16LE(offset + 28);
      const extraLen = cd.readUInt16LE(offset + 30);
      const commentLen = cd.readUInt16LE(offset + 32);
      const uncompressed = cd.readUInt32LE(offset + 24);
      const name = cd.toString("utf8", offset + 46, offset + 46 + nameLen);
      const isDir = name.endsWith("/") || name.endsWith("\\");
      if (entries.length < MAX_ZIP_ENTRIES) {
        entries.push({ name, size: isDir ? 0 : uncompressed, isDir });
      }
      offset += 46 + nameLen + extraLen + commentLen;
      seen += 1;
    }
    return { entries, truncated: seen > MAX_ZIP_ENTRIES || entries.length >= MAX_ZIP_ENTRIES && seen > entries.length };
  } finally {
    fs.closeSync(fd);
  }
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n) || 0;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const num = u === 0 ? String(Math.round(v)) : (v < 10 ? v.toFixed(1) : v.toFixed(0));
  return `${num.replace(".", ",")} ${units[u]}`;
}

function listFolder(dirPath) {
  let names = [];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return { items: [], count: 0, files: 0, folders: 0, totalSize: 0, truncated: false };
  }
  names.sort((a, b) => a.localeCompare(b, "pt", { sensitivity: "base" }));
  const items = [];
  let files = 0;
  let folders = 0;
  let shown = 0;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const full = path.join(dirPath, name);
    let st;
    try { st = fs.lstatSync(full); } catch { continue; }
    const isDir = st.isDirectory();
    if (isDir) folders += 1;
    else files += 1;
    if (shown < MAX_FOLDER_ENTRIES) {
      items.push({
        name,
        isDir,
        size: isDir ? 0 : st.size,
        sizeLabel: isDir ? "" : formatBytes(st.size),
      });
      shown += 1;
    }
  }
  const walk = walkFolderSize(dirPath);
  return {
    items,
    count: files + folders,
    files,
    folders,
    totalSize: walk.size,
    truncated: walk.truncated || shown < files + folders,
  };
}

function walkFolderSize(root) {
  let size = 0;
  let seen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    if (seen >= MAX_FOLDER_WALK) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen >= MAX_FOLDER_WALK) { truncated = true; break; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { size += fs.lstatSync(full).size; } catch { /* ignore */ }
      }
    }
  }
  return { size, truncated };
}

function listSiblings(filePath) {
  const dir = path.dirname(filePath);
  let names;
  try { names = fs.readdirSync(dir); } catch { return { paths: [filePath], index: 0 }; }
  const paths = [];
  for (const name of names) {
    if (name === "." || name === "..") continue;
    paths.push(path.join(dir, name));
  }
  paths.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "pt", { sensitivity: "base" }));
  let index = paths.findIndex((p) => p.toLowerCase() === filePath.toLowerCase());
  if (index < 0) {
    paths.unshift(filePath);
    index = 0;
  }
  return { paths, index };
}

function isoOrEmpty(date) {
  try { return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : ""; }
  catch { return ""; }
}

function fileMeta(filePath, stat) {
  const st = stat || fs.statSync(filePath);
  const ext = extOf(filePath);
  return {
    name: path.basename(filePath),
    dir: path.dirname(filePath),
    ext,
    size: st.isDirectory() ? 0 : st.size,
    sizeLabel: st.isDirectory() ? "" : formatBytes(st.size),
    created: isoOrEmpty(st.birthtime),
    modified: isoOrEmpty(st.mtime),
    isDir: st.isDirectory(),
  };
}

function previewNavCommand(key) {
  const token = String(key || "");
  if (token === "Escape" || token === " " || token === "Space") return "close";
  if (token === "Enter") return "launch";
  if (token === "ArrowRight" || token === "ArrowDown") return "next";
  if (token === "ArrowLeft" || token === "ArrowUp") return "prev";
  return null;
}

function canonicalAccelerator(raw) {
  const parts = String(raw || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = [];
  let key = "";
  for (const part of parts) {
    const token = part.toLowerCase().replace(/\s+/g, "");
    if (token === "ctrl" || token === "control" || token === "commandorcontrol") mods.push("commandorcontrol");
    else if (token === "alt" || token === "option") mods.push("alt");
    else if (token === "shift") mods.push("shift");
    else if (token === "super" || token === "meta" || token === "win" || token === "cmd" || token === "command") mods.push("super");
    else if (token === "printscreen" || token === "prtsc" || token === "snapshot") key = "printscreen";
    else if (token === "space" || token === " ") key = "space";
    else if (token === "escape" || token === "esc") key = "escape";
    else if (token === "enter" || token === "return") key = "enter";
    else key = token;
  }
  const order = ["commandorcontrol", "alt", "shift", "super"];
  const used = order.filter((m) => mods.includes(m));
  return key ? [...used, key].join("+") : "";
}

module.exports = {
  IMAGE_EXT,
  VIDEO_EXT,
  AUDIO_EXT,
  classifyKind,
  mimeFor,
  langFor,
  extOf,
  readTextPreview,
  looksLikeText,
  decodeText,
  escapeHtml,
  sanitizeSvg,
  sanitizeHtmlDocument,
  renderMarkdown,
  listZipEntries,
  listFolder,
  listSiblings,
  fileMeta,
  formatBytes,
  previewNavCommand,
  canonicalAccelerator,
  MAX_TEXT_BYTES,
  tmpdir: () => os.tmpdir(),
};
