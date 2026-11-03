/**
 * Windows .exe / atalhos / barra de tarefas usam ICO embutido no PE; PNG em win.icon falha facilmente.
 * Gera build/icon.ico a partir de public/logo.svg antes do electron-builder.
 * Também gera o tray-icon.png otimizado para a bandeja do sistema.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const logoPath = join(root, "public", "logo.svg");
const traySvgPath = join(root, "public", "tray-icon.svg");
const pngPath = join(root, "public", "icon.png");
const trayPngPath = join(root, "public", "tray-icon.png");
const outDir = join(root, "build");
const icoPath = join(outDir, "icon.ico");

/**
 * 16, 24 e 32 são o que o atalho e a barra de tarefas realmente mostram.
 * O logo completo ainda tem um anel fino dentro do tile; nesses tamanhos o glifo
 * da bandeja, quase sem margem, lê-se no mesmo tamanho que os ícones vizinhos.
 */
async function rasterAppIcon(size) {
  const dest = size === 512 ? pngPath : join(root, "public", `icon-${size}.png`);
  if (size <= 32 && existsSync(traySvgPath)) {
    const glyph = Math.max(1, Math.round(size * 0.94));
    const radius = Math.max(2, Math.round(size * 0.22));
    const mark = await sharp(traySvgPath, { density: 768 })
      .resize(glyph, glyph, { fit: "fill" })
      .png()
      .toBuffer();
    const tile = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="#2c2c2c"/></svg>`,
    );
    await sharp(tile).composite([{ input: mark, gravity: "centre" }]).png().toFile(dest);
    return;
  }
  await sharp(logoPath, { density: 384 }).resize(size, size).png().toFile(dest);
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
if (existsSync(logoPath)) {
  for (const size of sizes) await rasterAppIcon(size);
  console.log(`generate-win-icon: rasterized ${logoPath}`);
}

const traySizes = [16, 20, 24, 32];
if (existsSync(traySvgPath)) {
  for (const size of traySizes) {
    const dest = size === 32 ? trayPngPath : join(root, "public", `tray-icon-${size}.png`);
    await sharp(traySvgPath, { density: 768 }).resize(size, size, { fit: "fill" }).png().toFile(dest);
  }
  await sharp(trayPngPath).toFile(join(root, "public", "tray-icon-32.png"));
  console.log(`generate-win-icon: rasterized tray icons (${traySizes.join(", ")})`);
}

if (!existsSync(pngPath)) {
  console.error(`generate-win-icon: missing ${pngPath}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const icoInputs = [16, 24, 32, 48, 64, 128, 256].map((size) => join(root, "public", `icon-${size}.png`));
await writeFile(icoPath, await pngToIco(icoInputs));
console.log(`generate-win-icon: wrote ${icoPath}`);
