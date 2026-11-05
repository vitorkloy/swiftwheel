import React from 'react';
import type { AppItem } from '../types';

/** Medidas do ShiftDrop (anel, pétalas, vão). O viewBox é −126…126. */
const M = {
  inner: 48 * 0.8 * 1.1 + 8 * 0.8,
  outer: 166 * 0.8 * 0.9,
  backdrop: 166 * 0.8 * 0.9 + 8 * 0.8,
  gap: 5 * 0.8,
  corner: 28 * 0.8 * 0.9,
  labelInner: 50 * 0.8,
};

function polar(radius: number, angle: number): [number, number] {
  return [Math.cos(angle) * radius, -Math.sin(angle) * radius];
}

/** Ângulo de referência das pétalas: 3 itens começam à esquerda; o resto no topo. */
export function filePetalStart(count: number): number {
  return count === 3 ? Math.PI : Math.PI / 2;
}

/**
 * Índice da fatia sob o vetor (dx, dy) a partir do centro — a mesma matemática do desenho.
 * `dy` positivo é para baixo (ecrã).
 */
export function filePetalIndexAt(dx: number, dy: number, count: number): number {
  if (count <= 0) return 0;
  const start = filePetalStart(count);
  const step = (Math.PI * 2) / count;
  const theta = Math.atan2(-dy, dx);
  const index = Math.round((start - theta) / step);
  return ((index % count) + count) % count;
}

/** Raio do buraco central em píxeis (viewBox −126…126 desenhado a 200px). */
export function filePetalDeadZonePx(): number {
  return Math.ceil(M.inner * (200 / 252)) + 2;
}

function fmt(radius: number, angle: number): string {
  return polar(radius, angle).map((n) => n.toFixed(3)).join(' ');
}

/** Um setor. O ângulo 0 fica no topo, como na roda do ShiftDrop. */
function petalPath(index: number, count: number): string {
  const start = filePetalStart(count) - (Math.PI * 2 * index) / count;
  const step = (Math.PI * 2) / count;
  const left = start - step / 2;
  const right = start + step / 2;
  const inset = (radius: number) => Math.asin(Math.min(0.95, M.gap / 2 / Math.max(radius, M.gap / 2 + 0.01)));
  const outerLeft = left + inset(M.outer);
  const outerRight = right - inset(M.outer);
  const innerLeft = left + inset(M.inner);
  const innerRight = right - inset(M.inner);
  const outerEase = Math.min(0.15, (outerRight - outerLeft) * 0.24);
  const innerEase = Math.min(0.18, (innerRight - innerLeft) * 0.18);
  const innerRadius = M.inner / Math.max(0.01, Math.cos(innerEase));
  const innerShoulder = innerRadius + M.inner * Math.tan(innerEase);
  const outerShoulder = M.outer - M.corner;
  const largeOuter = outerRight - outerEase - outerLeft - outerEase > Math.PI ? 1 : 0;
  const largeInner = innerRight - innerEase - innerLeft - innerEase > Math.PI ? 1 : 0;
  return [
    `M ${fmt(innerShoulder, left + inset(innerShoulder))}`,
    `L ${fmt(outerShoulder, left + inset(outerShoulder))}`,
    `Q ${fmt(M.outer, outerLeft)} ${fmt(M.outer, outerLeft + outerEase)}`,
    `A ${M.outer} ${M.outer} 0 ${largeOuter} 0 ${fmt(M.outer, outerRight - outerEase)}`,
    `Q ${fmt(M.outer, outerRight)} ${fmt(outerShoulder, right - inset(outerShoulder))}`,
    `L ${fmt(innerShoulder, right - inset(innerShoulder))}`,
    `Q ${fmt(innerRadius, right - inset(innerRadius))} ${fmt(M.inner, innerRight - innerEase)}`,
    `A ${M.inner} ${M.inner} 0 ${largeInner} 1 ${fmt(M.inner, innerLeft + innerEase)}`,
    `Q ${fmt(innerRadius, left + inset(innerRadius))} ${fmt(innerShoulder, left + inset(innerShoulder))} Z`,
  ].join(' ');
}

function labelPoint(index: number, count: number): [number, number] {
  const angle = filePetalStart(count) - (Math.PI * 2 * index) / count;
  const radius = M.labelInner + (M.outer - M.labelInner) * 0.56;
  return polar(radius, angle);
}

function shortLabel(label: string): string {
  const head = label.split('·')[0]?.trim() || label;
  return head.length > 14 ? `${head.slice(0, 13)}…` : head;
}

interface FilePetalWheelProps {
  items: AppItem[];
  activeIndex: number | null;
  centerActive: boolean;
  formatLabel: string | null;
  bloom: boolean;
}

/** Roda de setores do ShiftDrop, pintada com o tema escuro padrão do Vor. */
export function FilePetalWheel({ items, activeIndex, centerActive, formatLabel, bloom }: FilePetalWheelProps) {
  const count = items.length;
  const size = 200;
  const scale = size / 252;
  if (count === 0) {
    return (
      <div
        className="absolute left-0 top-0 pointer-events-none"
        style={{
          width: size,
          height: size,
          transform: bloom ? 'translate(-50%, -50%) scale(1)' : 'translate(-50%, -50%) scale(0.6)',
          opacity: bloom ? 1 : 0,
          transition: 'transform 90ms cubic-bezier(.1, .9, .2, 1), opacity 70ms linear',
        }}
      >
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center"
          style={{
            width: 200,
            boxSizing: 'border-box',
            padding: 16,
            borderRadius: 8,
            background: '#151515',
            border: '1px solid rgba(255,255,255,0.13)',
            color: 'rgba(255,255,255,0.9)',
            fontFamily: 'var(--font-radial)',
            fontWeight: 500,
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          {formatLabel}
        </div>
      </div>
    );
  }
  const hovered = activeIndex !== null ? items[activeIndex] : null;
  const pill = centerActive
    ? 'Cancelar'
    : hovered
      ? (hovered.description || shortLabel(hovered.label))
      : (formatLabel || '');

  return (
    <div
      className="absolute left-0 top-0 pointer-events-none"
      style={{
        width: size,
        height: size,
        transform: bloom ? 'translate(-50%, -50%) scale(1)' : 'translate(-50%, -50%) scale(0.6)',
        opacity: bloom ? 1 : 0,
        transition: 'transform 90ms cubic-bezier(.1, .9, .2, 1), opacity 70ms linear',
      }}
    >
      <svg viewBox="-126 -126 252 252" width={size} height={size} aria-hidden>
        <circle r={M.backdrop - 0.5} fill="#151515" />
        <circle r={M.backdrop - 0.5} fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="0.8" />
        {items.map((item, index) => {
          const active = index === activeIndex && !centerActive;
          const disabled = item.fileDisabled === true;
          const fill = active ? (disabled ? 'rgba(255,255,255,0.34)' : '#ffffff') : 'rgba(255,255,255,0.1)';
          return (
            <g key={`${item.id}-${index}`}>
              <path d={petalPath(index, count)} fill={fill} stroke={active ? 'transparent' : 'rgba(255,255,255,0.16)'} strokeWidth="0.75" />
            </g>
          );
        })}
        <circle r={M.inner - 1} fill="rgba(255,255,255,0.07)" />
        <circle r={M.inner - 6} fill="#111111" stroke="rgba(255,255,255,0.13)" strokeWidth="0.75" />
      </svg>
      {items.map((item, index) => {
        const active = index === activeIndex && !centerActive;
        const disabled = item.fileDisabled === true;
        const [x, y] = labelPoint(index, count);
        const color = active ? (disabled ? '#151515' : '#0a0a0b') : (disabled ? 'rgba(255,255,255,0.45)' : '#f4f4f5');
        return (
          <div
            key={`${item.id}-label-${index}`}
            className="absolute text-center"
            style={{
              left: size / 2 + x * scale,
              top: size / 2 + y * scale,
              width: 72,
              transform: 'translate(-50%, -50%)',
              color,
              fontFamily: 'var(--font-radial)',
              fontWeight: 600,
              fontSize: 12,
              lineHeight: 1.15,
              letterSpacing: '0.01em',
              textShadow: active ? 'none' : '0 1px 2px rgba(0,0,0,0.85)',
            }}
          >
            {shortLabel(item.label)}
          </div>
        );
      })}
      {pill ? (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-lg text-center pointer-events-none"
          style={{
            maxWidth: count === 0 ? 210 : 120,
            background: '#151515',
            border: '1px solid rgba(255,255,255,0.13)',
            color: 'rgba(255,255,255,0.93)',
            fontFamily: 'var(--font-radial)',
            fontWeight: 600,
            fontSize: 12,
            lineHeight: 1.2,
            letterSpacing: '0.3px',
          }}
        >
          {pill}
        </div>
      ) : null}
    </div>
  );
}
