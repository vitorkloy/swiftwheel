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

/** ffmpeg no PATH, ou o portátil que o VOR baixa sozinho no primeiro uso (como o ImageMagick). */
function ffmpegPath() {
  const onPath = which("ffmpeg");
  if (onPath && fs.existsSync(onPath)) return onPath;
  return findExe(path.join(dataRoot(), "FFmpeg"), "ffmpeg.exe") || path.join(dataRoot(), "FFmpeg", "ffmpeg.exe");
}

let toolsCache = null;
function forgetTools() { toolsCache = null; }

function tools() {
  if (toolsCache) return toolsCache;
  toolsCache = {
    magick: magickPath(),
    ffmpeg: ffmpegPath(),
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

/** Sem dados por este tempo = rede parada. Antes não havia timeout e a roda ficava "a pensar" para sempre. */
const NET_IDLE_MS = 30000;

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
    req.setTimeout(NET_IDLE_MS, () => req.destroy(new Error("sem resposta da rede")));
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

/** Baixa para `.part` e só renomeia no fim: um download interrompido nunca passa por completo. */
function downloadFile(url, dest) {
  const part = `${dest}.part`;
  return request(url).then((res) => new Promise((resolve, reject) => {
    const expected = Number(res.headers["content-length"]) || 0;
    let got = 0;
    const file = fs.createWriteStream(part);
    const fail = (err) => {
      res.destroy();
      file.destroy();
      fs.rm(part, { force: true }, () => reject(err));
    };
    res.setTimeout?.(NET_IDLE_MS, () => fail(new Error("download parado")));
    res.on("data", (chunk) => { got += chunk.length; });
    res.pipe(file);
    file.on("finish", () => file.close(() => {
      if (expected && got !== expected) {
        fail(new Error("download incompleto"));
        return;
      }
      try {
        fs.renameSync(part, dest);
        resolve();
      } catch (err) {
        reject(err);
      }
    }));
    file.on("error", fail);
    res.on("error", fail);
    res.on("aborted", () => fail(new Error("download interrompido")));
  }));
}

/**
 * Processo filho assíncrono com timeout. Tudo o que converte passava por `execFileSync` no
 * processo principal do Electron: além de congelar a app, um conversor preso (LibreOffice com o
 * perfil bloqueado, ffmpeg à espera de stdin) nunca devolvia erro.
 */
function spawnWait(cmd, args, options = {}) {
  const { timeout = 120000, verbatim = false, env } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        windowsVerbatimArguments: verbatim,
        env: env || process.env,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error(`${path.basename(cmd)} demorou demais e foi cancelado`));
    }, timeout);
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish(err.code === "ENOENT" ? new Error(`${path.basename(cmd)} não encontrado`) : err));
    child.on("exit", (code) => {
      if (code === 0) finish();
      else {
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        finish(new Error(`${path.basename(cmd)} falhou (código ${code})${tail ? `: ${tail.slice(0, 160)}` : ""}`));
      }
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
    fs.mkdirSync(work, { recursive: true });
    /** Download completo fica guardado por versão: uma extração falhada não obriga a baixar ~350 MB de novo. */
    const msi = path.join(work, `LibreOffice_${version}.msi`);
    for (const entry of fs.readdirSync(work)) {
      if (path.join(work, entry) !== msi) fs.rmSync(path.join(work, entry), { recursive: true, force: true });
    }
    if (!fs.existsSync(msi)) {
      const url = `https://download.documentfoundation.org/libreoffice/stable/${version}/win/x86_64/LibreOffice_${version}_Win_x86-64.msi`;
      await downloadFile(url, msi);
    }
    if (onStatus) onStatus("Preparando o conversor de documentos…");
    const dir = path.join(root, "LibreOffice");
    fs.mkdirSync(dir, { recursive: true });
    /**
     * msiexec não usa as regras de aspas do CRT. Com `spawn` normal o Node escapava
     * `TARGETDIR="C:\Users\Globalpac - Dev\…"` como `"TARGETDIR=\"…\""` e, com espaços no caminho
     * do utilizador, o msiexec rejeitava os argumentos: o .msi ficava baixado e a pasta vazia —
     * a cada tentativa a roda voltava a baixar 350 MB e nunca convertia. Linha de comando literal.
     */
    await spawnWait("msiexec.exe", ["/a", `"${msi}"`, "/qn", `TARGETDIR="${dir}"`], {
      verbatim: true,
      timeout: 10 * 60 * 1000,
    });
    hoistNestedLibreOffice(dir);
    if (!fs.existsSync(plannedSoffice())) throw new Error("Não consegui preparar o conversor de documentos");
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

async function convertWithExcel(filePath, dest, to) {
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
  await spawnWait("powershell", ["-NoProfile", "-STA", "-Command", body], {
    env: { ...process.env, VOR_SRC: filePath, VOR_DEST: dest },
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
  await spawnWait("tar", ["-xf", archive, "-C", root], { timeout: 5 * 60 * 1000 });
  fs.rmSync(work, { recursive: true, force: true });
  forgetTools();
  if (!fs.existsSync(magickPath())) throw new Error("Não consegui preparar o conversor de imagens");
}

let ffmpegInstall = null;

function installFfmpeg(onStatus) {
  if (fs.existsSync(ffmpegPath())) return Promise.resolve();
  if (ffmpegInstall) return ffmpegInstall;
  ffmpegInstall = (async () => {
    if (onStatus) onStatus("Baixando o conversor de áudio e vídeo…");
    const root = path.join(dataRoot(), "FFmpeg");
    const work = path.join(dataRoot(), ".ffmpeg-tmp");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(work, "ffmpeg.zip");
    await downloadFile("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", archive);
    if (onStatus) onStatus("Preparando o conversor de áudio e vídeo…");
    await spawnWait("tar", ["-xf", archive, "-C", root], { timeout: 5 * 60 * 1000 });
    fs.rmSync(work, { recursive: true, force: true });
    forgetTools();
    if (!fs.existsSync(ffmpegPath())) throw new Error("Não consegui preparar o conversor de áudio e vídeo");
  })().catch((err) => {
    ffmpegInstall = null;
    throw err;
  });
  return ffmpegInstall;
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
    await spawnWait("tar", ["-xf", archive, "-C", root], { timeout: 5 * 60 * 1000 });
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
      } catch (err) {
        throw new Error(`Não consegui preparar o conversor de imagens (${err.message})`);
      }
      forgetTools();
    }
    if (needsPandoc(id, filePath) && !fs.existsSync(pandocPath())) {
      try {
        await installPandoc(onStatus);
      } catch (err) {
        throw new Error(`Não consegui preparar o conversor de texto (${err.message})`);
      }
      forgetTools();
    }
    const media = kindOf(from);
    if ((media === "audio" || media === "video" || media === "gif") && !fs.existsSync(ffmpegPath())) {
      try {
        await installFfmpeg(onStatus);
      } catch (err) {
        throw new Error(`Não consegui preparar o conversor de áudio e vídeo (${err.message})`);
      }
      forgetTools();
    }
  }
  if (!actionNeedsSoffice(id, filePath)) return;
  const to = id.slice(5);
  if (kindOf(fmtOf(filePath)) === "sheet" && EXCEL_FORMAT[to] !== undefined && hasExcel()) return;
  const current = sofficePath();
  if (current && fs.existsSync(current)) return;
  try {
    await installLibreOffice(onStatus);
  } catch (err) {
    throw new Error(`Não consegui preparar o conversor de documentos (${err.message})`);
  }
  forgetTools();
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
  /** Só o que `run` implementa aparece disponível; o resto era anunciado e depois falhava. */
  if (id === "compress") return kind === "image" ? ok() : no(SOON);
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

async function convertWithPandoc(filePath, dest, to, pandoc) {
  const writer = PANDOC_WRITER[to];
  if (!writer) throw new Error("Esse formato ainda não sai deste arquivo");
  if (to === "pdf" && hasWord()) {
    const tmp = path.join(os.tmpdir(), `vor-${Date.now()}.docx`);
    try {
      await spawnWait(pandoc, [filePath, "-t", "docx", "-o", tmp]);
      await spawnWait("powershell", ["-NoProfile", "-STA", "-Command", `$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open($env:VOR_SRC)
$doc.ExportAsFixedFormat($env:VOR_DEST, 17)
$doc.Close($false)
$word.Quit()`], {
        env: { ...process.env, VOR_SRC: tmp, VOR_DEST: dest },
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!fs.existsSync(dest)) throw new Error("Não consegui gerar o PDF");
    return dest;
  }
  try {
    await spawnWait(pandoc, [filePath, "-t", writer, "-o", dest]);
  } catch (err) {
    if (to === "pdf") throw new Error(`Não consegui gerar o PDF (${err.message})`);
    throw new Error(`A conversão não gerou o arquivo (${err.message})`);
  }
  if (!fs.existsSync(dest)) throw new Error("A conversão não gerou o arquivo");
  return dest;
}

async function run(id, filePath) {
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
      await spawnWait("powershell", ["-NoProfile", "-Command", `
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($env:VOR_SRC)
        $img.Save($env:VOR_DEST, [System.Drawing.Imaging.ImageFormat]::${fmt})
        $img.Dispose()
      `], { env: { ...process.env, VOR_SRC: filePath, VOR_DEST: dest } });
      if (!fs.existsSync(dest)) throw new Error("A conversão não gerou o arquivo");
      return dest;
    }
    if (needsPandoc(id, filePath)) {
      if (!(t.pandoc && fs.existsSync(t.pandoc))) throw new Error("Não consegui preparar o conversor de texto");
      return convertWithPandoc(filePath, dest, to, t.pandoc);
    }
    if (kindOf(from) === "image") {
      if (!(t.magick && fs.existsSync(t.magick))) throw new Error("Conversor de imagens indisponível");
      await spawnWait(t.magick, [filePath, dest]);
      if (!fs.existsSync(dest)) throw new Error("A conversão não gerou o arquivo");
      return dest;
    }
    if (kindOf(from) === "audio" || kindOf(from) === "video" || kindOf(from) === "gif") {
      if (!(t.ffmpeg && fs.existsSync(t.ffmpeg))) throw new Error("Conversor de áudio e vídeo indisponível");
      // -nostdin: sem isto o ffmpeg pode ficar à espera do terminal e nunca terminar.
      await spawnWait(t.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath, dest], {
        timeout: 30 * 60 * 1000,
      });
      if (!fs.existsSync(dest)) throw new Error("A conversão não gerou o arquivo");
      return dest;
    }
    if (kindOf(from) === "sheet" && EXCEL_FORMAT[to] !== undefined && hasExcel()) {
      try {
        return await convertWithExcel(filePath, dest, to);
      } catch (err) {
        if (!(t.soffice && fs.existsSync(t.soffice))) throw err;
      }
    }
    if (t.soffice && fs.existsSync(t.soffice)) {
      /**
       * Perfil próprio: com o perfil padrão, um LibreOffice aberto (ou um lock órfão) faz o
       * `--convert-to` sair sem fazer nada ou ficar pendurado.
       */
      const profile = require("url").pathToFileURL(path.join(dataRoot(), "soffice-profile")).href;
      const args = ["--headless", "--norestore", `-env:UserInstallation=${profile}`];
      if (from === "pdf") args.push("--infilter=writer_pdf_import");
      args.push("--convert-to", to, "--outdir", dir, filePath);
      await spawnWait(t.soffice, args, { timeout: 180000 });
      const produced = path.join(dir, `${stem}.${to}`);
      if (fs.existsSync(dest)) return dest;
      if (fs.existsSync(produced)) return produced;
      throw new Error("A conversão não gerou o arquivo");
    }
    throw new Error("Essa conversão ainda não está disponível");
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
    await spawnWait("powershell", ["-NoProfile", "-Command", `
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile($env:VOR_SRC)
      $img.Save($env:VOR_DEST, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $img.Dispose()
    `], { env: { ...process.env, VOR_SRC: filePath, VOR_DEST: dest } });
    return dest;
  }
  if (id === "tool:extractArchive" && t.tar) {
    const destDir = uniquePath(dir, `${stem}-extract`, "dir").replace(/\.dir$/, "");
    fs.mkdirSync(destDir, { recursive: true });
    await spawnWait(t.tar, ["-xf", filePath, "-C", destDir], { timeout: 10 * 60 * 1000 });
    return destDir;
  }
  throw new Error(SOON);
}

module.exports = { build, pending, run, tools, prepare };
