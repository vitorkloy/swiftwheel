"use strict";

/**
 * HEIC/HEIF → JPEG em memória (heic-convert / libheif-js). Sem ficheiro temporário.
 * Acima do limite ou se a conversão falhar, o renderer mostra o cartão de info.
 */
const fs = require("fs");

const MAX_HEIC_BYTES = 25 * 1024 * 1024;

const MESSAGES = {
  pt: {
    tooLarge: "Arquivo grande demais para prévia. Abra-o no aplicativo.",
    error: "Não foi possível gerar a prévia desta imagem.",
  },
  en: {
    tooLarge: "File is too large to preview. Open it in the app.",
    error: "Could not generate a preview for this image.",
  },
};

function messageFor(reason, lang) {
  const pack = lang === "en" ? MESSAGES.en : MESSAGES.pt;
  return pack[reason] || pack.error;
}

async function convertHeicPreview(filePath, size) {
  const bytes = size == null ? fs.statSync(filePath).size : Number(size) || 0;
  if (bytes > MAX_HEIC_BYTES) return { ok: false, reason: "tooLarge" };
  if (bytes < 12) return { ok: false, reason: "error" };
  try {
    const convert = require("heic-convert");
    const buffer = fs.readFileSync(filePath);
    const jpeg = await convert({ buffer, format: "JPEG", quality: 0.82 });
    if (!jpeg || !jpeg.length) return { ok: false, reason: "error" };
    return { ok: true, mime: "image/jpeg", body: Buffer.from(jpeg) };
  } catch {
    return { ok: false, reason: "error" };
  }
}

module.exports = {
  MAX_HEIC_BYTES,
  messageFor,
  convertHeicPreview,
};
