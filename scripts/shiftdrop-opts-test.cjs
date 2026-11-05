// Testa as opções novas (tamanho alvo, metadados, canais, GIF, progresso) em amostras reais.
const path = require("path");
const fs = require("fs");
const w = require("../backend/shift-wheels.cjs");
const dir = path.resolve(process.argv[2] || "smoke");
const f = (n) => path.join(dir, n);
const cases = [
  ["tool:compress", "photo.jpg", { mode: "target", targetKB: 40 }],
  ["tool:compress", "image.png", { mode: "quality", quality: 60, maxSide: 800 }],
  ["tool:removeMetadata", "photo.jpg", { strip: false, artist: "Vitor", title: "Teste VOR" }],
  ["tool:removeMetadata", "audio.mp3", { strip: false, title: "Faixa", artist: "VOR", cover: f("photo.jpg") }],
  ["tool:removeMetadata", "doc.pdf", { strip: false, title: "Titulo VOR", artist: "Vitor" }],
  ["tool:compress", "doc.pdf", { level: "forte" }],
  ["tool:audioChannels", "audio.mp3", { mode: "stereo" }],
  ["tool:audioChannels", "audio.mp3", { mode: "swap" }],
  ["tool:compress", "video.mp4", { quality: "baixa", height: 480 }],
  ["tool:compress", "audio.mp3", { bitrate: 64 }],
];
(async () => {
  let bad = 0;
  for (const [id, file, opts] of cases) {
    const t = Date.now();
    let ticks = 0;
    try {
      await w.prepare(id, f(file));
      const out = await w.applyStudio(id, f(file), { opts, onProgress: () => { ticks += 1; } });
      const size = fs.statSync(out).size;
      console.log(`OK   ${id} ${file} ${JSON.stringify(opts)} -> ${path.basename(out)} ${Math.round(size / 1024)} KB, ${ticks} ticks (${Date.now() - t} ms)`);
      if (opts.targetKB && size > opts.targetKB * 1024) { bad += 1; console.log("  acima do alvo!"); }
    } catch (err) { bad += 1; console.log(`FAIL ${id} ${file}: ${err.message}`); }
  }
  for (const to of ["gif"]) {
    let ticks = 0;
    try { const out = await w.run(`conv:${to}`, f("video.mp4"), { onProgress: () => { ticks += 1; } }); console.log(`OK   conv:${to} -> ${path.basename(out)} ${Math.round(fs.statSync(out).size / 1024)} KB, ${ticks} ticks`); } catch (err) { bad += 1; console.log("FAIL gif", err.message); }
  }
  console.log("forms:", ["image.png", "audio.mp3", "video.mp4", "doc.pdf"].map((n) => `${n}=${(w.studioForm("tool:removeMetadata", f(n)) || []).length}`).join(" "));
  console.log(bad ? `${bad} falhas` : "tudo ok");
})();
