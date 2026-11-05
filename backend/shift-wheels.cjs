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
    mutool: mutoolPath(),
    tar: which("tar"),
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
/** Callback de progresso do `prepare` em curso (notificações a cada 25%). */
let progressSink = null;

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
    let step = 0;
    res.on("data", (chunk) => {
      got += chunk.length;
      if (!expected || !progressSink) return;
      const now = Math.floor((got / expected) * 4);
      if (now > step && now < 4) {
        step = now;
        progressSink(`Baixando ${path.basename(dest).replace(/\.part$/, "")}… ${now * 25}% de ${Math.round(expected / 1048576)} MB`);
      }
    });
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
  const { timeout = 120000, verbatim = false, env, cwd } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        windowsVerbatimArguments: verbatim,
        env: env || process.env,
        cwd,
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
        const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
        const tail = /powershell/i.test(cmd) ? lines[0] : lines.pop();
        finish(new Error(`${path.basename(cmd)} falhou (código ${code})${tail ? `: ${tail.slice(0, 160)}` : ""}`));
      }
    });
  });
}

function pdfLocked(err) {
  return /password|authenticate|encrypted|cannot draw/i.test(String(err && err.message));
}

function withPassword(args, password) {
  const next = args.slice();
  next.splice(1, 0, "-p", password);
  return next;
}

/** Diálogo simples para pedir a senha do PDF. Cancela → null. */
function askPdfPassword(filePath, attempt) {
  const { BrowserWindow } = require("electron");
  const name = path.basename(filePath);
  const hint = attempt > 1 ? "Senha incorreta. Tenta outra." : "Este PDF está protegido por senha.";
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 380,
      height: 168,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: "#151515",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
      resolve(value);
    };
    win.once("closed", () => finish(null));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("ipc-message", (_event, channel, payload) => {
      if (channel === "vor-pdf-password") finish(typeof payload === "string" ? payload : null);
    });
    // sandbox sem preload: usa executeJavaScript + console-message como canal simples
    win.webContents.on("console-message", (_event, _level, message) => {
      if (typeof message !== "string" || !message.startsWith("VOR_PDF_PW:")) return;
      const raw = message.slice("VOR_PDF_PW:".length);
      finish(raw === "__cancel__" ? null : raw);
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#151515;color:#eee;font:13px/1.35 "Segoe UI",sans-serif}
      main{padding:16px 18px;display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box}
      h1{margin:0;font-size:14px;font-weight:600}
      p{margin:0;color:rgba(255,255,255,.72)}
      strong{color:#fff;font-weight:600}
      input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid rgba(255,255,255,.18);
        border-radius:8px;background:#0f0f0f;color:#fff;outline:none}
      input:focus{border-color:rgba(255,255,255,.4)}
      .row{display:flex;gap:8px;justify-content:flex-end;margin-top:auto}
      button{height:30px;padding:0 14px;border:0;border-radius:8px;cursor:pointer;font:inherit}
      .cancel{background:transparent;color:rgba(255,255,255,.8)}
      .ok{background:#fff;color:#111;font-weight:600}
    </style></head><body><main>
      <h1>PDF protegido</h1>
      <p>${hint.replace(/</g, "")} <strong>${name.replace(/[<>&"]/g, "")}</strong></p>
      <input id="pw" type="password" autofocus placeholder="Senha" />
      <div class="row">
        <button class="cancel" type="button" id="cancel">Cancelar</button>
        <button class="ok" type="button" id="ok">Desbloquear</button>
      </div>
    </main><script>
      const send = (v) => console.log("VOR_PDF_PW:" + (v == null ? "__cancel__" : v));
      const input = document.getElementById("pw");
      document.getElementById("cancel").onclick = () => send(null);
      document.getElementById("ok").onclick = () => send(input.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") send(input.value);
        if (e.key === "Escape") send(null);
      });
    </script></body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
      }
    }).catch(() => finish(null));
  });
}

/** Tenta sem senha, depois senha vazia (faturas), depois pede a senha ao utilizador. */
async function mutoolRun(args, options) {
  const bin = need("mutool");
  const fileHint = args.find((part) => typeof part === "string" && /\.pdf$/i.test(part)) || "";
  try {
    await spawnWait(bin, args, options);
    return;
  } catch (err) {
    if (!pdfLocked(err)) throw err;
  }
  try {
    await spawnWait(bin, withPassword(args, ""), options);
    return;
  } catch (err) {
    if (!pdfLocked(err)) throw err;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await askPdfPassword(fileHint || "documento.pdf", attempt);
    if (password == null) throw new Error("Senha cancelada");
    try {
      await spawnWait(bin, withPassword(args, password), options);
      return;
    } catch (err) {
      if (!pdfLocked(err)) throw err;
      if (attempt === 3) throw new Error("Este PDF está protegido por senha");
    }
  }
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

/**
 * Excel só para planilha binária → PDF (layout de impressão fiel). CSV/TSV ficam com o LibreOffice:
 * o Excel segue a região do Windows (";" no pt-BR) ao ler e ao gravar CSV.
 */
function excelHandles(from, to) {
  return (from === "xlsx" || from === "xls" || from === "ods") && to === "pdf" && hasExcel();
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

let mutoolInstall = null;

/** MuPDF `mutool`: PDF → imagem/texto/HTML e compressão de PDF. Substitui o Ghostscript (sem instalador, um único .exe). */
function mutoolPath() {
  const onPath = which("mutool");
  if (onPath && fs.existsSync(onPath)) return onPath;
  return findExe(path.join(dataRoot(), "MuPDF"), "mutool.exe") || path.join(dataRoot(), "MuPDF", "mutool.exe");
}

function installMutool(onStatus) {
  if (fs.existsSync(mutoolPath())) return Promise.resolve();
  if (mutoolInstall) return mutoolInstall;
  mutoolInstall = (async () => {
    if (onStatus) onStatus("Baixando o conversor de PDF…");
    let version = "1.28.5";
    try {
      const html = await readText("https://mupdf.com/releases");
      const found = [...html.matchAll(/mupdf-(\d+\.\d+\.\d+)-windows\.zip/g)].map((m) => m[1].split(".").map(Number));
      found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      if (found.length) version = found[found.length - 1].join(".");
    } catch { /* versão conhecida */ }
    const root = path.join(dataRoot(), "MuPDF");
    const work = path.join(dataRoot(), ".mupdf-tmp");
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const archive = path.join(work, "mupdf.zip");
    await downloadFile(`https://mupdf.com/downloads/archive/mupdf-${version}-windows.zip`, archive);
    if (onStatus) onStatus("Preparando o conversor de PDF…");
    // Só o mutool.exe: os visualizadores (mupdf.exe, mupdf-gl.exe) não são usados.
    await spawnWait("tar", ["-xf", archive, "-C", root, `mupdf-${version}-windows/mutool.exe`], { timeout: 5 * 60 * 1000 });
    fs.rmSync(work, { recursive: true, force: true });
    forgetTools();
    if (!fs.existsSync(mutoolPath())) throw new Error("Não consegui preparar o conversor de PDF");
  })().catch((err) => {
    mutoolInstall = null;
    throw err;
  });
  return mutoolInstall;
}

const INSTALLERS = {
  magick: { path: () => magickPath(), install: (s) => installMagick(s), label: "imagens" },
  ffmpeg: { path: () => ffmpegPath(), install: (s) => installFfmpeg(s), label: "áudio e vídeo" },
  soffice: { path: () => sofficePath(), install: (s) => installLibreOffice(s), label: "documentos" },
  pandoc: { path: () => pandocPath(), install: (s) => installPandoc(s), label: "texto" },
  mutool: { path: () => mutoolPath(), install: (s) => installMutool(s), label: "PDF" },
};

function fmtOf(file) {
  let e = path.extname(file).slice(1).toLowerCase();
  if (e === "jpeg" || e === "jfif") e = "jpg";
  if (e === "tif") e = "tiff";
  if (e === "htm") e = "html";
  if (e === "markdown") e = "md";
  if (e === "tgz") e = "gz";
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

/**
 * Destinos por tipo. Só entra o que o VOR consegue gerar de verdade; formatos que não se
 * podem escrever (PAGES/KEY são da Apple) ou que não fazem sentido (PDF → XLSX) ficam fora da
 * roda em vez de aparecerem como "em breve".
 */
function targets(kind, fmt) {
  const table = {
    image: ["jpg", "png", "webp", "heic", "tiff", "avif", "bmp", "pdf"],
    audio: ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff", "wma"],
    video: ["mp4", "mov", "mkv", "webm", "avi", "wmv", "gif", "mp3"],
    gif: ["mp4", "mov", "mkv", "webm", "avi", "wmv"],
    pdf: ["docx", "pptx", "jpg", "png", "epub", "txt", "md", "html"],
    slides: ["pdf", "pptx", "jpg", "png"],
    sheet: ["xlsx", "ods", "csv", "tsv", "pdf"],
    doc: ["docx", "pdf", "txt", "md", "html", "epub", "png", "jpg"],
    epub: ["pdf", "docx", "txt", "md", "html"],
    txt: ["docx", "pdf", "md", "html", "epub", "jpg", "png"],
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

/** Ferramentas necessárias para uma ação. Todas são baixadas sozinhas em `prepare`. */
function toolsFor(id, filePath) {
  const from = fmtOf(filePath);
  const kind = kindOf(from);
  const need = new Set();
  if (id.startsWith("conv:")) {
    const to = id.slice(5);
    if (kind === "image") {
      if (!nativeConvertible(from, to)) need.add("magick");
    } else if (kind === "audio" || kind === "video" || kind === "gif") {
      need.add("ffmpeg");
    } else if (kind === "pdf") {
      if (to === "docx" || to === "pptx") need.add("soffice");
      else need.add("mutool");
      if (to === "epub" || to === "md") need.add("pandoc");
    } else if (kind === "doc" || kind === "txt" || kind === "slides" || kind === "sheet" || kind === "epub") {
      const viaPandoc = kind === "epub" || from === "md" || to === "md" || to === "epub";
      if (viaPandoc) need.add("pandoc");
      if (!viaPandoc || to === "pdf" || to === "png" || to === "jpg" || (from === "doc" || from === "pages" || from === "rtf")) need.add("soffice");
      if (excelHandles(from, to)) need.delete("soffice");
      if (to === "png" || to === "jpg") need.add("mutool");
    }
  } else if (id.startsWith("tool:")) {
    const tool = id.slice(5);
    if (kind === "pdf") need.add("mutool");
    else if (kind === "image" && !["compress", "resize50", "resize1080", "rotate90", "cropImage", "redactImage", "editImage", "annotateImage", "frameImage"].includes(tool)) need.add("magick");
    else if (kind === "audio" || kind === "video" || kind === "gif") need.add("ffmpeg");
  }
  return [...need];
}

async function prepare(id, filePath, onStatus) {
  for (const name of toolsFor(id, filePath)) {
    const entry = INSTALLERS[name];
    if (fs.existsSync(entry.path())) continue;
    progressSink = onStatus || null;
    try {
      await entry.install(onStatus);
      if (onStatus) onStatus(`Conversor de ${entry.label} pronto — convertendo…`);
    } catch (err) {
      throw new Error(`Não consegui preparar o conversor de ${entry.label} (${err.message})`);
    } finally {
      progressSink = null;
    }
    forgetTools();
  }
}

function toolTitle(id) {
  const map = {
    compress: "COMPRESS", removeMetadata: "METADATA", normalizeAudio: "NORMALIZE", muteVideo: "MUTE",
    splitPDF: "SPLIT", extractArchive: "EXTRACT", videoSnapshots: "SNAPSHOT", audioChannels: "CHANNELS",
    resize50: "50%", resize1080: "1080P", rotate90: "GIRAR",
    redactImage: "REDACT", redactVideo: "REDACT", redactAudio: "BLEEP",
    cropImage: "CROP", cropVideo: "CROP", editImage: "EDIT", annotateImage: "ANNOTATE", frameImage: "ADD BG",
    trimVideo: "TRIM", trimAudio: "TRIM", splitVideo: "SPLIT", changeVideoSpeed: "SPEED",
    organizePDF: "ORGANIZE", audioToVideo: "VISUALIZE",
    airDrop: "SHARE", float: "FLOAT", copy: "COPY", move: "MOVE", copyPath: "COPY PATH", openTerminal: "TERMINAL",
  };
  return map[id] || "?";
}

/** Ferramentas que abrem o estúdio antes de gravar o arquivo. */
const STUDIO = new Set([
  "cropImage", "redactImage", "editImage", "annotateImage", "frameImage",
  "cropVideo", "redactVideo", "trimVideo", "splitVideo", "changeVideoSpeed", "videoSnapshots",
  "trimAudio", "redactAudio", "audioToVideo",
  "organizePDF", "splitPDF",
]);

function needsStudio(id) {
  return id.startsWith("tool:") && STUDIO.has(id.slice(5));
}

/** Pétalas da roda de ferramentas. As que precisam de tela estão em STUDIO. */
function toolIds(kind, fmt) {
  if (kind === "image" && fmt === "svg") return [];
  if (kind === "image") return ["compress", "redactImage", "removeMetadata", "cropImage", "editImage", "frameImage", "annotateImage", "resize50", "resize1080", "rotate90"];
  if (kind === "audio") return ["compress", "redactAudio", "removeMetadata", "audioChannels", "normalizeAudio", "trimAudio", "audioToVideo"];
  if (kind === "video") return ["compress", "redactVideo", "removeMetadata", "splitVideo", "muteVideo", "videoSnapshots", "changeVideoSpeed", "cropVideo", "trimVideo"];
  if (kind === "gif") return ["removeMetadata"];
  if (kind === "pdf") return ["compress", "organizePDF", "removeMetadata", "splitPDF"];
  if (kind === "archive") return ["extractArchive"];
  return [];
}

function toolGate() {
  return ok();
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
  const fmt = fmtOf(filePath);
  const kind = kindOf(fmt);
  let items = [];
  if (mode === "convert") {
    items = targets(kind, fmt).map((to) => item(`conv:${to}`, titleOf(to), ok()));
  } else if (mode === "tools") {
    items = toolIds(kind, fmt).map((id) => item(`tool:${id}`, toolTitle(id), toolGate(id)));
  } else {
    items = ["airDrop", "float", "copy", "move", "copyPath", "openTerminal"].map((id) =>
      item(`act:${id}`, toolTitle(id), toolGate(id)),
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

function uniqueDir(dir, name) {
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${name} (${n})`);
    n += 1;
  }
  return candidate;
}

function scratch() {
  // realpath: o TEMP pode vir em 8.3 (GLOBAL~1) e o GDI+ não abre esses caminhos.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vor-conv-")));
}

function exists(file, what = "A conversão não gerou o arquivo") {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(what);
  return file;
}

function need(name) {
  const p = INSTALLERS[name].path();
  if (!fs.existsSync(p)) throw new Error(`Conversor de ${INSTALLERS[name].label} indisponível`);
  return p;
}

/** Filtros explícitos onde o padrão do LibreOffice erra (CSV UTF-8, TSV, texto UTF-8, PDF → slides). */
const SOFFICE_FILTER = {
  csv: 'csv:Text - txt - csv (StarCalc):44,34,76,1',
  tsv: 'csv:Text - txt - csv (StarCalc):9,34,76,1',
  txt: "txt:Text (encoded):UTF8",
  html: "html:XHTML Writer File:UTF8",
};

/** LibreOffice headless com perfil próprio; devolve o arquivo gerado em `outDir`. */
async function soffice(input, to, outDir, { infilter } = {}) {
  const bin = need("soffice");
  const profile = require("url").pathToFileURL(path.join(dataRoot(), "soffice-profile")).href;
  const args = ["--headless", "--norestore", `-env:UserInstallation=${profile}`];
  if (infilter) args.push(`--infilter=${infilter}`);
  // CSV/TSV de entrada: separador explícito, UTF-8, independente da região do Windows.
  const src = fmtOf(input);
  if (!infilter && (src === "csv" || src === "tsv")) args.push(`--infilter=CSV:${src === "tsv" ? 9 : 44},34,76,1`);
  args.push("--convert-to", SOFFICE_FILTER[to] || to, "--outdir", outDir, input);
  await spawnWait(bin, args, { timeout: 180000 });
  const ext = to === "tsv" ? "csv" : to;
  return exists(path.join(outDir, `${path.parse(input).name}.${ext}`));
}

async function pandoc(input, to, out, from) {
  const writer = { txt: "plain", html: "html", docx: "docx", epub: "epub", md: "gfm", odt: "odt", rtf: "rtf" }[to];
  if (!writer) throw new Error("Formato de saída não suportado");
  const args = [input];
  if (from) args.push("-f", from);
  args.push("-t", writer, "-s", "-o", out);
  await spawnWait(need("pandoc"), args, { cwd: path.dirname(input) });
  return exists(out);
}

/** Leitores do pandoc por extensão. Os que ele não lê passam antes pelo LibreOffice (→ DOCX). */
const PANDOC_READER = { md: "markdown", txt: "markdown", html: "html", docx: "docx", odt: "odt", epub: "epub", rtf: "rtf" };

async function toPandocSource(filePath, tmp) {
  const from = fmtOf(filePath);
  if (PANDOC_READER[from]) return { file: filePath, reader: PANDOC_READER[from] };
  return { file: await soffice(filePath, "docx", tmp), reader: "docx" };
}

/** Qualquer documento → PDF. Markdown/EPUB vão por DOCX (pandoc) e depois LibreOffice; sem Word nem LaTeX. */
async function toPdf(filePath, tmp) {
  const from = fmtOf(filePath);
  if (from === "pdf") return filePath;
  if (from === "md" || from === "epub") {
    const docx = await pandoc(filePath, "docx", path.join(tmp, "doc.docx"), PANDOC_READER[from]);
    return soffice(docx, "pdf", tmp);
  }
  return soffice(filePath, "pdf", tmp);
}

/** PDF → PNG/JPG: uma página vira um arquivo; várias páginas viram uma pasta com uma imagem por página. */
async function pdfToImages(pdf, to, dir, stem) {
  const tmp = scratch();
  try {
    await mutoolRun(["draw", "-r", "300", "-o", path.join(tmp, "p-%d.png"), pdf], { timeout: 300000 });
    const pages = fs.readdirSync(tmp).filter((f) => /^p-\d+\.png$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (!pages.length) throw new Error("O PDF não tem páginas");
    const convertOne = async (src, dest) => {
      if (to === "png") fs.copyFileSync(src, dest);
      else await nativeImage(src, dest, "jpg");
      return dest;
    };
    if (pages.length === 1) return await convertOne(path.join(tmp, pages[0]), uniquePath(dir, stem, to));
    const outDir = uniqueDir(dir, `${stem} (${to.toUpperCase()})`);
    fs.mkdirSync(outDir, { recursive: true });
    for (let i = 0; i < pages.length; i += 1) {
      await convertOne(path.join(tmp, pages[i]), path.join(outDir, `${stem}-${String(i + 1).padStart(3, "0")}.${to}`));
    }
    return outDir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** PNG/JPG/BMP/GIF/TIFF entre si com o System.Drawing do próprio Windows (sem download). */
async function nativeImage(src, dest, to) {
  const fmt = { jpg: "Jpeg", png: "Png", bmp: "Bmp", gif: "Gif", tiff: "Tiff" }[to];
  await spawnWait("powershell", ["-NoProfile", "-Command", `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($env:VOR_SRC)
    try {
      if ('${fmt}' -eq 'Jpeg') {
        $bmp = New-Object System.Drawing.Bitmap $img.Width, $img.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::White)
        $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
        $g.Dispose()
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $p = New-Object System.Drawing.Imaging.EncoderParameters 1
        $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]90)
        $bmp.Save($env:VOR_DEST, $codec, $p)
        $bmp.Dispose()
      } else {
        $img.Save($env:VOR_DEST, [System.Drawing.Imaging.ImageFormat]::${fmt})
      }
    } finally { $img.Dispose() }
  `], { env: { ...process.env, VOR_SRC: src, VOR_DEST: dest } });
  return exists(dest);
}

function srtTime(t) { return t.replace(".", ","); }
function vttTime(t) { return t.replace(",", "."); }

function convertSubtitle(filePath, dest, to) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
    .filter((b) => !/^WEBVTT/.test(b) && !/^(NOTE|STYLE|REGION)\b/.test(b));
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [start, end] = lines[at].split("-->").map((s) => s.trim().split(/\s+/)[0]);
    cues.push({ start, end, body: lines.slice(at + 1).join("\n") });
  }
  if (!cues.length) throw new Error("Nenhuma legenda encontrada no arquivo");
  let out;
  if (to === "vtt") out = `WEBVTT\n\n${cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.body}`).join("\n\n")}\n`;
  else if (to === "srt") out = `${cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.body}`).join("\n\n")}\n`;
  else out = `${cues.map((c) => c.body.replace(/<[^>]+>/g, "")).join("\n")}\n`;
  fs.writeFileSync(dest, out, "utf8");
  return dest;
}

async function convertArchive(filePath, dest, to) {
  const tmp = scratch();
  try {
    const content = path.join(tmp, "x");
    fs.mkdirSync(content);
    await spawnWait("tar", ["-xf", filePath, "-C", content], { timeout: 10 * 60 * 1000 });
    const args = to === "zip" ? ["-a", "-cf", dest] : to === "gz" ? ["-czf", dest] : ["-cf", dest];
    await spawnWait("tar", [...args, "-C", content, "."], { timeout: 10 * 60 * 1000 });
    return exists(dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function convert(filePath, to) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const from = fmtOf(filePath);
  const kind = kindOf(from);
  const dest = uniquePath(dir, stem, to === "gz" ? "tar.gz" : to);

  if (kind === "image") {
    if (nativeConvertible(from, to)) return nativeImage(filePath, dest, to === "tif" ? "tiff" : to);
    // [0]: primeira camada/quadro (PSD, ICO, GIF animado) — evita vários arquivos de saída.
    await spawnWait(need("magick"), [`${filePath}[0]`, ...(to === "jpg" ? ["-background", "white", "-flatten", "-quality", "90"] : []), dest]);
    return exists(dest);
  }
  if (kind === "audio" || kind === "video" || kind === "gif") {
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath];
    if (to === "mp3") args.push("-vn", "-b:a", "192k");
    if (to === "gif") args.push("-vf", "fps=12,scale='min(640,iw)':-2:flags=lanczos");
    if (kind === "gif" || to === "mp4" || to === "mov") args.push("-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    await spawnWait(need("ffmpeg"), [...args, dest], { timeout: 30 * 60 * 1000 });
    return exists(dest);
  }
  if (kind === "subtitle") return convertSubtitle(filePath, dest, to);
  if (kind === "archive") return convertArchive(filePath, dest, to);

  const tmp = scratch();
  try {
    const finish = (produced) => {
      if (fs.statSync(produced).isDirectory()) return produced;
      fs.copyFileSync(produced, dest);
      return exists(dest);
    };
    if (kind === "pdf") {
      if (to === "png" || to === "jpg") return await pdfToImages(filePath, to, dir, stem);
      if (to === "docx") return finish(await soffice(filePath, "docx", tmp, { infilter: "writer_pdf_import" }));
      if (to === "pptx") return finish(await soffice(filePath, "pptx", tmp, { infilter: "impress_pdf_import" }));
      // Texto real do PDF; um PDF que é só imagem (cartaz escaneado/exportado) não tem nada a extrair.
      const text = path.join(tmp, "doc.txt");
      await mutoolRun(["convert", "-F", "text", "-o", text, filePath], { timeout: 300000 });
      if (!fs.existsSync(text) || !fs.readFileSync(text, "utf8").trim()) {
        throw new Error("Este PDF não tem texto (é só imagem). Use PNG/JPG ou DOCX/PPTX");
      }
      if (to === "txt") return finish(text);
      const html = path.join(tmp, "doc.html");
      await mutoolRun(["convert", "-F", "html", "-o", html, filePath], { timeout: 300000 });
      exists(html);
      if (to === "html") return finish(html);
      return await pandoc(html, to, dest, "html");
    }
    if (excelHandles(from, to)) {
      try {
        return await convertWithExcel(filePath, dest, to);
      } catch (err) {
        if (!fs.existsSync(sofficePath())) throw err;
      }
    }
    if (to === "png" || to === "jpg") return await pdfToImages(await toPdf(filePath, tmp), to, dir, stem);
    if (to === "pdf") return finish(await toPdf(filePath, tmp));
    if (kind === "epub" || from === "md" || to === "md" || to === "epub") {
      const source = await toPandocSource(filePath, tmp);
      return await pandoc(source.file, to, dest, source.reader);
    }
    return finish(await soffice(filePath, to, tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runTool(tool, filePath) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const from = fmtOf(filePath);
  const kind = kindOf(from);
  const ext = path.extname(filePath).slice(1) || "bin";
  const ff = (args, dest) => spawnWait(need("ffmpeg"), ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath, ...args, dest], { timeout: 30 * 60 * 1000 }).then(() => exists(dest));
  if (tool === "extractArchive") {
    const destDir = uniqueDir(dir, `${stem}-extract`);
    fs.mkdirSync(destDir, { recursive: true });
    if (from === "rar" || from === "7z") {
      const seven = which("7z") || which("7za");
      if (!seven) {
        fs.rmSync(destDir, { recursive: true, force: true });
        throw new Error("Para abrir RAR ou 7z, instala o 7-Zip");
      }
      await spawnWait(seven, ["x", "-y", `-o${destDir}`, filePath], { timeout: 10 * 60 * 1000 });
    } else {
      await spawnWait("tar", ["-xf", filePath, "-C", destDir], { timeout: 10 * 60 * 1000 });
    }
    return destDir;
  }
  if (kind === "pdf") {
    if (tool === "compress" || tool === "removeMetadata") {
      const dest = uniquePath(dir, `${stem}-${tool === "compress" ? "compressed" : "clean"}`, "pdf");
      // compress: reamostra imagens acima de 150 dpi para 150 dpi e recomprime em JPEG (q75), só se ficar menor.
      const args = tool === "compress"
        ? ["clean", "-gggg", "-z", "-f", "-i", "-Z", "-m",
          "--color-image-subsample-dpi", "200,150", "--gray-image-subsample-dpi", "200,150",
          "--color-image-recompress-method", "jpeg:75", "--gray-image-recompress-method", "jpeg:75"]
        : ["clean", "-gg", "-z"];
      await mutoolRun([...args, filePath, dest], { timeout: 300000 });
      exists(dest);
      if (tool === "compress" && fs.statSync(dest).size >= fs.statSync(filePath).size) {
        fs.rmSync(dest, { force: true });
        throw new Error("Este PDF já está otimizado — não deu para reduzir mais");
      }
      return dest;
    }
    if (tool === "splitPDF") {
      const outDir = uniqueDir(dir, `${stem} (páginas)`);
      fs.mkdirSync(outDir, { recursive: true });
      const tmp = scratch();
      try {
        await mutoolRun(["draw", "-F", "txt", "-o", path.join(tmp, "p-%d.txt"), filePath], { timeout: 300000 });
        const count = fs.readdirSync(tmp).length;
        for (let i = 1; i <= count; i += 1) {
          await mutoolRun(["merge", "-o", path.join(outDir, `${stem}-${String(i).padStart(3, "0")}.pdf`), filePath, String(i)]);
        }
        if (!fs.readdirSync(outDir).length) throw new Error("O PDF não tem páginas");
      } catch (err) {
        fs.rmSync(outDir, { recursive: true, force: true });
        throw err;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return outDir;
    }
  }
  if (kind === "image") {
    if (tool === "compress") {
      const dest = uniquePath(dir, `${stem}-compressed`, "jpg");
      return nativeConvertible(from, "jpg")
        ? nativeImage(filePath, dest, "jpg")
        : spawnWait(need("magick"), [`${filePath}[0]`, "-background", "white", "-flatten", "-quality", "80", dest]).then(() => exists(dest));
    }
    if (tool === "removeMetadata") {
      const dest = uniquePath(dir, `${stem}-clean`, ext);
      await spawnWait(need("magick"), [filePath, "-strip", dest]);
      return exists(dest);
    }
    if (tool === "resize50" || tool === "resize1080" || tool === "rotate90") {
      const dest = uniquePath(dir, `${stem}-${tool === "rotate90" ? "rotated" : tool}`, "png");
      const sharp = require("sharp");
      const input = sharp(filePath, { failOn: "none" }).rotate();
      if (tool === "rotate90") await input.rotate(90).png().toFile(dest);
      else if (tool === "resize50") {
        const meta = await input.metadata();
        const width = Math.max(1, Math.round((meta.width || 1) * 0.5));
        await input.resize({ width }).png().toFile(dest);
      } else {
        await input.resize({ height: 1080, withoutEnlargement: true }).png().toFile(dest);
      }
      return exists(dest);
    }
  }
  if (kind === "audio" || kind === "video" || kind === "gif") {
    if (tool === "removeMetadata") return ff(["-map_metadata", "-1", "-c", "copy"], uniquePath(dir, `${stem}-clean`, ext));
    if (tool === "compress" && kind === "audio") return ff(["-vn", "-b:a", "128k"], uniquePath(dir, `${stem}-compressed`, "mp3"));
    if (tool === "compress") return ff(["-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p"], uniquePath(dir, `${stem}-compressed`, "mp4"));
    if (tool === "normalizeAudio") return ff(["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"], uniquePath(dir, `${stem}-normalized`, ext));
    if (tool === "audioChannels") return ff(["-ac", "1"], uniquePath(dir, `${stem}-mono`, ext));
    if (tool === "muteVideo") return ff(["-c:v", "copy", "-an"], uniquePath(dir, `${stem}-mute`, ext));
    if (tool === "videoSnapshots") {
      const outDir = uniqueDir(dir, `${stem} (snapshots)`);
      fs.mkdirSync(outDir, { recursive: true });
      await spawnWait(need("ffmpeg"), ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath, "-vf", "fps=1/5", path.join(outDir, `${stem}-%03d.png`)], { timeout: 30 * 60 * 1000 });
      return outDir;
    }
  }
  throw new Error("Essa ferramenta ainda não está disponível para este arquivo");
}

async function run(id, filePath) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  if (id.startsWith("conv:")) return convert(filePath, id.slice(5));
  if (id.startsWith("tool:")) {
    const tool = id.slice(5);
    if (tool === "copy") return run("act:copy", filePath);
    return runTool(tool, filePath);
  }
  if (id === "act:copy") {
    const dest = uniquePath(dir, stem, path.extname(filePath).slice(1) || "bin");
    fs.copyFileSync(filePath, dest);
    return dest;
  }
  if (id === "act:move") {
    const dest = uniquePath(dir, stem, path.extname(filePath).slice(1) || "bin");
    fs.renameSync(filePath, dest);
    return dest;
  }
  if (id === "act:copyPath") return filePath;
  if (id === "act:openTerminal") {
    spawn("cmd", ["/C", "start", "cmd", "/K", `cd /d "${dir}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
    return dir;
  }
  throw new Error("Essa ação ainda não está disponível");
}

function writePng(dataUrl, dest) {
  const body = String(dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
  if (!body) throw new Error("O estúdio não devolveu a imagem");
  fs.writeFileSync(dest, Buffer.from(body, "base64"));
  return exists(dest);
}

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 0));
  return v - (v % 2);
}

async function applyStudio(id, filePath, spec) {
  const tool = String(id || "").slice(5);
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const ext = path.extname(filePath).slice(1) || "bin";
  const job = spec || {};
  if (job.png) return writePng(job.png, uniquePath(dir, `${stem}-${tool}`, "png"));
  const ff = (args, dest) => spawnWait(need("ffmpeg"), ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args, dest], { timeout: 30 * 60 * 1000 }).then(() => exists(dest));
  const start = Math.max(0, Number(job.start) || 0);
  const end = Math.max(start, Number(job.end) || 0);
  if (tool === "trimVideo" || tool === "trimAudio") {
    return ff(["-i", filePath, "-ss", String(start), "-to", String(end || start + 0.2), "-c", "copy"], uniquePath(dir, `${stem}-trim`, ext));
  }
  if (tool === "changeVideoSpeed") {
    const rate = Math.min(2, Math.max(0.5, Number(job.rate) || 1));
    return ff(["-i", filePath, "-filter:v", `setpts=PTS/${rate}`, "-filter:a", `atempo=${rate}`], uniquePath(dir, `${stem}-speed`, "mp4"));
  }
  if (tool === "videoSnapshots") {
    const dest = uniquePath(dir, `${stem}-snapshot`, "png");
    return ff(["-ss", String(start), "-i", filePath, "-frames:v", "1"], dest);
  }
  if (tool === "splitVideo") {
    const at = Math.max(0.1, Number(job.at) || 1);
    const a = uniquePath(dir, `${stem}-part1`, ext);
    const b = uniquePath(dir, `${stem}-part2`, ext);
    await ff(["-i", filePath, "-t", String(at), "-c", "copy"], a);
    await ff(["-ss", String(at), "-i", filePath, "-c", "copy"], b);
    return a;
  }
  if (tool === "cropVideo" || tool === "redactVideo") {
    const w = even(job.w);
    const h = even(job.h);
    const x = Math.max(0, Math.round(Number(job.x) || 0));
    const y = Math.max(0, Math.round(Number(job.y) || 0));
    const filter = tool === "cropVideo" ? `crop=${w}:${h}:${x}:${y}` : `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
    return ff(["-i", filePath, "-vf", filter, "-c:a", "copy"], uniquePath(dir, `${stem}-${tool === "cropVideo" ? "crop" : "redact"}`, "mp4"));
  }
  if (tool === "redactAudio") {
    const dur = Math.max(0.2, (end || start + 0.2) - start);
    const delay = Math.round(start * 1000);
    const dest = uniquePath(dir, `${stem}-bleep`, ext);
    await spawnWait(need("ffmpeg"), [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-i", filePath,
      "-filter_complex",
      `[0:a]volume=0:enable='between(t,${start},${start + dur})'[m];sine=frequency=880:duration=${dur},adelay=${delay}|${delay}[b];[m][b]amix=inputs=2:duration=first:dropout_transition=0`,
      dest,
    ], { timeout: 30 * 60 * 1000 });
    return exists(dest);
  }
  if (tool === "audioToVideo") {
    const dest = uniquePath(dir, `${stem}-wave`, "png");
    return ff(["-i", filePath, "-filter_complex", "showwavespic=s=1280x360:colors=white", "-frames:v", "1"], dest);
  }
  if (tool === "splitPDF") {
    const range = String(job.range || "1-N").trim();
    const dest = uniquePath(dir, `${stem}-split`, "pdf");
    await mutoolRun(["merge", "-o", dest, filePath, range], { timeout: 300000 });
    return exists(dest);
  }
  if (tool === "organizePDF") {
    const pages = (Array.isArray(job.pages) ? job.pages : [])
      .map((p) => ({ index: Math.max(1, Math.round(Number(p.index) || 0)), rotate: ((Math.round((Number(p.rotate) || 0) / 90) * 90) % 360 + 360) % 360 }));
    if (!pages.length) throw new Error("Nenhuma página ficou na seleção");
    const dest = uniquePath(dir, `${stem}-organized`, "pdf");
    const tmp = scratch();
    try {
      // Sem rasterizar: copia as páginas originais (texto, vetores, links) na nova ordem e só ajusta /Rotate.
      const script = path.join(tmp, "organize.js");
      fs.writeFileSync(script, ORGANIZE_JS, "utf8");
      const plan = path.join(tmp, "plan.json");
      fs.writeFileSync(plan, JSON.stringify(pages), "utf8");
      await mutoolRun(["run", script, filePath, plan, dest], { timeout: 300000 });
      return exists(dest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error("Essa ferramenta ainda não está disponível para este arquivo");
}

/** Script do `mutool run`: reordena, gira e remove páginas sem perder qualidade. */
const ORGANIZE_JS = `
var src = Document.openDocument(scriptArgs[0]);
var pdf = src.asPDF ? src.asPDF() : src;
var plan = JSON.parse(read(scriptArgs[1]));
var out = new PDFDocument();
for (var i = 0; i < plan.length; i++) {
  out.graftPage(-1, pdf, plan[i].index - 1);
  if (plan[i].rotate) {
    var base = 0;
    try {
      var r = pdf.findPage(plan[i].index - 1).getInheritable("Rotate");
      if (r && r.isNumber()) base = r.valueOf();
    } catch (e) {}
    out.findPage(out.countPages() - 1).put("Rotate", ((base + plan[i].rotate) % 360 + 360) % 360);
  }
}
out.save(scriptArgs[2], "garbage,compress");
`;

async function studioPages(filePath) {
  const tmp = scratch();
  await mutoolRun(["draw", "-r", "28", "-o", path.join(tmp, "p-%d.png"), filePath], { timeout: 300000 });
  // Ordem numérica: "p-10" vem depois de "p-9", não depois de "p-1".
  const pages = fs.readdirSync(tmp).filter((name) => /^p-\d+\.png$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
    .map((name) => path.join(tmp, name));
  return { tmp, pages };
}

module.exports = { build, pending, run, tools, prepare, targets, toolsFor, kindOf, fmtOf, needsStudio, applyStudio, studioPages };
