"use strict";

/**
 * OCR a pedido (issue #51): Windows.Media.Ocr, offline, sem pacote extra.
 * Preferência pt-BR e inglês. Só corre quando o utilizador pede.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function normalizeOcrText(raw) {
  return String(raw || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ocrOutcome(text, language) {
  const value = normalizeOcrText(text);
  const pt = language !== "en";
  if (!value) {
    return {
      ok: false,
      empty: true,
      text: "",
      toast: pt ? "Nenhum texto encontrado" : "No text found",
    };
  }
  return {
    ok: true,
    empty: false,
    text: value,
    toast: pt ? "Texto copiado" : "Text copied",
  };
}

function preferredOcrLanguages(language) {
  if (language === "en") return ["en", "en-US", "en-GB", "pt-BR", "pt"];
  return ["pt-BR", "pt", "en", "en-US"];
}

function pickOcrLanguage(available, preferred) {
  const have = (available || []).map((item) => String(item || "").toLowerCase());
  for (const want of preferred || []) {
    const token = String(want || "").toLowerCase();
    if (!token) continue;
    const hit = have.find((item) => item === token || item.startsWith(`${token}-`) || token.startsWith(`${item}-`));
    if (hit) return hit;
  }
  return have[0] || null;
}

function findOcrHelper(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const unpacked = path.join(__dirname, "bin", "vor-ocr.exe").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  if (fs.existsSync(unpacked)) return unpacked;
  return null;
}

function runProcess(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("OCR excedeu o tempo"));
    }, timeoutMs || 25000);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, out, err });
    });
  });
}

async function runHelper(exe, imagePath, langs) {
  const result = await runProcess(exe, ["--lang", langs.join(","), imagePath], { timeoutMs: 25000 });
  if (result.code === 2) return "";
  if (result.code !== 0) {
    throw new Error((result.err || result.out || `OCR falhou (${result.code})`).trim());
  }
  return result.out;
}

function powershellScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null",
    "$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]",
    "$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]",
    "$null = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]",
    "$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]",
    "function Await-WinRT($op) {",
    "  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
    "  $task = $asTask.MakeGenericMethod($op.GetType().GenericTypeArguments[0]).Invoke($null, @($op))",
    "  $task.Wait(-1) | Out-Null",
    "  if ($task.IsFaulted) { throw $task.Exception.InnerException }",
    "  return $task.Result",
    "}",
    "$path = $env:VOR_OCR_PATH",
    "$langs = @($env:VOR_OCR_LANGS -split ',')",
    "$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path))",
    "$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))",
    "try {",
    "  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))",
    "  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync())",
    "  if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 -and $bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Gray8 -and $bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Nv12) {",
    "    $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8)",
    "  }",
    "  $engine = $null",
    "  foreach ($tag in $langs) {",
    "    if (-not $tag) { continue }",
    "    try {",
    "      $lang = [Windows.Globalization.Language]::new($tag)",
    "      if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) {",
    "        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)",
    "        if ($engine) { break }",
    "      }",
    "    } catch {}",
    "  }",
    "  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }",
    "  if (-not $engine) { Write-Error 'motor OCR indisponível'; exit 1 }",
    "  $result = Await-WinRT ($engine.RecognizeAsync($bitmap))",
    "  $text = [string]$result.Text",
    "  if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }",
    "  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "  [Console]::Out.Write($text)",
    "} finally { $stream.Dispose() }",
  ].join("\n");
}

async function runPowershellWithEnv(imagePath, langs) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", powershellScript(),
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, VOR_OCR_PATH: imagePath, VOR_OCR_LANGS: langs.join(",") },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("OCR excedeu o tempo"));
    }, 40000);
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { err += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 2) return resolve("");
      if (code !== 0) return reject(new Error((err || out || `OCR falhou (${code})`).trim()));
      resolve(out);
    });
  });
}

function rasterExt(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff"].includes(ext);
}

async function ensureRaster(filePath) {
  if (rasterExt(filePath)) return { file: filePath, temp: null };
  const sharp = require("sharp");
  const dest = path.join(os.tmpdir(), `vor-ocr-${process.pid}-${Date.now()}.png`);
  await sharp(filePath, { failOn: "none" }).rotate().png().toFile(dest);
  return { file: dest, temp: dest };
}

async function recognizeFile(filePath, options) {
  const opts = options || {};
  if (process.platform !== "win32") {
    throw new Error("OCR só está disponível no Windows");
  }
  const langs = Array.isArray(opts.langs) && opts.langs.length
    ? opts.langs
    : preferredOcrLanguages(opts.language);
  let raster = { file: filePath, temp: null };
  try {
    raster = await ensureRaster(filePath);
  } catch {
    raster = { file: filePath, temp: null };
  }
  const helper = findOcrHelper(opts.helperPath);
  try {
    if (helper) {
      try {
        return await runHelper(helper, raster.file, langs);
      } catch (error) {
        if (opts.allowPowershell === false) throw error;
      }
    }
    return await runPowershellWithEnv(raster.file, langs);
  } finally {
    if (raster.temp) {
      try { fs.rmSync(raster.temp, { force: true }); } catch { /* ignore */ }
    }
  }
}

async function recognizeDataUrl(dataUrl, options) {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!match) throw new Error("imagem inválida");
  const buffer = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw new Error("imagem vazia");
  const dest = path.join(os.tmpdir(), `vor-ocr-${process.pid}-${Date.now()}.png`);
  fs.writeFileSync(dest, buffer);
  try {
    return await recognizeFile(dest, options);
  } finally {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  normalizeOcrText,
  ocrOutcome,
  preferredOcrLanguages,
  pickOcrLanguage,
  findOcrHelper,
  recognizeFile,
  recognizeDataUrl,
};
