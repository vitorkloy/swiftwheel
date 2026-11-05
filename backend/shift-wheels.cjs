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
  const { timeout = 120000, verbatim = false, env, cwd, onStdout, onStderr } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ["ignore", onStdout ? "pipe" : "ignore", "pipe"],
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
    if (onStdout) child.stdout.on("data", (chunk) => { try { onStdout(chunk.toString("utf8")); } catch { /* ignore */ } });
    child.stderr.on("data", (chunk) => {
      if (onStderr) { try { onStderr(chunk.toString("utf8")); } catch { /* ignore */ } }
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

/** Progresso do trabalho atual (0..1), ligado por `run`/`applyStudio` ao toast do Electron. */
let jobProgress = null;

/** Duração em segundos, lida do cabeçalho que o ffmpeg imprime (sem precisar de ffprobe). */
function mediaDuration(file) {
  return new Promise((resolve) => {
    let text = "";
    let child;
    try { child = spawn(need("ffmpeg"), ["-hide_banner", "-i", file], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); } catch { resolve(0); return; }
    child.stderr.on("data", (c) => { if (text.length < 20000) text += c.toString("utf8"); });
    const done = () => {
      const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    };
    child.on("exit", done);
    child.on("error", () => resolve(0));
  });
}

/** ffmpeg com `-progress pipe:1`: alimenta o toast com a porcentagem real. */
async function ffmpegRun(args, { input, timeout = 30 * 60 * 1000, speed = 1 } = {}) {
  const sink = jobProgress;
  const dur = sink && input ? (await mediaDuration(input)) / speed : 0;
  let buf = "";
  const onStdout = dur > 0 ? (text) => {
    buf = (buf + text).slice(-400);
    const m = buf.match(/out_time_(?:us|ms)=(\d+)(?![\s\S]*out_time_(?:us|ms)=)/);
    if (m) sink(Math.min(0.99, Number(m[1]) / 1e6 / dur));
  } : undefined;
  const full = dur > 0 ? ["-progress", "pipe:1", "-nostats", ...args] : args;
  await spawnWait(need("ffmpeg"), full, { timeout, onStdout });
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
    pdf: ["docx", "pptx", "xlsx", "jpg", "png", "epub", "txt", "md", "html"],
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
      if (to === "docx" || to === "pptx" || to === "xlsx") need.add("soffice");
      if (to === "xlsx") need.add("mutool");
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
    if (tool === "createPDF" || tool === "mergePDF") need.add("mutool");
    else if (tool === "createCollage" || tool === "zipFiles") { /* sharp/tar embutidos */ }
    else if (kind === "pdf") need.add("mutool");
    else if (kind === "image" && tool === "compress" && !["jpg", "png", "webp", "tiff", "avif", "gif"].includes(from)) need.add("magick");
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
    createPDF: "CRIAR PDF", createCollage: "COLAGEM", mergePDF: "JUNTAR", zipFiles: "ZIP",
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
  "compress", "removeMetadata", "audioChannels",
]);

/** Ferramentas que abrem só um formulário de opções (a janela base do estúdio, sem preview). */
const FORM = new Set(["compress", "removeMetadata", "audioChannels"]);

/** Campos do formulário de cada ferramenta, conforme o tipo do arquivo. */
function studioForm(id, filePath) {
  const tool = String(id || "").slice(5);
  if (!FORM.has(tool)) return null;
  const kind = kindOf(fmtOf(filePath));
  const seg = (k, label, options, value) => ({ k, label, type: "seg", options, value });
  const text = (k, label, value = "") => ({ k, label, type: "text", value });
  if (tool === "compress" && kind === "image") {
    return [
      seg("mode", "Modo", [["quality", "Qualidade"], ["target", "Tamanho alvo"]], "quality"),
      { k: "quality", label: "Qualidade", type: "range", min: 10, max: 100, value: 80, unit: "%", when: { mode: "quality" } },
      { k: "targetKB", label: "Tamanho (KB)", type: "number", min: 5, value: 500, when: { mode: "target" } },
      seg("maxSide", "Lado máximo", [["0", "Original"], ["3840", "4K"], ["1920", "1920"], ["1280", "1280"], ["800", "800"]], "0"),
      seg("format", "Formato", [["auto", "Automático"], ["jpg", "JPG"], ["webp", "WEBP"], ["png", "PNG"]], "auto"),
    ];
  }
  if (tool === "compress" && (kind === "video" || kind === "gif")) {
    return [
      seg("quality", "Qualidade", [["alta", "Alta"], ["media", "Média"], ["baixa", "Baixa"]], "media"),
      seg("height", "Resolução", [["0", "Original"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]], "0"),
      { k: "targetMB", label: "Tamanho alvo (MB, opcional)", type: "number", min: 0, value: "" },
    ];
  }
  if (tool === "compress" && kind === "audio") return [seg("bitrate", "Taxa (kbps)", [["64", "64"], ["96", "96"], ["128", "128"], ["192", "192"]], "128")];
  if (tool === "compress" && kind === "pdf") return [seg("level", "Nível", [["leve", "Leve (150 dpi)"], ["forte", "Forte (96 dpi)"]], "leve")];
  if (tool === "audioChannels") return [seg("mode", "Canais", [["mono", "Mono"], ["stereo", "Estéreo"], ["swap", "Inverter E/D"], ["left", "Só esquerdo"], ["right", "Só direito"]], "mono")];
  if (tool === "removeMetadata") {
    const fields = [{ k: "strip", label: "Remover todos os metadados", type: "check", value: true }];
    if (kind === "image") fields.push(text("title", "Descrição"), text("artist", "Autor"), text("copyright", "Direitos autorais"), text("make", "Câmera (marca)"), text("model", "Câmera (modelo)"));
    else if (kind === "pdf") fields.push(text("title", "Título"), text("artist", "Autor"), text("comment", "Assunto"), text("keywords", "Palavras-chave"));
    else {
      fields.push(text("title", "Título"), text("artist", "Artista"), text("album", "Álbum"), text("year", "Ano"), text("genre", "Gênero"), text("comment", "Comentário"));
      if (kind === "audio" && ["mp3", "m4a", "flac"].includes(fmtOf(filePath))) fields.push({ k: "cover", label: "Capa (imagem)", type: "file", value: "" });
    }
    fields.slice(1).forEach((f) => { f.when = { strip: false }; });
    return fields;
  }
  return null;
}

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

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** "1,2 MB" — tamanho para o hub; pastas não mostram tamanho (somar seria lento). */
function sizeLabel(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return "PASTA";
    const units = ["B", "KB", "MB", "GB"];
    let v = st.size;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
    return `${(u === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)).replace(".", ",")} ${units[u]}`;
  } catch { return ""; }
}

const ACTIONS = ["airDrop", "float", "copy", "move", "copyPath", "openTerminal"];

/** Ferramentas que trabalham com o lote inteiro de uma vez (um único resultado). */
const BATCH = new Set(["createPDF", "createCollage", "mergePDF", "zipFiles"]);

function isBatch(id) {
  return id.startsWith("tool:") && BATCH.has(id.slice(5));
}

/** Vários itens: conversões em comum, ferramentas por arquivo sem tela e as de lote. */
function buildMany(paths, mode) {
  const kinds = new Set(paths.map((p) => (isDir(p) ? "folder" : kindOf(fmtOf(p)))));
  const kind = kinds.size === 1 ? [...kinds][0] : "mixed";
  const format = `${paths.length} ITENS`;
  let items = [];
  if (mode === "convert") {
    if (kind !== "mixed" && kind !== "folder") {
      const common = paths.map((p) => targets(kind, fmtOf(p)));
      const all = targets(kind, "");
      items = all.filter((to) => common.every((list) => list.includes(to)))
        .map((to) => item(`conv:${to}`, titleOf(to), ok()));
    }
  } else if (mode === "tools") {
    const ids = [];
    if (kind === "image") ids.push("createPDF", "createCollage");
    if (kind === "pdf") ids.push("mergePDF");
    if (kind !== "mixed" && kind !== "folder") {
      toolIds(kind, fmtOf(paths[0])).filter((id) => !STUDIO.has(id) || FORM.has(id)).forEach((id) => ids.push(id));
    }
    ids.push("zipFiles");
    items = ids.map((id) => item(`tool:${id}`, toolTitle(id), toolGate(id)));
  } else {
    items = ACTIONS.map((id) => item(`act:${id}`, toolTitle(id), toolGate(id)));
  }
  return { mode, format, kind, path: paths[0], paths, items };
}

function build(target, mode) {
  const paths = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (paths.length > 1) return buildMany(paths, mode);
  const filePath = paths[0];
  if (isDir(filePath)) {
    const items = mode === "tools" ? [item("tool:zipFiles", toolTitle("zipFiles"), ok())]
      : mode === "actions" ? ACTIONS.map((id) => item(`act:${id}`, toolTitle(id), toolGate(id)))
        : [];
    return { mode, format: "PASTA", kind: "folder", path: filePath, paths, items };
  }
  const fmt = fmtOf(filePath);
  const kind = kindOf(fmt);
  let items = [];
  if (mode === "convert") {
    items = targets(kind, fmt).map((to) => item(`conv:${to}`, titleOf(to), ok()));
  } else if (mode === "tools") {
    items = toolIds(kind, fmt).map((id) => item(`tool:${id}`, toolTitle(id), toolGate(id)));
  } else {
    items = ACTIONS.map((id) => item(`act:${id}`, toolTitle(id), toolGate(id)));
  }
  const size = sizeLabel(filePath);
  return { mode, format: size ? `${titleOf(fmt)} · ${size}` : titleOf(fmt), kind, path: filePath, paths, items };
}

function uniquePath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}.${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${n}.${ext}`);
    n += 1;
  }
  return candidate;
}

/** Caminho livre para `name` dentro de `dir` ("X 2.ext", "Pasta 2"), para mover sem sobrescrever. */
function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} ${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function uniqueDir(dir, name) {
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${name} ${n}`);
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

/** Conta arquivos (para a barra de progresso), sem passar de um teto para não travar em pastas enormes. */
function countFiles(paths, cap = 200000) {
  let n = 0;
  const stack = [...paths];
  while (stack.length && n < cap) {
    const p = stack.pop();
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    n += 1;
    if (st.isDirectory()) {
      try { fs.readdirSync(p).forEach((name) => stack.push(path.join(p, name))); } catch { /* ignore */ }
    }
  }
  return n;
}

/** Quantas entradas um arquivo compactado tem (`tar -tf`). */
function archiveEntries(file) {
  return new Promise((resolve) => {
    let n = 0;
    spawnWait("tar", ["-tf", file], { timeout: 120000, onStdout: (t) => { n += (t.match(/\n/g) || []).length; } })
      .then(() => resolve(n), () => resolve(0));
  });
}

/** tar com `-v`: cada linha listada no stderr avança o progresso. */
function tarRun(args, total, options = {}) {
  const sink = jobProgress;
  let seen = 0;
  const onStderr = sink && total > 0 ? (t) => {
    seen += (t.match(/\n/g) || []).length;
    sink(Math.min(0.99, seen / total));
  } : undefined;
  return spawnWait("tar", onStderr ? ["-v", ...args] : args, { timeout: 30 * 60 * 1000, ...options, onStderr });
}

async function convertArchive(filePath, dest, to) {
  const tmp = scratch();
  try {
    const content = path.join(tmp, "x");
    fs.mkdirSync(content);
    const sink = jobProgress;
    const total = sink ? await archiveEntries(filePath) : 0;
    jobProgress = sink ? (f) => sink(f / 2) : null;
    await tarRun(["-xf", filePath, "-C", content], total);
    const args = to === "zip" ? ["-a", "-cf", dest] : to === "gz" ? ["-czf", dest] : ["-cf", dest];
    jobProgress = sink ? (f) => sink(0.5 + f / 2) : null;
    await tarRun([...args, "-C", content, "."], total + 1);
    jobProgress = sink;
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
    // GIF com paleta própria (palettegen/paletteuse): cores fiéis e arquivo bem menor que a paleta fixa.
    else if (to === "gif") args.push("-filter_complex", "fps=12,scale='min(640,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0");
    else if (kind === "gif" || to === "mp4" || to === "mov") args.push("-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2");
    if (kind === "gif" && to !== "gif") args.push("-movflags", "+faststart");
    await ffmpegRun([...args, dest], { input: filePath });
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
      if (to === "xlsx") {
        // Tabelas do PDF: cada linha de texto vira uma linha; colunas separadas por 2+ espaços ou tab.
        // Uma página por aba não é possível via CSV; as páginas ficam em sequência com uma linha vazia.
        const rows = fs.readFileSync(text, "utf8").replace(/\f/g, "\n\n").split(/\r?\n/)
          .map((line) => line.replace(/\s+$/, ""))
          .map((line) => (line.trim() ? line.trim().split(/\t|\s{2,}/) : []));
        const cell = (v) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const csv = path.join(tmp, `${stem}.csv`);
        fs.writeFileSync(csv, "\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n"), "utf8");
        return finish(await soffice(csv, "xlsx", tmp));
      }
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

function hasTags(o) {
  return ["title", "artist", "album", "year", "comment", "copyright", "make", "model", "keywords", "genre"].some((k) => o && String(o[k] || "").trim());
}

/** Comprime imagem por qualidade (%) ou por tamanho alvo (busca binária da qualidade, depois reduz a resolução). */
async function compressImage(filePath, opts = {}) {
  const sharp = require("sharp");
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const from = fmtOf(filePath);
  let source = filePath;
  let tmp = null;
  try {
    if (!["jpg", "png", "webp", "tiff", "avif", "gif", "heic"].includes(from) || from === "heic") {
      tmp = scratch();
      source = path.join(tmp, "src.png");
      await spawnWait(need("magick"), [`${filePath}[0]`, source]);
    }
    const meta = await sharp(source, { failOn: "none" }).metadata();
    const alpha = !!meta.hasAlpha;
    let fmt = opts.format && opts.format !== "auto" ? opts.format : (from === "webp" ? "webp" : (from === "png" && alpha ? "png" : "jpg"));
    const target = opts.mode === "target" ? Math.max(5, Number(opts.targetKB) || 0) * 1024 : 0;
    if (target && fmt === "png") fmt = alpha ? "webp" : "jpg";
    const maxSide = Number(opts.maxSide) || 0;
    const encode = async (quality, scale = 1) => {
      let img = sharp(source, { failOn: "none" }).rotate();
      const w = meta.width || 0, h = meta.height || 0;
      const limit = Math.max(w, h) * scale;
      const side = maxSide ? Math.min(maxSide, limit) : limit;
      if (side && side < Math.max(w, h)) img = img.resize({ width: w >= h ? Math.round(side) : undefined, height: h > w ? Math.round(side) : undefined, withoutEnlargement: true });
      if (fmt === "jpg") img = img.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
      else if (fmt === "webp") img = img.webp({ quality, effort: 4 });
      else img = img.png({ palette: true, quality, compressionLevel: 9 });
      return img.toBuffer();
    };
    let out;
    if (!target) out = await encode(Math.min(100, Math.max(5, Number(opts.quality) || 80)));
    else {
      let scale = 1;
      for (let round = 0; round < 6; round += 1) {
        let lo = 5, hi = 95, best = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const buf = await encode(mid, scale);
          if (buf.length <= target) { best = buf; lo = mid + 1; } else hi = mid - 1;
        }
        if (best) { out = best; break; }
        scale *= 0.75;
      }
      if (!out) throw new Error("Não foi possível chegar a esse tamanho — tente um valor maior");
    }
    const dest = uniquePath(dir, `${stem} Comprimido`, fmt);
    fs.writeFileSync(dest, out);
    return exists(dest);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Vídeo: qualidade (CRF), resolução máxima e, se pedido, tamanho alvo (bitrate calculado pela duração). */
async function compressVideo(filePath, opts, ff, dest) {
  const crf = { alta: 23, media: 28, baixa: 33 }[opts.quality] || 28;
  const height = Number(opts.height) || 0;
  const vf = height ? `scale=-2:'min(${height},ih)'` : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const targetMB = Number(opts.targetMB) || 0;
  let rate = ["-crf", String(crf)];
  if (targetMB > 0) {
    const dur = await mediaDuration(filePath);
    if (dur > 0) {
      const kbps = Math.max(150, Math.floor((targetMB * 8192) / dur - 128));
      rate = ["-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`];
    }
  }
  return ff(["-c:v", "libx264", ...rate, "-preset", "veryfast", "-vf", vf, "-c:a", "aac", "-b:a", "128k", "-pix_fmt", "yuv420p", "-movflags", "+faststart"], dest);
}

/** Tags de áudio/vídeo (título, artista, álbum, ano, comentário) e capa em MP3/M4A/FLAC. */
async function mediaTags(filePath, opts) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const ext = path.extname(filePath).slice(1) || "bin";
  const from = fmtOf(filePath);
  const dest = uniquePath(dir, `${stem} Metadados`, ext);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath];
  const cover = opts.cover && fs.existsSync(opts.cover) && ["mp3", "m4a", "flac"].includes(from) ? opts.cover : null;
  if (cover) args.push("-i", cover, "-map", "0:a", "-map", "1:v", "-disposition:v:0", "attached_pic");
  else args.push("-map", "0");
  args.push("-c", "copy");
  if (from === "mp3") args.push("-id3v2_version", "3");
  const tag = { title: "title", artist: "artist", album: "album", year: "date", comment: "comment", genre: "genre", copyright: "copyright" };
  Object.entries(tag).forEach(([k, name]) => {
    const v = String((opts && opts[k]) || "").trim();
    if (v) args.push("-metadata", `${name}=${v}`);
  });
  await spawnWait(need("ffmpeg"), [...args, dest], { timeout: 10 * 60 * 1000 });
  return exists(dest);
}

async function runTool(tool, filePath, opts = {}) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  const from = fmtOf(filePath);
  const kind = kindOf(from);
  const ext = path.extname(filePath).slice(1) || "bin";
  const ff = (args, dest, extra = []) => ffmpegRun(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", filePath, ...extra, ...args, dest], { input: filePath }).then(() => exists(dest));
  if (tool === "extractArchive") {
    const destDir = uniqueDir(dir, stem);
    fs.mkdirSync(destDir, { recursive: true });
    // O tar.exe do Windows (bsdtar/libarchive) já lê ZIP, TAR, GZ, RAR e 7z; o 7-Zip é só reserva.
    try {
      await tarRun(["-xf", filePath, "-C", destDir], await archiveEntries(filePath));
    } catch (err) {
      const seven = (from === "rar" || from === "7z") && (which("7z") || which("7za"));
      if (!seven) {
        fs.rmSync(destDir, { recursive: true, force: true });
        throw from === "rar" || from === "7z" ? new Error("Não foi possível abrir este arquivo compactado (instale o 7-Zip para RAR5/7z protegidos)") : err;
      }
      await spawnWait(seven, ["x", "-y", `-o${destDir}`, filePath], { timeout: 10 * 60 * 1000 });
    }
    return destDir;
  }
  if (kind === "pdf") {
    if (tool === "removeMetadata" && !opts.strip && hasTags(opts)) {
      const dest = uniquePath(dir, `${stem} Metadados`, "pdf");
      const tmp = scratch();
      try {
        const script = path.join(tmp, "meta.js");
        fs.writeFileSync(script, PDF_META_JS, "utf8");
        const plan = path.join(tmp, "meta.json");
        fs.writeFileSync(plan, JSON.stringify({ Title: opts.title || "", Author: opts.artist || "", Subject: opts.comment || "", Keywords: opts.keywords || "" }), "utf8");
        await mutoolRun(["run", script, filePath, plan, dest], { timeout: 300000 });
        return exists(dest);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    if (tool === "compress" || tool === "removeMetadata") {
      const dest = uniquePath(dir, `${stem} ${tool === "compress" ? "Comprimido" : "Sem Metadados"}`, "pdf");
      const strong = opts.level === "forte";
      // compress: reamostra imagens acima de 150 dpi para 150 dpi e recomprime em JPEG (q75), só se ficar menor.
      const args = tool === "compress"
        ? ["clean", "-gggg", "-z", "-f", "-i", "-Z", "-m",
          "--color-image-subsample-dpi", strong ? "110,96" : "200,150", "--gray-image-subsample-dpi", strong ? "110,96" : "200,150",
          "--color-image-recompress-method", strong ? "jpeg:55" : "jpeg:75", "--gray-image-recompress-method", strong ? "jpeg:55" : "jpeg:75"]
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
      const outDir = uniqueDir(dir, `${stem} Páginas`);
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
    if (tool === "compress") return compressImage(filePath, opts);
    if (tool === "removeMetadata" && !opts.strip && hasTags(opts) && ["jpg", "png", "webp", "tiff", "avif"].includes(from)) {
      // Regrava só as tags pedidas; o resto (inclusive localização/GPS) sai.
      const dest = uniquePath(dir, `${stem} Metadados`, ext);
      const sharp = require("sharp");
      const IFD0 = {};
      if (opts.artist) IFD0.Artist = String(opts.artist);
      if (opts.title) IFD0.ImageDescription = String(opts.title);
      if (opts.copyright) IFD0.Copyright = String(opts.copyright);
      if (opts.make) IFD0.Make = String(opts.make);
      if (opts.model) IFD0.Model = String(opts.model);
      await sharp(filePath, { failOn: "none" }).rotate().withExif({ IFD0 }).toFile(dest);
      return exists(dest);
    }
    if (tool === "removeMetadata") {
      const dest = uniquePath(dir, `${stem} Sem Metadados`, ext);
      await spawnWait(need("magick"), [filePath, "-strip", dest]);
      return exists(dest);
    }
    if (tool === "resize50" || tool === "resize1080" || tool === "rotate90") {
      const dest = uniquePath(dir, `${stem} ${{ rotate90: "Girado", resize50: "50%", resize1080: "1080p" }[tool]}`, "png");
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
    if (tool === "removeMetadata" && !opts.strip && (hasTags(opts) || opts.cover)) return mediaTags(filePath, opts);
    if (tool === "removeMetadata") return ff(["-map_metadata", "-1", "-c", "copy"], uniquePath(dir, `${stem} Sem Metadados`, ext));
    if (tool === "compress" && kind === "audio") {
      const kbps = [48, 64, 96, 128, 160, 192].includes(Number(opts.bitrate)) ? Number(opts.bitrate) : 128;
      return ff(["-vn", "-b:a", `${kbps}k`], uniquePath(dir, `${stem} Comprimido`, "mp3"));
    }
    if (tool === "compress") return compressVideo(filePath, opts, ff, uniquePath(dir, `${stem} Comprimido`, "mp4"));
    if (tool === "normalizeAudio") return ff(["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"], uniquePath(dir, `${stem} Normalizado`, ext));
    if (tool === "audioChannels") {
      const mode = opts.mode || "mono";
      if (mode === "stereo") return ff(["-ac", "2"], uniquePath(dir, `${stem} Estéreo`, ext));
      if (mode === "swap") return ff(["-af", "pan=stereo|c0=c1|c1=c0"], uniquePath(dir, `${stem} Canais Invertidos`, ext));
      if (mode === "left" || mode === "right") return ff(["-af", `pan=mono|c0=${mode === "left" ? "c0" : "c1"}`], uniquePath(dir, `${stem} ${mode === "left" ? "Esquerdo" : "Direito"}`, ext));
      return ff(["-ac", "1"], uniquePath(dir, `${stem} Mono`, ext));
    }
    if (tool === "muteVideo") return ff(["-c:v", "copy", "-an"], uniquePath(dir, `${stem} Sem Som`, ext));
    if (tool === "videoSnapshots") {
      const outDir = uniqueDir(dir, `${stem} Capturas`);
      fs.mkdirSync(outDir, { recursive: true });
      await spawnWait(need("ffmpeg"), ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath, "-vf", "fps=1/5", path.join(outDir, `${stem}-%03d.png`)], { timeout: 30 * 60 * 1000 });
      return outDir;
    }
  }
  throw new Error("Essa ferramenta ainda não está disponível para este arquivo");
}

/** Ferramentas de lote: um único resultado ao lado do primeiro item. */
async function runMany(id, paths, { onProgress } = {}) {
  jobProgress = onProgress || null;
  try { return await runManyNow(id, paths); } finally { jobProgress = null; }
}

async function runManyNow(id, paths) {
  const tool = String(id).slice(5);
  const first = paths[0];
  const dir = path.dirname(first);
  const stem = isDir(first) ? path.basename(first) : path.parse(first).name;
  if (tool === "zipFiles") {
    const dest = uniquePath(dir, paths.length === 1 ? stem : `${stem} e mais ${paths.length - 1}`, "zip");
    const args = ["-a", "-cf", dest];
    for (const p of paths) args.push("-C", path.dirname(p), path.basename(p));
    await tarRun(args, jobProgress ? countFiles(paths) : 0);
    return exists(dest);
  }
  if (tool === "mergePDF") {
    const dest = uniquePath(dir, `${stem} Combinado`, "pdf");
    await mutoolRun(["merge", "-o", dest, ...paths], { timeout: 300000 });
    return exists(dest);
  }
  if (tool === "createPDF") {
    const dest = uniquePath(dir, `${stem} Imagens`, "pdf");
    const tmp = scratch();
    try {
      // Normaliza para PNG (HEIC/WEBP/AVIF etc.) e respeita a orientação EXIF; uma página por imagem, na ordem.
      const sharp = require("sharp");
      const pages = [];
      for (let i = 0; i < paths.length; i += 1) {
        const png = path.join(tmp, `p-${String(i).padStart(4, "0")}.png`);
        await sharp(paths[i], { failOn: "none" }).rotate().png().toFile(png);
        pages.push(png);
      }
      await mutoolRun(["convert", "-o", dest, ...pages], { timeout: 300000 });
      return exists(dest);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (tool === "createCollage") {
    const sharp = require("sharp");
    const cols = Math.ceil(Math.sqrt(paths.length));
    const rows = Math.ceil(paths.length / cols);
    const cell = 600;
    const gap = 16;
    const tiles = [];
    for (let i = 0; i < paths.length; i += 1) {
      const input = await sharp(paths[i], { failOn: "none" }).rotate()
        .resize(cell, cell, { fit: "cover" }).png().toBuffer();
      tiles.push({ input, left: gap + (i % cols) * (cell + gap), top: gap + Math.floor(i / cols) * (cell + gap) });
    }
    const dest = uniquePath(dir, `${stem} Colagem`, "png");
    await sharp({ create: { width: gap + cols * (cell + gap), height: gap + rows * (cell + gap), channels: 4, background: "#ffffff" } })
      .composite(tiles).png().toFile(dest);
    return exists(dest);
  }
  throw new Error("Essa ferramenta ainda não está disponível para este arquivo");
}

async function run(id, filePath, { onProgress } = {}) {
  const dir = path.dirname(filePath);
  const stem = path.parse(filePath).name;
  jobProgress = onProgress || null;
  try {
    if (id.startsWith("conv:")) return await convert(filePath, id.slice(5));
    if (id.startsWith("tool:")) {
      const tool = id.slice(5);
      if (tool === "copy") return await run("act:copy", filePath);
      return await runTool(tool, filePath);
    }
  } finally {
    jobProgress = null;
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
    // Pasta: abre nela; arquivo: abre na pasta dele. Windows Terminal se existir, senão PowerShell.
    const where = isDir(filePath) ? filePath : dir;
    const wt = which("wt") || (process.env.LOCALAPPDATA && [path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe")].find((p) => fs.existsSync(p)));
    if (wt) spawn(wt, ["-d", where], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    else spawn("cmd", ["/C", "start", "", "powershell.exe", "-NoExit", "-Command", `Set-Location -LiteralPath '${where.replace(/'/g, "''")}'`], { detached: true, stdio: "ignore", cwd: where }).unref();
    return where;
  }
  throw new Error("Essa ação ainda não está disponível");
}

/** Sufixos em PT-BR dos resultados do estúdio de imagem (como o Tangerine: "X Recortado.png"). */
const STUDIO_SUFFIX = {
  cropImage: "Recortado", redactImage: "Ocultado", editImage: "Editado", annotateImage: "Anotado", frameImage: "Com Fundo",
};

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
  if (FORM.has(tool)) {
    jobProgress = job.onProgress || null;
    try { return await runTool(tool, filePath, job.opts || {}); } finally { jobProgress = null; }
  }
  if (job.png) return writePng(job.png, uniquePath(dir, `${stem} ${STUDIO_SUFFIX[tool] || "Editado"}`, "png"));
  jobProgress = job.onProgress || null;
  const ff = (args, dest) => ffmpegRun(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args, dest], { input: filePath }).then(() => exists(dest));
  const start = Math.max(0, Number(job.start) || 0);
  const end = Math.max(start, Number(job.end) || 0);
  if (tool === "trimVideo" || tool === "trimAudio") {
    return ff(["-i", filePath, "-ss", String(start), "-to", String(end || start + 0.2), "-c", "copy"], uniquePath(dir, `${stem} Aparado`, ext));
  }
  if (tool === "changeVideoSpeed") {
    const rate = Math.min(2, Math.max(0.5, Number(job.rate) || 1));
    return ff(["-i", filePath, "-filter:v", `setpts=PTS/${rate}`, "-filter:a", `atempo=${rate}`], uniquePath(dir, `${stem} Velocidade`, "mp4"));
  }
  if (tool === "videoSnapshots") {
    const dest = uniquePath(dir, `${stem} Captura`, "png");
    return ff(["-ss", String(start), "-i", filePath, "-frames:v", "1"], dest);
  }
  if (tool === "splitVideo") {
    const at = Math.max(0.1, Number(job.at) || 1);
    const a = uniquePath(dir, `${stem} Parte 1`, ext);
    const b = uniquePath(dir, `${stem} Parte 2`, ext);
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
    return ff(["-i", filePath, "-vf", filter, "-c:a", "copy"], uniquePath(dir, `${stem} ${tool === "cropVideo" ? "Recortado" : "Ocultado"}`, "mp4"));
  }
  if (tool === "redactAudio") {
    const dur = Math.max(0.2, (end || start + 0.2) - start);
    const delay = Math.round(start * 1000);
    const dest = uniquePath(dir, `${stem} Bipado`, ext);
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
    const dest = uniquePath(dir, `${stem} Forma de Onda`, "png");
    return ff(["-i", filePath, "-filter_complex", "showwavespic=s=1280x360:colors=white", "-frames:v", "1"], dest);
  }
  if (tool === "splitPDF") {
    const range = String(job.range || "1-N").trim();
    const dest = uniquePath(dir, `${stem} Páginas`, "pdf");
    await mutoolRun(["merge", "-o", dest, filePath, range], { timeout: 300000 });
    return exists(dest);
  }
  if (tool === "organizePDF") {
    const pages = (Array.isArray(job.pages) ? job.pages : [])
      .map((p) => ({ index: Math.max(1, Math.round(Number(p.index) || 0)), rotate: ((Math.round((Number(p.rotate) || 0) / 90) * 90) % 360 + 360) % 360 }));
    if (!pages.length) throw new Error("Nenhuma página ficou na seleção");
    const dest = uniquePath(dir, `${stem} Organizado`, "pdf");
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

/** Script do `mutool run`: grava Título/Autor/Assunto/Palavras-chave sem rasterizar. */
const PDF_META_JS = `
var doc = Document.openDocument(scriptArgs[0]);
var pdf = doc.asPDF ? doc.asPDF() : doc;
var meta = JSON.parse(read(scriptArgs[1]));
var info = pdf.getTrailer().get("Info");
if (!info || info.isNull()) { info = pdf.addObject(pdf.newDictionary()); pdf.getTrailer().put("Info", info); }
for (var k in meta) { if (meta[k]) info.put(k, pdf.newString(meta[k])); }
pdf.save(scriptArgs[2], "garbage,compress");
`;

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

module.exports = { studioForm, build, isBatch, isDir, runMany, uniqueTarget, pending, run, tools, prepare, targets, toolsFor, kindOf, fmtOf, needsStudio, applyStudio, studioPages };
