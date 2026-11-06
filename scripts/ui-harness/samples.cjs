// Gera as amostras de imagem usadas pelas capturas do estúdio (sem depender de pastas externas).
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const dir = path.resolve(process.argv[2] || "ui-samples");
fs.mkdirSync(dir, { recursive: true });
const svg = (a, b, c) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>
<rect width="1600" height="1067" fill="url(#g)"/><circle cx="1150" cy="330" r="170" fill="#ffd27a" opacity=".9"/>
<path d="M0 820 L420 520 L760 760 L1080 470 L1600 860 L1600 1067 L0 1067 Z" fill="#1e2a3a" opacity=".85"/>
<path d="M0 900 L520 700 L900 880 L1300 680 L1600 900 L1600 1067 L0 1067 Z" fill="#0f1722"/></svg>`);
(async () => {
  await sharp(svg("#ff9a62", "#e8577e", "#6a4cc9")).jpeg({ quality: 88 }).toFile(path.join(dir, "photo.jpg"));
  await sharp(svg("#7dd3fc", "#38bdf8", "#1e3a8a")).png().toFile(path.join(dir, "image.png"));
  for (const n of ["doc.pdf", "video.mp4"]) fs.writeFileSync(path.join(dir, n), "");
  console.log("samples em", dir);
})();
