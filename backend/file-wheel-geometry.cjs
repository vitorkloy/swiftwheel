"use strict";

/** Tamanho base da FilePetalWheel (viewBox 252 desenhado a 200px). */
const FILE_PETAL_BASE_SIZE = 200;

function clampScale(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.7, Math.min(1.4, n));
}

/**
 * Raio visual da roda de arquivos (disco + rótulos), em DIPs.
 * Folga 1.32× o raio do canvas para a pílula vazia (220px) e as fatias com texto.
 */
function fileWheelVisualRadiusPx(scale = 1) {
  const size = FILE_PETAL_BASE_SIZE * clampScale(scale);
  return Math.ceil((size / 2) * 1.32);
}

/**
 * Centro da roda sempre inteiro na área visível (workArea) do monitor atual.
 * Se o raio não couber, usa o máximo que o rect permite.
 */
function clampCenterToWorkArea(point, workArea, radius) {
  const area = workArea && Number.isFinite(workArea.width) ? workArea : { x: 0, y: 0, width: 1, height: 1 };
  const r = Math.max(
    0,
    Math.min(Number(radius) || 0, area.width / 2, area.height / 2),
  );
  const x = Number(point && point.x);
  const y = Number(point && point.y);
  return {
    x: Math.round(Math.max(area.x + r, Math.min(x, area.x + area.width - r))),
    y: Math.round(Math.max(area.y + r, Math.min(y, area.y + area.height - r))),
  };
}

function clampHoldMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 300;
  return Math.round(Math.max(80, Math.min(1500, n)));
}

module.exports = {
  FILE_PETAL_BASE_SIZE,
  clampScale,
  fileWheelVisualRadiusPx,
  clampCenterToWorkArea,
  clampHoldMs,
};
