/**
 * Teste de fumaça do ShiftDrop fora do Electron: `node scripts/shiftdrop-smoke.cjs <pasta-de-amostras> [filtro]`.
 * Para cada amostra roda as conversões/ferramentas da roda e mostra OK/FALHA. Baixa os conversores se faltarem.
 */
const fs = require("fs");
const path = require("path");
const sw = require("../backend/shift-wheels.cjs");

const dir = path.resolve(process.argv[2] || "smoke");
const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;
const studioSpecs = {
  "tool:trimVideo": { start: 0, end: 1 }, "tool:trimAudio": { start: 0, end: 1 },
  "tool:changeVideoSpeed": { rate: 1.5 }, "tool:videoSnapshots": { start: 0.5 },
  "tool:splitVideo": { at: 1 }, "tool:cropVideo": { x: 0, y: 0, w: 100, h: 80 },
  "tool:redactVideo": { x: 10, y: 10, w: 40, h: 30 }, "tool:redactAudio": { start: 0.2, end: 0.6 },
  "tool:audioToVideo": {}, "tool:splitPDF": { range: "1" },
  "tool:organizePDF": { pages: [{ index: 2, rotate: 90 }, { index: 1, rotate: 0 }] },
};

(async () => {
  const out = path.join(dir, "out");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let pass = 0; let fail = 0;
  for (const name of fs.readdirSync(dir)) {
    const src0 = path.join(dir, name);
    if (!fs.statSync(src0).isFile()) continue;
    for (const mode of ["convert", "tools"]) {
      const wheel = sw.build(src0, mode);
      for (const item of wheel.items) {
        if (filter && !filter.test(`${name} ${item.id}`)) continue;
        if (sw.needsStudio(item.id) && !studioSpecs[item.id]) continue;
        if (/^tool:(cropImage|redactImage|editImage|annotateImage|frameImage)$/.test(item.id)) continue;
        const work = path.join(out, `${item.id.replace(":", "_")}`);
        fs.mkdirSync(work, { recursive: true });
        const src = path.join(work, name);
        fs.copyFileSync(src0, src);
        const t = Date.now();
        try {
          await sw.prepare(item.id, src, (s) => console.log(`   … ${s}`));
          const res = sw.needsStudio(item.id) ? await sw.applyStudio(item.id, src, studioSpecs[item.id]) : await sw.run(item.id, src);
          const produced = fs.readdirSync(work).filter((f) => f !== name);
          if (!produced.length && item.id !== "tool:extractArchive") throw new Error("nada gerado");
          console.log(`OK    ${name} ${item.id} -> ${path.basename(String(res))} (${Date.now() - t} ms)`);
          pass += 1;
        } catch (err) {
          console.log(`FALHA ${name} ${item.id}: ${String(err.message).split("\n")[0].slice(0, 200)}`);
          fail += 1;
        }
      }
    }
  }
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exitCode = fail ? 1 : 0;
})();
