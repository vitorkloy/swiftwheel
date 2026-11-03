const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const IMAGE = ["jpg", "png", "webp", "heic", "tiff", "svg", "avif", "bmp", "ico", "psd", "tga", "jxl"];
const AUDIO = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff", "wma", "aac"];
const VIDEO = ["mp4", "mov", "mkv", "webm", "avi", "wmv", "m4v", "flv", "mpg", "3gp", "ts"];
const DOCS = ["docx", "doc", "odt", "pages", "md", "rtf", "html"];
const SLIDES = ["ppt", "pptx", "odp", "key"];
const SHEETS = ["xlsx", "xls", "ods", "csv", "tsv"];
const SUBS = ["srt", "vtt"];
const ARCHIVES = ["zip", "tar", "gz", "rar", "7z"];
const SOON = "soon";
const NATIVE = ["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff"];

function which(cmd) {
  try {
    const out = execFileSync("where.exe", [cmd], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).find(Boolean);
    return out || null;
  } catch {
    return null;
  }
}

function dataRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "VOR", "tools");
}

function plannedSoffice() {
  return path.join(dataRoot(), "LibreOffice", "program", "soffice.exe");
}

/** Instalação já presente, ou o caminho que o próprio VOR vai preencher no primeiro uso. */
function sofficePath() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "LibreOffice", "program", "soffice.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  const planned = plannedSoffice();
  if (fs.existsSync(planned)) return planned;
  return which("soffice") || planned;
}

function findExe(dir, name) {
  if (!fs.existsSync(dir)) return null;
  const direct = path.join(dir, name);
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findExe(path.join(dir, entry.name), name);
    if (nested) return nested;
  }
  return null;
}

function findMagickExe(dir) {
  return findExe(dir, "magick.exe");
}

function magickPath() {
  const onPath = which("magick");
  if (onPath && fs.existsSync(onPath)) return onPath;
  return findMagickExe(path.join(dataRoot(), "ImageMagick")) || path.join(dataRoot(), "ImageMagick", "magick.exe");
}

function pandocPath() {
  const onPath = which("pandoc");
  if (onPath && fs.existsSync(onPath)) return onPath;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, "Pandoc", "pandoc.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const extra = [
      path.join(local, "Pandoc", "pandoc.exe"),
      path.join(local, "Programs", "Pandoc", "pandoc.exe"),
      path.join(local, "Microsoft", "WinGet", "Links", "pandoc.exe"),
    ];
    for (const candidate of extra) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return findExe(path.join(dataRoot(), "Pandoc"), "pandoc.exe") || path.join(dataRoot(), "Pandoc", "pandoc.exe");
}

let toolsCache = null;
function forgetTools() { toolsCache = null; }

function tools() {
  if (toolsCache) return toolsCache;
  toolsCache = {
    magick: magickPath(),
    ffmpeg: which("ffmpeg"),
    soffice: sofficePath(),
    pandoc: pandocPath(),
    tar: which("tar"),
    gs: which("gswin64c") || which("gswin32c"),
  };
  return toolsCache;
}

const NATIVE_IMAGE = ["png", "jpg", "bmp", "gif", "tiff"];

function nativeConvertible(from, to) {
  const norm = (ext) => (ext === "jpeg" || ext === "jfif" ? "jpg" : ext === "tif" ? "tiff" : ext);
  return NATIVE_IMAGE.includes(norm(from)) && NATIVE_IMAGE.includes(norm(to));
}

function request(url, redirects = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "VOR", ...headers } }, (res) => {
      const next = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && next) {
        res.resume();
        if (redirects > 6) {
          reject(new Error("muitos redirecionamentos"));
          return;
        }
        resolve(request(new URL(next, url).href, redirects + 1, headers));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

function readText(url, headers) {
  return request(url, 0, headers).then((res) => new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  }));
}

function downloadFile(url, dest) {
  return request(url).then((res) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on("finish", () => file.close(() => resolve()));
    file.on("error", reject);
    res.on("error", reject);
  }));
}

function spawnWait(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} saiu com código ${code}`));
    });
  });
}

function latestLibreOfficeVersion(html) {
  const versions = [];
  for (const part of html.split('href="')) {
    const name = part.split("/")[0];
    const bits = name.split(".");
    if (bits.length === 3 && bits.every((bit) => /^\d+$/.test(bit))) versions.push(bits.map(Number));
  }
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const last = versions[versions.length - 1];
  if (!last) throw new Error("Não encontrei a versão do conversor");
  return last.join(".");
}

function hoistNestedLibreOffice(dir) {
  const nested = path.join(dir, "LibreOffice", "program", "soffice.exe");
  if (!fs.existsSync(nested) || fs.existsSync(plannedSoffice())) return;
  for (const entry of fs.readdirSync(path.join(dir, "LibreOffice"))) {
    const from = path.join(dir, "LibreOffice", entry);
    const to = path.join(dir, entry);
    if (!fs.existsSync(to)) fs.renameSync(from, to);
  }
}

let sofficeInstall = null;

function installLibreOffice(onStatus) {
  if (fs.existsSync(plannedSoffice())) return Promise.resolve();
  if (sofficeInstall) return sofficeInstall;
  sofficeInstall = (async () => {
    if (onStatus) onStatus("Baixando o conversor de documentos…");
    const html = await readText("https://download.documentfoundation.org/libreoffice/stable/");
    const version = latestLibreOfficeVersion(html);
    const root = dataRoot();
    const work = path.join(root, ".soffice-tmp");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const msi = path.join(work, "lo.msi");
    const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
    await downloadFile(url, msi);
    if (onStatus) onStatus("Preparando o conversor de documentos…");
    const dir = path.join(root, "LibreOffice");
    fs.mkdirSync(dir, { recursive: true });
    await spawnWait("msiexec.exe", ["/a", msi, "/qn", `TARGETDIR="${dir}"`]);
    hoistNestedLibreOffice(dir);
    fs.rmSync(work, { recursive: true, force: true });
    if (!fs.existsSync(plannedSoffice())) throw new Error("Não consegui preparar o conversor de documentos");
  })().catch((err) => {
    sofficeInstall = null;
    throw err;
  });
  return sofficeInstall;
}

function actionNeedsSoffice(id, filePath) {
  if (!id.startsWith("conv:")) return false;
  const to = id.slice(5);
  const from = fmtOf(filePath);
  const kind = kindOf(from);
  if (to === "pages") return false;
  if (kind === "image" || kind === "audio" || kind === "video" || kind === "gif" || kind === "subtitle" || kind === "archive") return false;
  if (to === "md" || from === "md" || kind === "epub") return false;
  if (kind === "pdf" && (to === "jpg" || to === "png")) return false;
  return kind === "pdf" || kind === "doc" || kind === "txt" || kind === "slides" || kind === "sheet";
}

/** Baixa o conversor na primeira vez. A roda já mostra a opção, como no ShiftDrop. */
const EXCEL_FORMAT = { csv: 6, tsv: 42, xlsx: 51, ods: 60, pdf: 0 };

function hasExcel() {
  if (hasExcel.cached !== undefined) return hasExcel.cached;
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\excel.exe",
  ];
  hasExcel.cached = keys.some((key) => {
    try {
      execFileSync("reg", ["query", key, "/ve"], { windowsHide: true, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  return hasExcel.cached;
}

function hasWord() {
  if (hasWord.cached !== undefined) return hasWord.cached;
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\winword.exe",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\winword.exe",
  ];
  hasWord.cached = keys.some((key) => {
    try {
      execFileSync("reg", ["query", key, "/ve"], { windowsHide: true, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  return hasWord.cached;
}

function convertWithExcel(filePath, dest, to) {
  const format = EXCEL_FORMAT[to];
  const body = to === "pdf"
    ? `$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($env:VOR_SRC)
$wb.ExportAsFixedFormat(0, $env:VOR_DEST)
$wb.Close($false)
$excel.Quit()`
    : `$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($env:VOR_SRC)
$wb.SaveAs($env:VOR_DEST, ${format})
$wb.Close($false)
$excel.Quit()`;
  execFileSync("powershell", ["-NoProfile", "-STA", "-Command", body], {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, VOR_SRC: filePath, VOR_DEST: dest },
    timeout: 120000,
  });
  if (fs.existsSync(dest)) return dest;
  const asTxt = dest.replace(/\.[^.]+$/, ".txt");
  if (to === "tsv" && fs.existsSync(asTxt)) {
    fs.renameSync(asTxt, dest);
    return dest;
  }
  throw new Error("O Excel não gerou o arquivo");
}

async function installMagick(onStatus) {
  const current = magickPath();
  if (fs.existsSync(current)) return;
  if (onStatus) onStatus("Baixando o conversor de imagens…");
  const release = JSON.parse(await readText("https://api.github.com/repos/ImageMagick/ImageMagick/releases/latest", {
    Accept: "application/vnd.github+json",
  }));
  const asset = (release.assets || []).find((item) => item.name.includes("portable-Q16-x64.7z") && !item.name.includes("HDRI"));
  if (!asset || !asset.browser_download_url) throw new Error("Não encontrei o conversor de imagens");
  const root = path.join(dataRoot(), "ImageMagick");
  const work = path.join(dataRoot(), ".magick-tmp");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(work, asset.name);
  await downloadFile(asset.browser_download_url, archive);
  if (onStatus) onStatus("Preparando o conversor de imagens…");
  await spawnWait("tar", ["-xf", archive, "-C", root]);
  fs.rmSync(work, { recursive: true, force: true });
  forgetTools();
  if (!fs.existsSync(magickPath())) throw new Error("Não consegui preparar o conversor de imagens");
}

let pandocInstall = null;

async function installPandoc(onStatus) {
  const current = pandocPath();
  if (fs.existsSync(current)) return;
  if (pandocInstall) return pandocInstall;
  pandocInstall = (async () => {
    if (onStatus) onStatus("Baixando o conversor de texto…");
    const release = JSON.parse(await readText("https://api.github.com/repos/jgm/pandoc/releases/latest", {
      Accept: "application/vnd.github+json",
    }));
    const asset = (release.assets || []).find((item) => /windows-x86_64\.zip$/i.test(item.name));
    if (!asset || !asset.browser_download_url) throw new Error("Não encontrei o conversor de texto");
    const root = path.join(dataRoot(), "Pandoc");
    const work = path.join(dataRoot(), ".pandoc-tmp");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(work, asset.name);
    await downloadFile(asset.browser_download_url, archive);
    if (onStatus) onStatus("Preparando o conversor de texto…");
    await spawnWait("tar", ["-xf", archive, "-C", root]);
    fs.rmSync(work, { recursive: true, force: true });
    forgetTools();
    if (!fs.existsSync(pandocPath())) throw new Error("Não consegui preparar o conversor de texto");
  })().catch((err) => {
    pandocInstall = null;
    throw err;
  });
  return pandocInstall;
}

function needsPandoc(id, filePath) {
  if (!id.startsWith("conv:")) return false;
  const to = id.slice(5);
  const from = fmtOf(filePath);
  if (to === "pages" || to === "png" || to === "jpg") return false;
  if (from === "md" || to === "md") return true;
  return kindOf(from) === "epub" && to !== "pdf";
}

async function prepare(id, filePath, onStatus) {
  if (id.startsWith("conv:")) {
    const to = id.slice(5);
    const from = fmtOf(filePath);
    if (kindOf(from) === "image" && !nativeConvertible(from, to) && !fs.existsSync(magickPath())) {
      try {
        await installMagick(onStatus);
      } catch {
        throw new Error("Não consegui preparar o conversor de imagens");
      }
      forgetTools();
    }
    if (needsPandoc(id, filePath) && !fs.existsSync(pandocPath())) {
      try {
        await installPandoc(onStatus);
      } catch {
        throw new Error("Não consegui preparar o conversor de texto");
      }
      forgetTools();
    }
  }
  if (!actionNeedsSoffice(id, filePath)) return;
  const to = id.slice(5);
  if (kindOf(fmtOf(filePath)) === "sheet" && EXCEL_FORMAT[to] !== undefined && hasExcel()) return;
  const current = sofficePath();
  if (current && fs.existsSync(current)) return;
  await installLibreOffice(onStatus);
}

function fmtOf(file) {
  let e = path.extname(file).slice(1).toLowerCase();
  if (e === "jpeg" || e === "jfif") e = "jpg";
  if (e === "tif") e = "tiff";
  if (e === "htm") e = "html";
  if (e === "markdown") e = "md";
  return e;
}

function kindOf(fmt) {
  if (fmt === "gif") return "gif";
  if (IMAGE.includes(fmt)) return "image";
  if (AUDIO.includes(fmt)) return "audio";
  if (VIDEO.includes(fmt)) return "video";
  if (fmt === "pdf") return "pdf";
  if (fmt === "txt") return "txt";
  if (fmt === "epub") return "epub";
  if (DOCS.includes(fmt)) return "doc";
  if (SLIDES.includes(fmt)) return "slides";
  if (SHEETS.includes(fmt)) return "sheet";
  if (SUBS.includes(fmt)) return "subtitle";
  if (ARCHIVES.includes(fmt)) return "archive";
  return "other";
}

function targets(kind, fmt) {
  const table = {
    image: ["jpg", "png", "webp", "heic", "tiff", "avif", "bmp", "pdf"],
    audio: ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff", "wma"],
    video: ["mp4", "mov", "mkv", "webm", "avi", "wmv", "gif", "mp3"],
    gif: ["mp4", "mov", "mkv", "webm", "avi", "wmv"],
    pdf: ["docx", "pages", "pptx", "xlsx", "jpg", "png", "epub", "txt", "md"],
    slides: ["pdf", "jpg", "png"],
    sheet: ["xlsx", "ods", "csv", "tsv", "pdf"],
    doc: ["docx", "pages", "pdf", "txt", "md", "html", "epub", "png", "jpg"],
    epub: ["pdf", "docx", "pages", "txt", "md", "html"],
    txt: ["docx", "pages", "pdf", "md", "html", "epub", "jpg", "png"],
    subtitle: ["srt", "vtt", "txt"],
    archive: ["zip", "tar", "gz"],
  };
  return (table[kind] || []).filter((x) => x !== fmt);
}

function titleOf(fmt) {
  return fmt === "gz" ? "GZIP" : fmt.toUpperCase();
}

function ok() { return { available: true, reason: null }; }
function no(msg) { return { available: false, reason: msg }; }
function need(tool, msg) { return tool ? ok() : no(msg); }

function convGate(kind, from, to, t) {
  if (to === "pages") return no("pages");
  if (kind === "image") {
    if (nativeConvertible(from, to)) return ok();
    return need(t.magick, "imagemagick");
  }
  if (kind === "audio" || kind === "video" || kind === "gif") return need(t.ffmpeg, "ffmpeg");
  if (kind === "pdf") {
    if (to === "jpg" || to === "png") return need(t.gs, "ghostscript");
    if (to === "docx" || to === "txt") return need(t.soffice, "libreoffice");
    return no(SOON);
  }
  if (kind === "doc" || kind === "txt" || kind === "slides" || kind === "sheet") {
    if (to === "md" || from === "md") {
      if (from === "md" && (to === "png" || to === "jpg")) return no(SOON);
      return need(t.pandoc, "pandoc");
    }
    return need(t.soffice, "libreoffice");
  }
  if (kind === "epub") return to === "pdf" ? no(SOON) : need(t.pandoc, "pandoc");
  if (kind === "subtitle") return ok();
  if (kind === "archive") return need(t.tar, "tar");
  return no("unsupported");
}

function toolTitle(id) {
  const map = {
    compress: "COMPRESS", removeMetadata: "METADATA", editImage: "EDIT", annotateImage: "ANNOTATE",
    frameImage: "ADD BG", cropImage: "CROP", cropVideo: "CROP", redactImage: "REDACT", redactVideo: "REDACT",
    normalizeAudio: "NORMALIZE", muteVideo: "MUTE", trimVideo: "TRIM", trimAudio: "TRIM",
    splitPDF: "SPLIT", splitVideo: "SPLIT", organizePDF: "ORGANIZE", extractArchive: "EXTRACT",
    createPDF: "CREATE PDF", mergePDF: "MERGE PDF", changeVideoSpeed: "SPEED", joinVideos: "JOIN",
    videoSnapshots: "SNAPSHOT", audioToVideo: "VISUALIZE", audioChannels: "CHANNELS", createCollage: "COLLAGE",
    redactAudio: "BLEEP", airDrop: "SHARE", float: "FLOAT", copy: "COPY", move: "MOVE",
    copyPath: "COPY PATH", openTerminal: "TERMINAL",
  };
  return map[id] || "?";
}

function toolIds(kind, fmt) {
  if (kind === "image" && fmt === "svg") return [];
  if (kind === "image") return ["compress", "removeMetadata", "editImage", "annotateImage", "frameImage", "cropImage", "redactImage"];
  if (kind === "audio") return ["compress", "removeMetadata", "normalizeAudio", "audioToVideo", "trimAudio", "audioChannels", "redactAudio"];
  if (kind === "video") return ["compress", "removeMetadata", "muteVideo", "trimVideo", "cropVideo", "changeVideoSpeed", "videoSnapshots", "splitVideo", "redactVideo"];
  if (kind === "gif") return ["removeMetadata"];
  if (kind === "pdf") return ["compress", "removeMetadata", "splitPDF", "organizePDF"];
  if (kind === "archive") return ["extractArchive"];
  return [];
}

function toolGate(id, kind, t) {
  if (id === "compress") {
    if (kind === "image") return ok();
    if (kind === "pdf") return need(t.gs, "ghostscript");
    return need(t.ffmpeg, "ffmpeg");
  }
  if (id === "removeMetadata") {
    if (kind === "image") return ok();
    if (kind === "pdf") return no(SOON);
    return need(t.ffmpeg, "ffmpeg");
  }
  if (["muteVideo", "changeVideoSpeed", "videoSnapshots", "splitVideo", "normalizeAudio", "audioToVideo", "audioChannels", "joinVideos"].includes(id)) {
    return need(t.ffmpeg, "ffmpeg");
  }
  if (id === "createPDF" || ["copy", "move", "copyPath", "openTerminal"].includes(id)) return ok();
  if (id === "extractArchive") return need(t.tar, "tar");
  return no(SOON);
}

function item(id, title, gate) {
  return { id, title, available: gate.available, reason: gate.reason };
}

function pending(mode) {
  return {
    mode,
    format: "…",
    kind: "other",
    path: "",
    items: Array.from({ length: 6 }, (_, i) => ({
      id: `pending:${i}`,
      title: "…",
      available: false,
      reason: null,
    })),
  };
}

function build(filePath, mode) {
  const t = tools();
  const fmt = fmtOf(filePath);
  const kind = kindOf(fmt);
  let items = [];
  if (mode === "convert") {
    items = targets(kind, fmt).map((to) => item(`conv:${to}`, titleOf(to), convGate(kind, fmt, to, t)));
  } else if (mode === "tools") {
    items = toolIds(kind, fmt).map((id) => item(`tool:${id}`, toolTitle(id), toolGate(id, kind, t)));
  } else {
    items = ["airDrop", "float", "copy", "move", "copyPath", "openTerminal"].map((id) =>
      item(`act:${id}`, toolTitle(id), toolGate(id, kind, t)),
    );
  }
  return { mode, format: titleOf(fmt), kind, path: filePath, items };
}

function uniquePath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}.${ext}`);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n}).${ext}`);
    n += 1;
  }
  return candidate;
}

const PANDOC_WRITER = { txt: "plain", html: "html", docx: "docx", epub: "epub", pdf: "pdf", md: "markdown", odt: "odt", rtf: "rtf" };

function convertWithPandoc(filePath, dest, to, pandoc) {
  const writer = PANDOC_WRITER[to];
  if (!writer) throw new Error("Esse formato ainda não sai deste arquivo");
  if (to === "pdf" && hasWord()) {
    const tmp = path.join(os.tmpdir(), `vor-${Date.now()}.docx`);
    try {
      execFileSync(pandoc, [filePath, "-t", "docx", "-o", tmp], { windowsHide: true, stdio: "ignore", timeout: 120000 });
      execFileSync("powershell", ["-NoProfile", "-STA", "-Command", `$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open($env:VOR_SRC)
$doc.ExportAsFixedFormat($env:VOR_DEST, 17)
$doc.Close($false)
$word.Quit()`], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, VOR_SRC: tmp, VOR_DEST: dest },
        timeout: 120000,
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(dest)) throw new Error("Não consegui gerar o PDF");
    return dest;
  }
  try {
    execFileSync(pandoc, [filePath, "-t", writer, "-o", dest], { windowsHide: true, stdio: "ignore", timeout: 120000 });
  } catch {
    if (to === "pdf") throw new Error("Não consegui gerar o PDF");
    throw new Error("A conversão não gerou o arquivo");
  }
  if (!fs.existsSync(dest)) throw new Error("A conversão não gerou o arquivo");
  return dest;
}

function run(id, filePath) {
  const built = build(filePath, id.startsWith("conv:") ? "convert" : id.startsWith("tool:") ? "tools" : "actions");
  const found = built.items.find((i) => i.id === id);
  if (found && !found.available) throw new Error(found.reason || "Indisponível");
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const t = tools();
  if (id.startsWith("conv:")) {
    const to = id.slice(5);
    const dest = uniquePath(dir, stem, to);
    const from = fmtOf(filePath);
    if (nativeConvertible(from, to)) {
      const fmt = { jpg: "Jpeg", png: "Png", bmp: "Bmp", gif: "Gif", tiff: "Tiff" }[to === "tif" ? "tiff" : to];
      execFileSync("powershell", ["-NoProfile", "-Command", `
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile(${JSON.stringify(filePath)})
        $img.Save(${JSON.stringify(dest)}, [System.Drawing.Imaging.ImageFormat]::${fmt})
        $img.Dispose()
      `], { windowsHide: true, stdio: "ignore" });
      return dest;
    }
    if (needsPandoc(id, filePath)) {
      if (!(t.pandoc && fs.existsSync(t.pandoc))) throw new Error("Não consegui preparar o conversor de texto");
      return convertWithPandoc(filePath, dest, to, t.pandoc);
    }
    if (kindOf(from) === "image" && t.magick && fs.existsSync(t.magick)) {
      execFileSync(t.magick, [filePath, dest], { windowsHide: true, stdio: "ignore" });
      return dest;
    }
    if ((kindOf(from) === "audio" || kindOf(from) === "video" || kindOf(from) === "gif") && t.ffmpeg && ["mp3", "wav", "mp4", "gif", "webm", "mkv"].includes(to)) {
      execFileSync(t.ffmpeg, ["-y", "-i", filePath, dest], { stdio: "ignore" });
      return dest;
    }
    if (kindOf(from) === "sheet" && EXCEL_FORMAT[to] !== undefined && hasExcel()) {
      try {
        return convertWithExcel(filePath, dest, to);
      } catch (err) {
        if (!(t.soffice && fs.existsSync(t.soffice))) throw err;
      }
    }
    if (t.soffice && fs.existsSync(t.soffice)) {
      execFileSync(t.soffice, ["--headless", "--convert-to", to, "--outdir", dir, filePath], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 120000,
      });
      const produced = path.join(dir, `${stem}.${to}`);
      if (fs.existsSync(dest)) return dest;
      if (fs.existsSync(produced)) return produced;
      throw new Error("A conversão não gerou o arquivo");
    }
    throw new Error("soon");
  }
  if (id === "act:copy" || id === "tool:copy") {
    const dest = uniquePath(dir, stem, path.extname(filePath).slice(1) || "bin");
    fs.copyFileSync(filePath, dest);
    return dest;
  }
  if (id === "act:move") {
    const dest = uniquePath(dir, stem, path.extname(filePath).slice(1) || "bin");
    fs.renameSync(filePath, dest);
    return dest;
  }
  if (id === "act:copyPath") {
    return filePath;
  }
  if (id === "act:openTerminal") {
    spawn("cmd", ["/C", "start", "cmd", "/K", `cd /d ${dir}`], { detached: true, stdio: "ignore" }).unref();
    return dir;
  }
  if (id === "tool:compress" && kindOf(fmtOf(filePath)) === "image") {
    const dest = uniquePath(dir, `${stem}-compressed`, "jpg");
    execFileSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile(${JSON.stringify(filePath)})
      $img.Save(${JSON.stringify(dest)}, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $img.Dispose()
    `], { stdio: "ignore" });
    return dest;
  }
  if (id === "tool:extractArchive" && t.tar) {
    const destDir = uniquePath(dir, `${stem}-extract`, "dir").replace(/\.dir$/, "");
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync(t.tar, ["-xf", filePath, "-C", destDir], { stdio: "ignore" });
    return destDir;
  }
  throw new Error(SOON);
}

module.exports = { build, pending, run, tools, prepare };
