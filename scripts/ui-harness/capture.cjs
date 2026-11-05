// Captura as superfícies do ShiftDrop (roda, estúdio, formulário, toast, prateleira) em PNG, nos temas preto e branco.
// Uso: npx esbuild scripts/ui-harness/wheel.tsx --bundle --outfile=scripts/ui-harness/wheel.js --loader:.tsx=tsx --jsx=automatic
//      npx electron scripts/ui-harness/capture.cjs <pasta-de-saida> <pasta-de-amostras>
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const out = path.resolve(process.argv[2] || "ui-shots");
const samples = path.resolve(process.argv[3] || "smoke");
const backend = path.join(__dirname, "..", "..", "backend");
fs.mkdirSync(out, { recursive: true });
const wallpaper = (theme) => theme === "white"
  ? "linear-gradient(135deg,#dfe7f1,#f4e9e1 60%,#e6efe4)"
  : "linear-gradient(135deg,#1d2433,#2a1f2e 60%,#14251f)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(name, win, theme) {
  await win.webContents.executeJavaScript(`document.documentElement.style.background=${JSON.stringify(wallpaper(theme))};document.body.style.background='transparent'`);
  await sleep(450);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, `${name}-${theme}.png`), img.toPNG());
  console.log("saved", `${name}-${theme}.png`);
}
const make = (w, h, preload) => new BrowserWindow({ width: w, height: h, show: false, frame: false, transparent: false, backgroundColor: "#00000000",
  webPreferences: { preload, contextIsolation: true, webSecurity: false, offscreen: false } });

app.whenReady().then(async () => {
  const accent = process.env.VOR_ACCENT || "#FFFFFF";
  for (const theme of ["black", "white"]) {
    const appearance = { theme, accent, glass: true, opacity: 0.8 };
    const w = make(820, 330);
    await w.loadFile(path.join(__dirname, "wheel.html"), { query: { theme, accent } });
    await shoot("wheel", w, theme); w.destroy();

    for (const [name, job, size] of [
      ["studio-crop", { id: "tool:cropImage", filePath: path.join(samples, "photo.jpg"), files: [path.join(samples, "photo.jpg"), path.join(samples, "image.png"), path.join(samples, "photo.jpg")], index: 0, total: 3, rest: [path.join(samples, "image.png")] }, [1000, 720]],
      ["studio-annotate", { id: "tool:annotateImage", filePath: path.join(samples, "photo.jpg") }, [1000, 720]],
      ["studio-form", { id: "tool:compress", filePath: path.join(samples, "photo.jpg"), form: require(path.join(backend, "shift-wheels.cjs")).studioForm("tool:compress", path.join(samples, "photo.jpg")) }, [640, 560]],
    ]) {
      try { ipcMain.removeHandler("studio-job"); } catch { /* ignore */ }
      ipcMain.handle("studio-job", () => ({ pages: [], ...job, appearance }));
      const s = make(size[0], size[1], path.join(backend, "studio-preload.js"));
      await s.loadFile(path.join(backend, "studio.html"));
      await sleep(400);
      await shoot(name, s, theme); s.destroy();
    }

    const shelf = make(296, 260, path.join(backend, "float-shelf-preload.js"));
    await shelf.loadFile(path.join(backend, "float-shelf.html"));
    shelf.webContents.send("shelf-theme", appearance);
    shelf.webContents.send("shelf-items", ["photo.jpg", "image.png", "doc.pdf", "video.mp4"].map((n) => ({ path: path.join(samples, n), name: n, icon: "" })));
    await shoot("shelf", shelf, theme); shelf.destroy();

    const src = fs.readFileSync(path.join(backend, "electron-main.js"), "utf8");
    const m = src.match(/const SHIFT_TOAST_HTML = `([\s\S]*?)`;/);
    const toast = make(340, 100);
    await toast.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(m[1])}`);
    await toast.webContents.executeJavaScript(`window.theme(${JSON.stringify(appearance)}); window.set("Comprimindo photo.jpg 2 de 3", 0.55, true)`);
    await shoot("toast", toast, theme); toast.destroy();
  }
  app.quit();
});
