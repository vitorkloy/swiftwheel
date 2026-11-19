"use strict";
/** Compila backend/bin/vor-ocr.exe com o csc do .NET Framework 4 + Windows.winmd (OCR nativo). */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const src = path.join(root, "native", "vor-ocr.cs");
const out = path.join(root, "backend", "bin", "vor-ocr.exe");
if (process.platform !== "win32") {
  console.log("[ocr-helper] fora do Windows, a saltar");
  process.exit(0);
}
const windir = process.env.WINDIR || "C:\\Windows";
const csc = ["Framework64", "Framework"]
  .map((dir) => path.join(windir, "Microsoft.NET", dir, "v4.0.30319", "csc.exe"))
  .find((file) => fs.existsSync(file));
if (!csc) throw new Error("csc.exe do .NET Framework 4 não encontrado");
const winmd = path.join(windir, "System32", "WinMetadata", "Windows.winmd");
if (!fs.existsSync(winmd)) {
  console.log("[ocr-helper] Windows.winmd ausente, a saltar (fallback PowerShell no runtime)");
  process.exit(0);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(csc, [
  "/nologo", "/optimize+", "/target:exe", "/platform:anycpu",
  `/r:${winmd}`,
  `/out:${out}`, src,
], { stdio: "inherit" });
console.log(`[ocr-helper] ${out}`);
