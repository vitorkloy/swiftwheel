import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Circle, CloudFog, Copy, Highlighter, Minus, Move, Palette, Pen, Save, Square, Trash2, Type, Undo2, X } from 'lucide-react';

type ShotFormat = 'png' | 'jpeg' | 'webp';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Session {
  frameUrl?: string;
  dataUrl?: string;
  mode: 'region' | 'window';
  width: number;
  height: number;
  preset: Rect | null;
  cursor: { x: number; y: number } | null;
  hintAt?: { x: number; y: number } | null;
  copyOnSelect: boolean;
  format: ShotFormat;
  quality: number;
  language: 'pt' | 'en';
  demo?: boolean;
}

type Point = { x: number; y: number };
type Tool = 'select' | 'pen' | 'arrow' | 'rect' | 'ellipse' | 'line' | 'highlight' | 'text' | 'blur';
type ShapeTool = 'rect' | 'ellipse' | 'line' | 'arrow';

type Mark =
  | { tool: 'pen' | 'highlight'; color: string; size: number; points: Point[] }
  | { tool: 'arrow' | 'rect' | 'ellipse' | 'line' | 'blur'; color: string; size: number; a: Point; b: Point }
  | { tool: 'text'; color: string; size: number; at: Point; text: string };

type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const COLORS = ['#ffffff', '#111111', '#ff4d4f', '#ffd400', '#3dd68c', '#4c8dff'];
const WIDTHS = [2, 4, 8];

const COPY: Record<Session['language'], Record<string, string>> = {
  pt: {
    pen: 'Caneta', shapes: 'Formas', arrow: 'Seta', rect: 'Retângulo', ellipse: 'Círculo', line: 'Linha', highlight: 'Marca', text: 'Texto', blur: 'Desfoque', undo: 'Desfazer',
    copy: 'Copiar', save: 'Guardar', cancel: 'Cancelar', discardText: 'Descartar texto',
    deleteText: 'Apagar texto', saveText: 'Confirmar texto', textSize: 'Tamanho do texto', moveText: 'Mover texto',
    color: 'Cor', custom: 'Cor personalizada',
    copied: 'Copiado', saved: 'Guardado', select: 'Selecionar área',
  },
  en: {
    pen: 'Pen', shapes: 'Shapes', arrow: 'Arrow', rect: 'Rectangle', ellipse: 'Circle', line: 'Line', highlight: 'Marker', text: 'Text', blur: 'Blur', undo: 'Undo',
    copy: 'Copy', save: 'Save', cancel: 'Cancel', discardText: 'Discard text',
    deleteText: 'Delete text', saveText: 'Confirm text', textSize: 'Text size', moveText: 'Move text',
    color: 'Color', custom: 'Custom color',
    copied: 'Copied', saved: 'Saved', select: 'Select area',
  },
};

function demoSession(): Session {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext('2d');
  if (g) {
    const wash = g.createLinearGradient(0, 0, 1280, 720);
    wash.addColorStop(0, '#1c2430');
    wash.addColorStop(1, '#10141a');
    g.fillStyle = wash;
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#d7dde6';
    g.fillRect(180, 120, 420, 240);
    g.fillStyle = '#8ea0b8';
    g.beginPath();
    g.arc(860, 300, 120, 0, Math.PI * 2);
    g.fill();
  }
  return {
    dataUrl: canvas.toDataURL('image/png'),
    mode: 'region',
    width: 1280,
    height: 720,
    preset: null,
    cursor: { x: 640, y: 360 },
    copyOnSelect: false,
    format: 'png',
    quality: 92,
    language: 'pt',
    demo: true,
  };
}

function clampRect(rect: Rect, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.min(rect.x, bounds.width - 1));
  const y = Math.max(0, Math.min(rect.y, bounds.height - 1));
  const right = Math.max(x + 1, Math.min(rect.x + rect.width, bounds.width));
  const bottom = Math.max(y + 1, Math.min(rect.y + rect.height, bounds.height));
  return { x, y, width: right - x, height: bottom - y };
}

function normalize(a: Point, b: Point, bounds: { width: number; height: number }): Rect {
  return clampRect({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }, bounds);
}

function hitHandle(point: Point, rect: Rect | null): Handle | null {
  if (!rect) return null;
  const spots: Array<[Handle, number, number]> = [
    ['nw', rect.x, rect.y],
    ['n', rect.x + rect.width / 2, rect.y],
    ['ne', rect.x + rect.width, rect.y],
    ['e', rect.x + rect.width, rect.y + rect.height / 2],
    ['se', rect.x + rect.width, rect.y + rect.height],
    ['s', rect.x + rect.width / 2, rect.y + rect.height],
    ['sw', rect.x, rect.y + rect.height],
    ['w', rect.x, rect.y + rect.height / 2],
  ];
  for (const [handle, x, y] of spots) {
    if (Math.abs(point.x - x) <= 10 && Math.abs(point.y - y) <= 10) return handle;
  }
  return null;
}

function resizeRect(rect: Rect, handle: Handle, point: Point, bounds: { width: number; height: number }): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes('w')) left = point.x;
  if (handle.includes('e')) right = point.x;
  if (handle.includes('n')) top = point.y;
  if (handle.includes('s')) bottom = point.y;
  return normalize({ x: left, y: top }, { x: right, y: bottom }, bounds);
}

function inside(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

function textFontPx(size: number) {
  return 11 + size * 2;
}

function textFont(size: number) {
  return `${textFontPx(size)}px "Segoe UI", sans-serif`;
}

function textBounds(mark: Extract<Mark, { tool: 'text' }>): Rect {
  const probe = document.createElement('canvas').getContext('2d');
  const height = textFontPx(mark.size);
  if (!probe) return { x: mark.at.x, y: mark.at.y, width: Math.max(24, mark.text.length * height * 0.55), height };
  probe.font = textFont(mark.size);
  const width = Math.max(24, probe.measureText(mark.text).width + 8);
  return { x: mark.at.x - 4, y: mark.at.y - 2, width, height: height + 8 };
}

function hitText(point: Point, marks: Mark[]): number {
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    if (mark.tool !== 'text') continue;
    if (inside(point, textBounds(mark))) return index;
  }
  return -1;
}

function drawArrow(g: CanvasRenderingContext2D, a: Point, b: Point, color: string, size: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = Math.max(12, size * 4);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = size;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x - ux * head * 0.75, b.y - uy * head * 0.75);
  g.stroke();
  g.beginPath();
  g.moveTo(b.x, b.y);
  g.lineTo(b.x - ux * head - uy * head * 0.45, b.y - uy * head + ux * head * 0.45);
  g.lineTo(b.x - ux * head + uy * head * 0.45, b.y - uy * head - ux * head * 0.45);
  g.closePath();
  g.fill();
}

function paintMark(g: CanvasRenderingContext2D, mark: Mark, image: HTMLImageElement | null, view: { width: number; height: number }) {
  g.save();
  if (mark.tool === 'pen' || mark.tool === 'highlight') {
    g.strokeStyle = mark.color;
    g.globalAlpha = mark.tool === 'highlight' ? 0.38 : 1;
    g.lineWidth = mark.tool === 'highlight' ? mark.size * 5 : mark.size;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    mark.points.forEach((point, index) => (index === 0 ? g.moveTo(point.x, point.y) : g.lineTo(point.x, point.y)));
    g.stroke();
  } else if (mark.tool === 'arrow') {
    drawArrow(g, mark.a, mark.b, mark.color, mark.size);
  } else if (mark.tool === 'line') {
    g.strokeStyle = mark.color;
    g.lineWidth = mark.size;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(mark.a.x, mark.a.y);
    g.lineTo(mark.b.x, mark.b.y);
    g.stroke();
  } else if (mark.tool === 'rect' || mark.tool === 'ellipse') {
    const x = Math.min(mark.a.x, mark.b.x);
    const y = Math.min(mark.a.y, mark.b.y);
    const width = Math.abs(mark.b.x - mark.a.x);
    const height = Math.abs(mark.b.y - mark.a.y);
    g.strokeStyle = mark.color;
    g.lineWidth = mark.size;
    g.beginPath();
    if (mark.tool === 'ellipse') g.ellipse(x + width / 2, y + height / 2, Math.max(0.5, width / 2), Math.max(0.5, height / 2), 0, 0, Math.PI * 2);
    else g.rect(x, y, width, height);
    g.stroke();
  } else if (mark.tool === 'text') {
    g.fillStyle = mark.color;
    g.font = textFont(mark.size);
    g.textBaseline = 'top';
    g.fillText(mark.text, mark.at.x, mark.at.y);
  } else if (mark.tool === 'blur' && image) {
    const x = Math.min(mark.a.x, mark.b.x);
    const y = Math.min(mark.a.y, mark.b.y);
    const width = Math.max(1, Math.abs(mark.b.x - mark.a.x));
    const height = Math.max(1, Math.abs(mark.b.y - mark.a.y));
    const scaleX = image.naturalWidth / Math.max(1, view.width);
    const scaleY = image.naturalHeight / Math.max(1, view.height);
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(width));
    off.height = Math.max(1, Math.round(height));
    const og = off.getContext('2d');
    if (og) {
      og.imageSmoothingEnabled = false;
      const block = 8;
      const smallW = Math.max(1, Math.round(off.width / block));
      const smallH = Math.max(1, Math.round(off.height / block));
      og.drawImage(image, x * scaleX, y * scaleY, width * scaleX, height * scaleY, 0, 0, smallW, smallH);
      og.drawImage(off, 0, 0, smallW, smallH, 0, 0, off.width, off.height);
      g.drawImage(off, x, y, width, height);
    }
  }
  g.restore();
}

function drawCursor(g: CanvasRenderingContext2D, cursor: Point) {
  g.save();
  g.translate(cursor.x, cursor.y);
  g.fillStyle = '#fff';
  g.strokeStyle = '#111';
  g.lineWidth = 1.4;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, 16);
  g.lineTo(4.2, 12.4);
  g.lineTo(8.2, 19);
  g.lineTo(11, 17.6);
  g.lineTo(6.8, 11.2);
  g.lineTo(12.4, 11);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

async function renderSelection(
  image: HTMLImageElement,
  selection: Rect,
  marks: Mark[],
  cursor: Point | null,
  format: ShotFormat,
  quality: number,
): Promise<{ dataUrl: string; pngDataUrl: string }> {
  const viewW = image.clientWidth || image.naturalWidth || 1;
  const viewH = image.clientHeight || image.naturalHeight || 1;
  const scaleX = image.naturalWidth / viewW;
  const scaleY = image.naturalHeight / viewH;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(selection.width * scaleX));
  canvas.height = Math.max(1, Math.round(selection.height * scaleY));
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas');
  g.drawImage(
    image,
    selection.x * scaleX,
    selection.y * scaleY,
    selection.width * scaleX,
    selection.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  g.save();
  g.scale(scaleX, scaleY);
  g.translate(-selection.x, -selection.y);
  g.beginPath();
  g.rect(selection.x, selection.y, selection.width, selection.height);
  g.clip();
  if (cursor && inside(cursor, selection)) drawCursor(g, cursor);
  for (const mark of marks) paintMark(g, mark, image, { width: image.clientWidth, height: image.clientHeight });
  g.restore();
  const pngDataUrl = canvas.toDataURL('image/png');
  if (format === 'png') return { dataUrl: pngDataUrl, pngDataUrl };
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality / 100));
  if (!blob) return { dataUrl: pngDataUrl, pngDataUrl };
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataUrl, pngDataUrl };
}

export const CaptureOverlay: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [committed, setCommitted] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [shapeTool, setShapeTool] = useState<ShapeTool>('rect');
  const [shapesOpen, setShapesOpen] = useState(false);
  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState(4);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [textAt, setTextAt] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState('');
  const [textSize, setTextSize] = useState(4);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [textEditIndex, setTextEditIndex] = useState<number | null>(null);
  const textAtRef = useRef<Point | null>(null);
  const textValueRef = useRef('');
  const textSizeRef = useRef(4);
  const textEditIndexRef = useRef<number | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const textStampRef = useRef(0);
  textAtRef.current = textAt;
  textValueRef.current = textValue;
  textSizeRef.current = textSize;
  textEditIndexRef.current = textEditIndex;
  const [status, setStatus] = useState('');
  const [colorsOpen, setColorsOpen] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const [dimIn, setDimIn] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const [imageEpoch, setImageEpoch] = useState(0);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const frameReadyRef = useRef(false);
  const frameKeyRef = useRef('');
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [barBox, setBarBox] = useState({ width: 420, height: 40 });
  const [hoverHandle, setHoverHandle] = useState<Handle | null>(null);
  const [resizeHandle, setResizeHandle] = useState<Handle | null>(null);
  const [hoverMove, setHoverMove] = useState(false);
  const [hoverText, setHoverText] = useState(false);
  const [moving, setMoving] = useState(false);
  const [movingText, setMovingText] = useState(false);
  const [tipAt, setTipAt] = useState<Point | null>(null);
  const draftRef = useRef<Mark | null>(null);
  const dragRef = useRef<
    | { kind: 'create'; origin: Point; current: Point }
    | { kind: 'move'; origin: Point; rect: Rect }
    | { kind: 'resize'; handle: Handle; rect: Rect }
    | { kind: 'draw'; origin: Point; current: Point }
    | { kind: 'move-text'; index: number; origin: Point; startAt: Point; moved: boolean }
    | { kind: 'move-text-draft'; origin: Point; startAt: Point }
    | null
  >(null);

  useEffect(() => {
    const apply = (next: Session | null) => {
      closingRef.current = false;
      setClosing(false);
      setTextAt(null);
      setTextValue('');
      setTextEditIndex(null);
      setStatus('');
      setTool('select');
      if (!next) {
        // Janela escondida para reaproveitar: volta a vazio (documento transparente).
        frameKeyRef.current = '';
        frameReadyRef.current = false;
        setFrameReady(false);
        setDimIn(false);
        setSession(null);
        setSelection(null);
        setCommitted(false);
        setMarks([]);
        setDraft(null);
        setTipAt(null);
        return;
      }
      const preset = next.preset && next.preset.width > 4 ? next.preset : null;
      const frame = next.frameUrl || next.dataUrl || '';
      if (frameKeyRef.current !== frame) {
        frameKeyRef.current = frame;
        frameReadyRef.current = false;
        setFrameReady(false);
        setDimIn(false);
      }
      setSession(next);
      setColorsOpen(false);
      setSelection(preset);
      setCommitted(Boolean(preset));
      setMarks([]);
      setDraft(null);
      setTipAt(preset ? null : (next.hintAt || next.cursor || null));
    };
    if (!window.electron?.onScreenshotSession) {
      apply(demoSession());
      return;
    }
    const stop = window.electron.onScreenshotSession(apply);
    const stopVisible = window.electron.onScreenshotVisible?.(() => {
      // Dois frames: garante que o freeze já pintou antes do esmaecer começar.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setDimIn(true));
      });
    });
    void window.electron.getScreenshotSession?.().then((pending) => {
      if (pending) apply(pending);
    });
    return () => {
      stop();
      stopVisible?.();
    };
  }, []);

  /**
   * O buffer do canvas só é (re)alocado quando o tamanho da sessão muda. Antes `canvas.width` era
   * reatribuído em todo o redraw — e o redraw depende de `selection`, logo cada mousemove ao criar,
   * mover ou redimensionar a seleção realocava e limpava um bitmap do tamanho do desktop: o "travado".
   */
  const canvasInkRef = useRef(false);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(session.width * dpr);
    const h = Math.round(session.height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvasInkRef.current = true;
  }, [session?.width, session?.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const view = session ? { width: session.width, height: session.height } : null;
    if (!canvas || !image || !view) return;
    const painted = marks.filter((_, index) => index !== textEditIndex);
    const visible = draft ? [...painted, draft] : painted;
    const showCursor = Boolean(session?.cursor && (!selection || inside(session.cursor, selection)));
    /** Sem tinta para desenhar: não tocar no canvas (arrastar a seleção vazia fica só em CSS). */
    if (!visible.length && !showCursor) {
      if (!canvasInkRef.current) return;
      canvasInkRef.current = false;
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvasInkRef.current = true;
    const dpr = window.devicePixelRatio || 1;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view.width, view.height);
    if (selection && selection.width > 1 && selection.height > 1) {
      g.beginPath();
      g.rect(selection.x, selection.y, selection.width, selection.height);
      g.clip();
    }
    for (const mark of visible) paintMark(g, mark, image, view);
    if (showCursor && session?.cursor) drawCursor(g, session.cursor);
    g.restore();
  }, [marks, draft, session, imageEpoch, selection, textEditIndex]);

  const label = COPY[session?.language || 'pt'];
  const bounds = { width: session?.width || 0, height: session?.height || 0 };
  const showBar = Boolean(session) && committed && Boolean(selection);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const next = { width: bar.offsetWidth, height: bar.offsetHeight };
    setBarBox((current) => (current.width === next.width && current.height === next.height ? current : next));
  }, [showBar, tool, color, size, status, colorsOpen]);

  const pointFrom = (event: { clientX: number; clientY: number }): Point => {
    const stage = stageRef.current;
    const rect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - rect.top)),
    };
  };

  const selectionRef = useRef<Rect | null>(null);
  selectionRef.current = selection;

  const remember = (rect: Rect | null) => {
    if (!session || session.demo || !rect) return;
    void window.electron?.screenshotAction?.({
      action: 'remember',
      region: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  };

  const exportShot = useCallback(async () => {
    if (!session || !selection || !imageRef.current) return null;
    return renderSelection(imageRef.current, selection, marks, session.cursor, session.format, session.quality);
  }, [marks, selection, session]);

  const run = useCallback(async (action: 'copy' | 'save' | 'pin' | 'wheel' | 'cancel') => {
    if (action === 'cancel') {
      if (session?.demo) {
        setSelection(null);
        return;
      }
      if (closingRef.current) return;
      closingRef.current = true;
      setClosing(true);
      // Esmaece o escurecimento e só então pede para esconder: sem salto, só "clarear" como no Windows.
      const veil = veilRef.current;
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        veil?.removeEventListener('transitionend', onEnd);
        void window.electron?.screenshotAction?.({ action: 'cancel' });
      };
      const onEnd = (event: TransitionEvent) => {
        if (event.target === veil && event.propertyName === 'opacity') send();
      };
      if (!veil || getComputedStyle(veil).opacity === '0') {
        send();
      } else {
        veil.addEventListener('transitionend', onEnd);
        window.setTimeout(send, 400);
      }
      return;
    }
    const shot = await exportShot();
    if (!shot || !selection) return;
    if (session?.demo) {
      const link = document.createElement('a');
      link.href = shot.dataUrl;
      link.download = 'vor-captura.png';
      link.click();
      setStatus(label.saved);
      return;
    }
    const result = await window.electron?.screenshotAction?.({
      action,
      dataUrl: shot.dataUrl,
      pngDataUrl: shot.pngDataUrl,
      width: selection.width,
      height: selection.height,
    });
    if (!result?.ok) return;
    if (action === 'copy') {
      void window.electron?.screenshotAction?.({ action: 'cancel' });
      return;
    }
    if (action === 'save') setStatus(label.saved);
  }, [exportShot, label.saved, selection, session?.demo]);

  const textCancelRef = useRef(false);
  const clearTextDraft = useCallback(() => {
    textAtRef.current = null;
    textValueRef.current = '';
    textEditIndexRef.current = null;
    setTextAt(null);
    setTextValue('');
    setTextEditIndex(null);
    setTextSizeOpen(false);
  }, []);

  const cancelText = useCallback(() => {
    textCancelRef.current = true;
    textStampRef.current = Date.now();
    clearTextDraft();
    setTool('select');
    window.setTimeout(() => { textCancelRef.current = false; }, 0);
  }, [clearTextDraft]);

  const deleteText = useCallback(() => {
    const editIndex = textEditIndexRef.current;
    textCancelRef.current = true;
    textStampRef.current = Date.now();
    clearTextDraft();
    setTool('select');
    if (editIndex != null) setMarks((current) => current.filter((_, index) => index !== editIndex));
    window.setTimeout(() => { textCancelRef.current = false; }, 0);
  }, [clearTextDraft]);

  const commitText = useCallback(() => {
    const value = textValueRef.current.trim();
    const at = textAtRef.current;
    const editIndex = textEditIndexRef.current;
    const draftSize = textSizeRef.current;
    clearTextDraft();
    setTool('select');
    if (!at) return;
    if (!value) {
      if (editIndex != null) setMarks((current) => current.filter((_, index) => index !== editIndex));
      return;
    }
    const next: Mark = { tool: 'text', color, size: draftSize, at, text: value };
    setMarks((current) => {
      if (editIndex == null) return [...current, next];
      return current.map((mark, index) => (index === editIndex ? next : mark));
    });
  }, [clearTextDraft, color]);

  const beginTextEdit = useCallback((at: Point, value: string, editIndex: number | null) => {
    textStampRef.current = Date.now();
    textAtRef.current = at;
    textValueRef.current = value;
    textEditIndexRef.current = editIndex;
    setTextAt(at);
    setTextValue(value);
    setTextEditIndex(editIndex);
    if (editIndex != null) {
      const mark = marks[editIndex];
      if (mark?.tool === 'text') {
        setColor(mark.color);
        textSizeRef.current = mark.size;
        setTextSize(mark.size);
        return;
      }
    }
    textSizeRef.current = size;
    setTextSize(size);
  }, [marks, size]);

  const undo = useCallback(() => {
    setDraft(null);
    draftRef.current = null;
    setMarks((current) => current.slice(0, -1));
  }, []);

  useEffect(() => {
    if (!textAt) return;
    textStampRef.current = Date.now();
    const id = window.setTimeout(() => {
      const input = textInputRef.current;
      if (!input) return;
      input.focus();
      if (textEditIndexRef.current != null) input.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [textAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = document.activeElement instanceof HTMLInputElement;
      if (event.key === 'Escape') {
        if (typing || textAtRef.current) {
          event.preventDefault();
          cancelText();
          return;
        }
        void run('cancel');
      }
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void run('copy');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void run('save');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancelText, run, undo]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!session || event.button !== 0) return;
    setColorsOpen(false);
    setShapesOpen(false);
    const point = pointFrom(event);
    const textHit = !textAt && selection && inside(point, selection) ? hitText(point, marks) : -1;
    if (textHit >= 0) {
      event.preventDefault();
      const mark = marks[textHit];
      if (mark?.tool !== 'text') return;
      try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* o ponteiro já pode ter sido solto */ }
      dragRef.current = { kind: 'move-text', index: textHit, origin: point, startAt: mark.at, moved: false };
      setMovingText(true);
      setHoverText(true);
      return;
    }
    if (tool === 'text' && selection && inside(point, selection)) {
      event.preventDefault();
      beginTextEdit(point, '', null);
      return;
    }
    if (textAt) commitText();
    try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* o ponteiro já pode ter sido solto */ }
    const handle = hitHandle(point, selection);
    if (handle && selection && committed) {
      dragRef.current = { kind: 'resize', handle, rect: selection };
      setResizeHandle(handle);
      return;
    }
    if (tool !== 'select' && selection && inside(point, selection)) {
      dragRef.current = { kind: 'draw', origin: point, current: point };
      return;
    }
    if (tool === 'select' && selection && inside(point, selection)) {
      dragRef.current = { kind: 'move', origin: point, rect: selection };
      setMoving(true);
      return;
    }
    setCommitted(false);
    setMarks([]);
    setDraft(null);
    draftRef.current = null;
    clearTextDraft();
    setTool('select');
    dragRef.current = { kind: 'create', origin: point, current: point };
  };

  /**
   * pointermove chega a 125–1000 Hz com ratos de alta taxa; cada um fazia setState + render.
   * Guardamos só o último ponto e processamos uma vez por frame (rAF).
   */
  const pendingMoveRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const applyMoveRef = useRef<(event: { clientX: number; clientY: number }) => void>(() => {});
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    pendingMoveRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (moveFrameRef.current != null) return;
    moveFrameRef.current = requestAnimationFrame(() => {
      moveFrameRef.current = null;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending) applyMoveRef.current(pending);
    });
  };
  const flushPointerMove = () => {
    if (moveFrameRef.current != null) {
      cancelAnimationFrame(moveFrameRef.current);
      moveFrameRef.current = null;
    }
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending) applyMoveRef.current(pending);
  };
  applyMoveRef.current = (event: { clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    const point = pointFrom(event);
    if (!selection) setTipAt(point);
    else setTipAt((current) => (current ? null : current));
    if (!drag) {
      if (hoverHandle) {
        setHoverMove(false);
        setHoverText(false);
        return;
      }
      const overText = Boolean(
        selection
        && !textAt
        && inside(point, selection)
        && hitText(point, marks) >= 0,
      );
      setHoverText(overText);
      const overMove = Boolean(
        committed
        && tool === 'select'
        && selection
        && !textAt
        && !overText
        && inside(point, selection)
        && !hitHandle(point, selection),
      );
      setHoverMove(overMove);
      return;
    }
    if (drag.kind === 'create') {
      drag.current = point;
      const next = normalize(drag.origin, point, bounds);
      selectionRef.current = next;
      setSelection(next);
    } else if (drag.kind === 'move') {
      const dx = point.x - drag.origin.x;
      const dy = point.y - drag.origin.y;
      const next = clampRect({ ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }, bounds);
      selectionRef.current = next;
      setSelection(next);
    } else if (drag.kind === 'resize') {
      const next = resizeRect(drag.rect, drag.handle, point, bounds);
      selectionRef.current = next;
      setSelection(next);
    } else if (drag.kind === 'move-text') {
      const dx = point.x - drag.origin.x;
      const dy = point.y - drag.origin.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      const nextAt = { x: drag.startAt.x + dx, y: drag.startAt.y + dy };
      setMarks((current) => current.map((mark, index) => (
        index === drag.index && mark.tool === 'text' ? { ...mark, at: nextAt } : mark
      )));
    } else if (drag.kind === 'move-text-draft') {
      const nextAt = {
        x: drag.startAt.x + (point.x - drag.origin.x),
        y: drag.startAt.y + (point.y - drag.origin.y),
      };
      textAtRef.current = nextAt;
      setTextAt(nextAt);
    } else if (drag.kind === 'draw') {
      drag.current = point;
      if (tool === 'pen' || tool === 'highlight') {
        const current = draftRef.current;
        const points = current && (current.tool === 'pen' || current.tool === 'highlight')
          ? [...current.points, point]
          : [drag.origin, point];
        const next: Mark = { tool: tool === 'highlight' ? 'highlight' : 'pen', color, size, points };
        draftRef.current = next;
        setDraft(next);
      } else if (tool === 'arrow' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'blur') {
        const next: Mark = { tool, color, size, a: drag.origin, b: point };
        draftRef.current = next;
        setDraft(next);
      }
    }
  };

  const onPointerUp = () => {
    // O último movimento ainda pode estar à espera do rAF: aplicá-lo antes de soltar.
    flushPointerMove();
    const drag = dragRef.current;
    dragRef.current = null;
    setResizeHandle(null);
    setMoving(false);
    setMovingText(false);
    if (!drag) return;
    if (drag.kind === 'create') {
      const next = normalize(drag.origin, drag.current, bounds);
      if (next.width < 6 || next.height < 6) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      selectionRef.current = next;
      setSelection(next);
      setCommitted(true);
      remember(next);
      if (session?.copyOnSelect && imageRef.current) {
        void renderSelection(imageRef.current, next, marks, session.cursor, session.format, session.quality)
          .then((shot) => {
            if (session.demo) return;
            return window.electron?.screenshotAction?.({
              action: 'copy',
              dataUrl: shot.dataUrl,
              pngDataUrl: shot.pngDataUrl,
              width: next.width,
              height: next.height,
            });
          })
          .then(() => setStatus(label.copied))
          .catch(() => undefined);
      }
      return;
    }
    if (drag.kind === 'move' || drag.kind === 'resize') {
      remember(selectionRef.current);
      return;
    }
    if (drag.kind === 'move-text') {
      if (!drag.moved) {
        const mark = marks[drag.index];
        if (mark?.tool === 'text') beginTextEdit(mark.at, mark.text, drag.index);
      }
      return;
    }
    if (drag.kind === 'move-text-draft') {
      textStampRef.current = Date.now();
      textInputRef.current?.focus();
      return;
    }
    const drawn = draftRef.current;
    draftRef.current = null;
    if (drawn && (drawn.tool !== 'pen' && drawn.tool !== 'highlight' || drawn.points.length > 1)) {
      setMarks((current) => [...current, drawn]);
    }
    setDraft(null);
  };

  if (!session) return null;

  const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const handlePoint = (handle: Handle): Point => {
    if (!selection) return { x: 0, y: 0 };
    const right = selection.x + selection.width;
    const bottom = selection.y + selection.height;
    const midX = selection.x + selection.width / 2;
    const midY = selection.y + selection.height / 2;
    if (handle === 'nw') return { x: selection.x, y: selection.y };
    if (handle === 'n') return { x: midX, y: selection.y };
    if (handle === 'ne') return { x: right, y: selection.y };
    if (handle === 'e') return { x: right, y: midY };
    if (handle === 'se') return { x: right, y: bottom };
    if (handle === 's') return { x: midX, y: bottom };
    if (handle === 'sw') return { x: selection.x, y: bottom };
    return { x: selection.x, y: midY };
  };

  let barLeft = 8;
  let barTop = 8;
  if (selection) {
    barLeft = selection.x + selection.width - barBox.width;
    barTop = selection.y + selection.height + 8;
    if (barLeft < 8) barLeft = Math.max(8, selection.x);
    if (barLeft + barBox.width > bounds.width - 8) barLeft = Math.max(8, bounds.width - barBox.width - 8);
    if (barTop + barBox.height > bounds.height - 8) barTop = selection.y - barBox.height - 8;
    if (barTop < 8) barTop = 8;
  }

  const shapeTools: Array<{ id: ShapeTool; label: string; icon: React.ReactNode }> = [
    { id: 'rect', label: label.rect, icon: <Square size={16} strokeWidth={1.75} /> },
    { id: 'ellipse', label: label.ellipse, icon: <Circle size={16} strokeWidth={1.75} /> },
    { id: 'line', label: label.line, icon: <Minus size={16} strokeWidth={1.75} /> },
    { id: 'arrow', label: label.arrow, icon: <ArrowUpRight size={16} strokeWidth={1.75} /> },
  ];
  const activeShape = shapeTools.find((item) => item.id === shapeTool) ?? shapeTools[0];
  const tools: Array<{ id: Tool; label: string; icon: React.ReactNode }> = [
    { id: 'pen', label: label.pen, icon: <Pen size={16} strokeWidth={1.75} /> },
    { id: 'highlight', label: label.highlight, icon: <Highlighter size={16} strokeWidth={1.75} /> },
    { id: 'text', label: label.text, icon: <Type size={16} strokeWidth={1.75} /> },
    { id: 'blur', label: label.blur, icon: <CloudFog size={16} strokeWidth={1.75} /> },
  ];
  const textPx = textFontPx(textSize);
  const editingMark = textEditIndex != null ? marks[textEditIndex] : null;
  const textColor = editingMark?.tool === 'text' ? editingMark.color : color;

  const stageCursor = movingText
    ? 'grabbing'
    : hoverText
      ? 'grab'
      : textAt || tool === 'text'
        ? 'text'
        : resizeHandle
          ? `${resizeHandle}-resize`
          : hoverHandle
            ? `${hoverHandle}-resize`
            : moving
              ? 'grabbing'
              : hoverMove
                ? 'grab'
                : 'crosshair';

  return (
    <div
      ref={stageRef}
      className={`cap-stage${frameReady ? ' is-ready' : ''}${textAt ? ' is-text' : ''}${closing ? ' is-out' : ''}`}
      style={{ cursor: stageCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img
        ref={imageRef}
        src={session.frameUrl || session.dataUrl}
        alt=""
        draggable={false}
        onLoad={() => {
          setImageEpoch((epoch) => epoch + 1);
          setFrameReady(true);
          const frameKey = frameKeyRef.current;
          const signal = () => {
            if (session.demo) {
              setDimIn(true);
              return;
            }
            if (frameReadyRef.current || frameKeyRef.current !== frameKey) return;
            frameReadyRef.current = true;
            void window.electron?.screenshotAction?.({ action: 'ready' });
          };
          /**
           * Janela escondida (reaproveitada): o Chromium não corre rAF, e esperar por ele caía no
           * fallback de 700 ms. Basta o bitmap estar descodificado; a janela é transparente, logo
           * mostrar antes do primeiro paint mostra o mesmo ecrã por baixo. Visível: dois frames.
           */
          const image = imageRef.current;
          const decoded = image && typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve();
          void decoded.then(() => {
            if (document.visibilityState === 'visible') {
              requestAnimationFrame(() => requestAnimationFrame(signal));
            } else {
              signal();
            }
          });
        }}
      />
      <canvas ref={canvasRef} />
      <div ref={veilRef} className={`cap-veil${dimIn ? ' is-in' : ''}`}>
        {!selection && <div className="cap-dim" style={{ left: 0, top: 0, right: 0, bottom: 0 }} />}
        {selection && (
          <>
            <div className="cap-dim" style={{ left: 0, top: 0, right: 0, height: selection.y }} />
            <div className="cap-dim" style={{ left: 0, top: selection.y + selection.height, right: 0, bottom: 0 }} />
            <div className="cap-dim" style={{ left: 0, top: selection.y, width: selection.x, height: selection.height }} />
            <div className="cap-dim" style={{ left: selection.x + selection.width, top: selection.y, right: 0, height: selection.height }} />
          </>
        )}
      </div>
      {!selection && !committed && tipAt && (
        <div
          className="cap-tip"
          style={{
            left: 0,
            top: 0,
            transform: `translate3d(${Math.min(tipAt.x + 16, Math.max(8, bounds.width - 140))}px, ${Math.min(tipAt.y + 20, Math.max(8, bounds.height - 28))}px, 0)`,
          }}
        >
          {label.select}
        </div>
      )}
      {selection && (
        <>
          <div className="cap-sel" style={{ left: 0, top: 0, transform: `translate3d(${selection.x}px, ${selection.y}px, 0)`, width: selection.width, height: selection.height }}>
            <span className={`cap-size${selection.y < 28 ? ' is-inside' : ''}`}>{Math.round(selection.width)} × {Math.round(selection.height)}</span>
          </div>
          {handles.map((handle) => {
            const at = handlePoint(handle);
            return (
              <button
                key={handle}
                type="button"
                className="cap-handle"
                aria-label={handle}
                style={{ left: at.x, top: at.y, cursor: `${handle}-resize` }}
                onPointerEnter={() => setHoverHandle(handle)}
                onPointerLeave={() => setHoverHandle((current) => (current === handle ? null : current))}
                onPointerDown={(event) => {
                  if (!selection || !committed) return;
                  event.preventDefault();
                  event.stopPropagation();
                  try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* ignore */ }
                  dragRef.current = { kind: 'resize', handle, rect: selection };
                  setResizeHandle(handle);
                }}
              />
            );
          })}
        </>
      )}
      {showBar && (
        <div ref={barRef} className="cap-bar" style={{ left: barLeft, top: barTop }} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={tool === 'pen' ? 'is-on' : ''}
            aria-label={label.pen}
            title={label.pen}
            onClick={() => { setShapesOpen(false); setTool(tool === 'pen' ? 'select' : 'pen'); }}
          >
            <Pen size={16} strokeWidth={1.75} />
          </button>
          <span className="cap-shape">
            <button
              type="button"
              className={tool === shapeTool ? 'is-on' : ''}
              aria-label={label.shapes}
              title={label.shapes}
              aria-expanded={shapesOpen}
              onClick={() => {
                setColorsOpen(false);
                setShapesOpen((open) => !open);
                if (tool !== shapeTool) setTool(shapeTool);
              }}
            >
              {activeShape.icon}
            </button>
            {shapesOpen && (
              <span className={`cap-shape-pop${barTop < 88 ? ' is-below' : ''}`}>
                {shapeTools.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={shapeTool === item.id ? 'is-on' : ''}
                    aria-label={item.label}
                    title={item.label}
                    onClick={() => {
                      setShapeTool(item.id);
                      setTool(item.id);
                      setShapesOpen(false);
                    }}
                  >
                    {item.icon}
                  </button>
                ))}
              </span>
            )}
          </span>
          {tools.slice(1).map((item) => (
            <button
              key={item.id}
              type="button"
              className={tool === item.id ? 'is-on' : ''}
              aria-label={item.label}
              title={item.label}
              onClick={() => { setShapesOpen(false); setTool(tool === item.id ? 'select' : item.id); }}
            >
              {item.icon}
            </button>
          ))}
          <i className="cap-rule" />
          <span className="cap-color">
            <button
              type="button"
              className={`cap-swatch${colorsOpen ? ' is-on' : ''}`}
              style={{ background: color }}
              aria-label={label.color}
              title={label.color}
              aria-expanded={colorsOpen}
              onClick={() => { setShapesOpen(false); setColorsOpen((open) => !open); }}
            />
            {colorsOpen && (
              <span className={`cap-color-pop${barTop < 72 ? ' is-below' : ''}`}>
                {COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className={`cap-swatch${color === swatch ? ' is-on' : ''}`}
                    style={{ background: swatch }}
                    aria-label={swatch}
                    onClick={() => { setColor(swatch); setColorsOpen(false); }}
                  />
                ))}
                <button type="button" aria-label={label.custom} title={label.custom} onClick={() => colorInputRef.current?.click()}>
                  <Palette size={16} strokeWidth={1.75} />
                </button>
                <input
                  ref={colorInputRef}
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#ff4d4f'}
                  aria-label={label.custom}
                  onChange={(event) => { setColor(event.target.value); setColorsOpen(false); }}
                />
              </span>
            )}
          </span>
          <i className="cap-rule" />
          <span className="cap-widths">
            {WIDTHS.map((width) => (
              <button key={width} type="button" className={size === width ? 'is-on' : ''} onClick={() => setSize(width)} aria-label={`${width}px`}>
                <i style={{ width, height: width }} />
              </button>
            ))}
          </span>
          <i className="cap-rule" />
          <button type="button" aria-label={label.undo} title={label.undo} disabled={marks.length === 0} onClick={undo}><Undo2 size={16} strokeWidth={1.75} /></button>
          <button type="button" aria-label={label.copy} title={status === label.copied ? label.copied : label.copy} onClick={() => void run('copy')}><Copy size={16} strokeWidth={1.75} /></button>
          <button type="button" aria-label={label.save} title={status === label.saved ? label.saved : label.save} onClick={() => void run('save')}><Save size={16} strokeWidth={1.75} /></button>
          <button type="button" aria-label={label.cancel} title={label.cancel} onClick={() => void run('cancel')}><X size={16} strokeWidth={1.75} /></button>
          <span className="cap-live" role="status">{status}</span>
        </div>
      )}
      {textAt && (
        <div
          className="cap-text-editor"
          style={{ left: textAt.x, top: textAt.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="cap-text-wrap" style={{ fontSize: textPx }}>
            <input
              ref={textInputRef}
              className="cap-text"
              style={{
                color: textColor,
                width: `${Math.min(28, Math.max(2, (textValue || ' ').length + 1))}ch`,
              }}
              value={textValue}
              spellCheck={false}
              onChange={(event) => {
                textValueRef.current = event.target.value;
                setTextValue(event.target.value);
              }}
              onBlur={() => {
                window.setTimeout(() => {
                  if (textCancelRef.current) return;
                  if (Date.now() - textStampRef.current < 280) {
                    textInputRef.current?.focus();
                    return;
                  }
                  const active = document.activeElement;
                  if (active === textInputRef.current) return;
                  if (active instanceof HTMLElement && active.closest('.cap-text-editor')) {
                    textInputRef.current?.focus();
                    return;
                  }
                  commitText();
                }, 0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelText();
                  return;
                }
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitText();
                }
                event.stopPropagation();
              }}
            />
            <button type="button" className="cap-text-x" aria-label={label.discardText} title={label.discardText} onClick={cancelText}>
              <X size={10} strokeWidth={2.25} />
            </button>
          </div>
          <div className="cap-text-tools">
            <button
              type="button"
              className="cap-text-move"
              aria-label={label.moveText}
              title={label.moveText}
              onPointerDown={(event) => {
                if (event.button !== 0 || !textAt) return;
                event.preventDefault();
                event.stopPropagation();
                textStampRef.current = Date.now();
                try { stageRef.current?.setPointerCapture(event.pointerId); } catch { /* o ponteiro já pode ter sido solto */ }
                dragRef.current = { kind: 'move-text-draft', origin: pointFrom(event), startAt: textAt };
                setMovingText(true);
              }}
            >
              <Move size={14} strokeWidth={1.75} />
            </button>
            <button type="button" aria-label={label.deleteText} title={label.deleteText} onClick={deleteText}>
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
            <button type="button" aria-label={label.saveText} title={label.saveText} onClick={commitText}>
              <Check size={14} strokeWidth={1.75} />
            </button>
            <i className="cap-rule" />
            <span className="cap-text-size">
              <button
                type="button"
                className={textSizeOpen ? 'is-on' : ''}
                aria-label={label.textSize}
                title={label.textSize}
                aria-expanded={textSizeOpen}
                onClick={() => {
                  textStampRef.current = Date.now();
                  setTextSizeOpen((open) => !open);
                }}
              >
                <span className="cap-text-size-glyph" style={{ fontSize: textFontPx(textSize) }}>A</span>
              </button>
              {textSizeOpen && (
                <span className="cap-text-size-pop" role="listbox" aria-label={label.textSize}>
                  {WIDTHS.map((width) => (
                    <button
                      key={width}
                      type="button"
                      role="option"
                      aria-selected={textSize === width}
                      className={textSize === width ? 'is-on' : ''}
                      aria-label={`${label.textSize} ${width}`}
                      title={`${label.textSize} ${width}`}
                      onClick={() => {
                        textStampRef.current = Date.now();
                        textSizeRef.current = width;
                        setTextSize(width);
                        setTextSizeOpen(false);
                        textInputRef.current?.focus();
                      }}
                    >
                      <span className="cap-text-size-glyph" style={{ fontSize: textFontPx(width) }}>A</span>
                    </button>
                  ))}
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
