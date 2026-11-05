import React from 'react';
import type { AppItem } from '../types';
import { getIcon } from '../iconMap';

/** Medidas do ShiftDrop (anel, pétalas, vão). O viewBox é −126…126. */
const M = {
  inner: 48 * 0.8 * 1.1 + 8 * 0.8,
  outer: 166 * 0.8 * 0.9,
  backdrop: 166 * 0.8 * 0.9 + 8 * 0.8,
  gap: 6.5,
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

function petalText(label: string): string {
  return label.split('·')[0]?.trim() || label;
}

interface FilePetalWheelProps {
  items: AppItem[];
  activeIndex: number | null;
  centerActive: boolean;
  formatLabel: string | null;
  bloom: boolean;
  /** Acento do VOR (Aparência → cor). Branco padrão vira o "sólido" do tema (preto no tema claro). */
  accent?: string;
  theme?: 'black' | 'white';
  /** 1 = sólido; < 1 = vidro. */
  surfaceAlpha?: number;
}

function readableOn(hex: string): string {
  const h = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return '#0a0a0b';
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.56 ? '#0a0a0b' : '#ffffff';
}

/** Paleta da roda a partir dos tokens Zenith (index.css), com o vidro aplicado como alfa. */
function palette(theme: 'black' | 'white', accentIn: string, alpha: number) {
  const light = theme === 'white';
  const accent = !accentIn || /^#ffffff$/i.test(accentIn) ? (light ? '#101012' : '#ffffff') : accentIn;
  const a = Math.min(1, Math.max(0.35, alpha));
  return {
    light,
    accent,
    onAccent: readableOn(accent),
    disc: light ? `rgba(246,246,248,${Math.min(0.97, a + 0.1)})` : `rgba(22,22,24,${Math.min(0.96, a + 0.08)})`,
    discLine: light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)',
    slice: light ? `rgba(255,255,255,${Math.min(1, a + 0.12)})` : `rgba(255,255,255,${0.05 + (1 - a) * 0.04})`,
    sliceTop: light ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.10)',
    sliceLine: light ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.075)',
    text: light ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.90)',
    textMuted: light ? 'rgba(0,0,0,0.32)' : 'rgba(255,255,255,0.34)',
    pill: light ? 'rgba(255,255,255,0.96)' : 'rgba(10,10,11,0.94)',
    pillLine: light ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)',
    pillText: light ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.94)',
    shadow: light ? '0 18px 44px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)' : '0 20px 50px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35)',
  };
}

/**
 * Roda do ShiftDrop no estilo Tangerine, com os tokens do VOR: disco de vidro, fatias em "pílula"
 * separadas por um vão, brilho interno no topo, fatia apontada cheia no acento e hub em pílula.
 * Só `transform`/`opacity` animam (60 fps); entrada com leve overshoot, saída curta.
 */
export function FilePetalWheel({ items, activeIndex, centerActive, formatLabel, bloom, accent = '#FFFFFF', theme = 'black', surfaceAlpha = 0.8 }: FilePetalWheelProps) {
  const count = items.length;
  const size = 200;
  const scale = size / 252;
  const P = palette(theme, accent, surfaceAlpha);
  const shell: React.CSSProperties = {
    width: size,
    height: size,
    transform: bloom ? 'translate(-50%, -50%) scale(1)' : 'translate(-50%, -50%) scale(0.86)',
    opacity: bloom ? 1 : 0,
    transition: bloom
      ? 'transform 160ms cubic-bezier(.2, 1.35, .35, 1), opacity 110ms ease-out'
      : 'transform 110ms cubic-bezier(.4, 0, 1, 1), opacity 90ms linear',
    willChange: 'transform, opacity',
  };
  const pillStyle: React.CSSProperties = {
    background: P.pill,
    boxShadow: `inset 0 0 0 1px ${P.pillLine}, 0 4px 14px rgba(0,0,0,${P.light ? 0.12 : 0.4})`,
    color: P.pillText,
    fontFamily: 'var(--font-radial)',
    fontWeight: 700,
    fontSize: 11,
    lineHeight: 1.2,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  };
  if (count === 0) {
    return (
      <div className="absolute left-0 top-0 pointer-events-none" style={shell}>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center"
          style={{ ...pillStyle, width: 220, padding: '14px 16px', borderRadius: 16, textTransform: 'none', letterSpacing: 0, fontWeight: 500, fontSize: 12.5, lineHeight: 1.5, boxShadow: `inset 0 0 0 1px ${P.pillLine}, ${P.shadow}` }}
        >
          {formatLabel}
        </div>
      </div>
    );
  }
  const labelWidth = count >= 6 ? 58 : 88;
  const labelSize = count >= 8 ? 9 : count >= 6 ? 9.5 : 10.5;
  const hovered = activeIndex !== null ? items[activeIndex] : null;
  const pill = centerActive
    ? 'Cancelar'
    : hovered
      ? (hovered.description || petalText(hovered.label))
      : (formatLabel || '');
  const gid = `fpw-${theme}`;

  return (
    <div className="absolute left-0 top-0 pointer-events-none" style={shell}>
      <svg viewBox="-126 -126 252 252" width={size} height={size} aria-hidden style={{ overflow: 'visible', filter: `drop-shadow(${P.light ? '0 10px 22px rgba(0,0,0,.16)' : '0 12px 26px rgba(0,0,0,.5)'})` }}>
        <defs>
          <linearGradient id={`${gid}-slice`} x1="0" y1="-1" x2="0" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="0" stopColor={P.sliceTop} />
            <stop offset="0.55" stopColor={P.slice} />
            <stop offset="1" stopColor={P.slice} />
          </linearGradient>
          <radialGradient id={`${gid}-disc`} cx="0" cy="-0.35" r="1.1" gradientUnits="objectBoundingBox">
            <stop offset="0" stopColor={P.light ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.06)'} />
            <stop offset="1" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>
        <circle r={M.backdrop} fill={P.disc} />
        <circle r={M.backdrop} fill={`url(#${gid}-disc)`} />
        <circle r={M.backdrop - 0.4} fill="none" stroke={P.discLine} strokeWidth="0.8" />
        {items.map((item, index) => {
          const active = index === activeIndex && !centerActive;
          const disabled = item.fileDisabled === true;
          return (
            <g
              key={`${item.id}-${index}`}
              style={{
                transform: active ? 'scale(1.035)' : 'scale(1)',
                transformOrigin: '0 0',
                transition: 'transform 120ms cubic-bezier(.2, 1.3, .4, 1)',
              }}
            >
              <path
                d={petalPath(index, count)}
                fill={active ? (disabled ? P.textMuted : P.accent) : `url(#${gid}-slice)`}
                stroke={active ? 'transparent' : P.sliceLine}
                strokeWidth="0.8"
              />
              {!active ? (
                <path d={petalPath(index, count)} fill="none" stroke={P.light ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.05)'} strokeWidth="0.6" transform="translate(0 0.7)" style={{ mixBlendMode: 'normal' }} />
              ) : null}
            </g>
          );
        })}
        <circle r={M.inner - 3} fill={P.light ? 'rgba(0,0,0,0.035)' : 'rgba(0,0,0,0.28)'} />
      </svg>
      {items.map((item, index) => {
        const active = index === activeIndex && !centerActive;
        const disabled = item.fileDisabled === true;
        const [x, y] = labelPoint(index, count);
        const color = active ? P.onAccent : (disabled ? P.textMuted : P.text);
        const text = petalText(item.label);
        // Palavra longa (COMPARTILHAR, METADADOS): reduz a fonte para caber numa linha da fatia.
        const longest = Math.max(...text.split(/\s+/).map((w) => w.length));
        const fit = Math.min(labelSize, (labelWidth - 4) / Math.max(1, longest * 0.68));
        const tooWide = longest * fit * 0.68 > labelWidth;
        const Icon = item.id.startsWith('conv:') ? null : getIcon(item.iconName);
        return (
          <div
            key={`${item.id}-label-${index}`}
            className="absolute text-center"
            style={{
              left: size / 2 + x * scale,
              top: size / 2 + y * scale,
              width: labelWidth,
              transform: `translate(-50%, -50%) scale(${active ? 1.04 : 1})`,
              transition: 'transform 120ms cubic-bezier(.2, 1.3, .4, 1), color 80ms linear',
              color,
              fontFamily: 'var(--font-radial)',
              fontWeight: 700,
              fontSize: fit,
              lineHeight: 1.1,
              letterSpacing: fit < labelSize ? '0.02em' : '0.045em',
              textTransform: 'uppercase',
            }}
          >
            {Icon ? <Icon size={count >= 8 ? 13 : 15} strokeWidth={1.9} style={{ margin: '0 auto 3px', display: 'block', opacity: active ? 1 : 0.82 }} /> : null}
            <div style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: tooWide ? 'anywhere' : 'normal',
            }}
            >
              {text}
            </div>
          </div>
        );
      })}
      {pill ? (
        <div
          className="absolute left-1/2 top-1/2 text-center pointer-events-none"
          style={{
            ...pillStyle,
            maxWidth: 104,
            padding: '6px 11px',
            borderRadius: 999,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            transform: 'translate(-50%, -50%)',
            ...(centerActive ? { background: P.accent, color: P.onAccent, boxShadow: 'none' } : {}),
          }}
        >
          {pill}
        </div>
      ) : null}
    </div>
  );
}
