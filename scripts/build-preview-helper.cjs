"use strict";
/** Compila backend/bin/vor-preview.exe com o csc do .NET Framework 4 que vem em todo Windows 10/11. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const src = path.join(root, "native", "vor-preview.cs");
const out = path.join(root, "backend", "bin", "vor-preview.exe");
if (process.platform !== "win32") {
  console.log("[preview-helper] fora do Windows, a saltar");
  process.exit(0);
}
const windir = process.env.WINDIR || "C:\\Windows";
const csc = ["Framework64", "Framework"]
  .map((dir) => path.join(windir, "Microsoft.NET", dir, "v4.0.30319", "csc.exe"))
  .find((file) => fs.existsSync(file));
if (!csc) throw new Error("csc.exe do .NET Framework 4 não encontrado");
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(csc, [
  "/nologo", "/optimize+", "/target:winexe", "/platform:anycpu",
  "/r:System.Windows.Forms.dll",
  `/out:${out}`, src,
], { stdio: "inherit" });
console.log(`[preview-helper] ${out}`);
