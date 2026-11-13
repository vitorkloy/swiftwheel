import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, FolderOpen, Pin, X } from 'lucide-react';
import { highlightCode } from './highlight';

type Kind = 'image' | 'svg' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'html' | 'folder' | 'zip' | 'font' | 'heic' | 'word' | 'spreadsheet' | 'presentation' | 'fallback';
type Engine = 'native' | 'js' | 'info' | 'pending' | null;

interface OfficeSheet { name: string; html: string; truncated?: boolean }
interface OfficeSlide { label: string; html: string }
interface OfficePayload {
  message?: string;
  reason?: string | null;
  html?: string;
  sheets?: OfficeSheet[];
  slides?: OfficeSlide[];
  truncated?: boolean;
}

interface Appearance {
  theme: 'black' | 'white';
  accent: string;
  glass: boolean;
  opacity: number;
}

interface FolderItem { name: string; isDir: boolean; size: number; sizeLabel: string }
interface ZipItem { name: string; size: number; isDir: boolean }

interface Session {
  kind: Kind;
  name: string;
  path: string;
  ext: string;
  size: number;
  sizeLabel: string;
  created: string;
  modified: string;
  mediaUrl: string | null;
  mime: string;
  languageHint: string;
  text: string | null;
  html: string | null;
  truncated: boolean;
  folder: { items: FolderItem[]; count: number; files: number; folders: number; totalSize: number; truncated: boolean } | null;
  zip: { entries: ZipItem[]; truncated: boolean; error?: string } | null;
  engine: Engine;
  office: OfficePayload | null;
  fontFamily: string | null;
  message: string | null;
  iconDataUrl: string | null;
  pinned: boolean;
  index: number;
  total: number;
  appearance: Appearance;
  uiLanguage: 'pt' | 'en';
}

const COPY = {
  pt: {
    pin: 'Fixar janela',
    unpin: 'Desafixar janela',
    openWith: 'Abrir com...',
    reveal: 'Mostrar na pasta',
    close: 'Fechar (Esc)',
    folder: 'Pasta',
    items: 'itens',
    files: 'ficheiros',
    folders: 'pastas',
    truncated: 'Lista incompleta',
    empty: 'Nada para pré-visualizar',
    bytes: 'bytes',
    modified: 'Modificado',
    created: 'Criado',
    type: 'Tipo',
    fallback: 'Prévia não disponível para este tipo',
    pending: 'A carregar prévia…',
    native: 'Prévia nativa do Windows',
    partial: 'Prévia parcial',
    tooLarge: 'Arquivo grande demais para prévia. Abra-o no aplicativo.',
    family: 'Família',
    pangram: 'A rápida raposa marrom saltou sobre o cão preguiçoso.',
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789\nàáâãçéêíóôõú ÀÁÂÃÇÉÊÍÓÔÕÚ',
  },
  en: {
    pin: 'Pin window',
    unpin: 'Unpin window',
    openWith: 'Open with...',
    reveal: 'Show in folder',
    close: 'Close (Esc)',
    folder: 'Folder',
    items: 'items',
    files: 'files',
    folders: 'folders',
    truncated: 'List truncated',
    empty: 'Nothing to preview',
    bytes: 'bytes',
    modified: 'Modified',
    created: 'Created',
    type: 'Type',
    fallback: 'No preview for this file type',
    pending: 'Loading preview…',
    native: 'Windows native preview',
    partial: 'Partial preview',
    tooLarge: 'File is too large to preview. Open it in the app.',
    family: 'Family',
    pangram: 'The quick brown fox jumps over the lazy dog.',
    alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789\nàáâãçéêíóôõú ÀÁÂÃÇÉÊÍÓÔÕÚ',
  },
};

const FONT_SIZES = [12, 18, 24, 36, 48, 72];
const FONT_CSS_FAMILY = 'pv-preview-font';
const FONT_FORMAT: Record<string, string> = {
  ttf: 'truetype',
  otf: 'opentype',
  woff: 'woff',
  woff2: 'woff2',
};

function formatWhen(iso: string, lang: 'pt' | 'en') {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function stopMedia(el: HTMLMediaElement | null) {
  if (!el) return;
  el.pause();
  el.removeAttribute('src');
  el.load();
}

function MediaPane({ src, kind }: { src: string; kind: 'video' | 'audio' }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => {
    stopMedia(kind === 'video' ? videoRef.current : audioRef.current);
  }, [src, kind]);
  return (
    <div className="pv-media">
      {kind === 'video'
        ? <video ref={videoRef} src={src} controls autoPlay />
        : <audio ref={audioRef} src={src} controls autoPlay />}
    </div>
  );
}

function ImagePane({ src }: { src: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  zoomRef.current = zoom;

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const next = Math.min(8, Math.max(0.2, zoomRef.current * (event.deltaY < 0 ? 1.12 : 0.89)));
      zoomRef.current = next;
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
  };

  useEffect(() => {
    const up = () => { drag.current = null; setDragging(false); };
    const move = (event: MouseEvent) => {
      if (!drag.current) return;
      setPan({
        x: drag.current.panX + (event.clientX - drag.current.x),
        y: drag.current.panY + (event.clientY - drag.current.y),
      });
    };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    return () => {
      window.removeEventListener('mouseup', up);
      window.removeEventListener('mousemove', move);
    };
  }, []);

  return (
    <div
      ref={stage}
      className={`pv-image-stage${dragging ? ' is-drag' : ''}`}
      onMouseDown={onDown}
      onDoubleClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      />
    </div>
  );
}

function ListPane({ items }: { items: Array<{ name: string; isDir: boolean; sizeLabel?: string; size?: number }> }) {
  return (
    <ul className="pv-list">
      {items.map((item) => (
        <li key={item.name}>
          <span className={`name${item.isDir ? ' dir' : ''}`}>{item.name}{item.isDir ? '/' : ''}</span>
          <span className="size">{item.isDir ? '' : (item.sizeLabel || '')}</span>
        </li>
      ))}
    </ul>
  );
}

function HtmlDoc({ session, html }: { session: Session; html: string }) {
  const page = session.appearance.theme === 'white' ? '#fcfcfd' : '#151515';
  const ink = session.appearance.theme === 'white' ? '#1a1a1c' : '#eee';
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;min-height:100%;height:100%;padding:16px 20px 28px;font:15px/1.55 Segoe UI,system-ui,sans-serif;color:${ink};background:${page};background-color:${page}}
    pre,code{font-family:ui-monospace,Consolas,monospace} pre{overflow:auto;padding:12px;border-radius:8px;background:rgba(127,127,127,.12)}
    a{color:inherit} img{max-width:100%}
    table{border-collapse:collapse;width:max-content;min-width:100%;font:12.5px/1.4 ui-monospace,Consolas,monospace}
    th,td{border:1px solid ${session.appearance.theme === 'white' ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)'};padding:4px 8px;white-space:pre}
    th{font-weight:650;background:${session.appearance.theme === 'white' ? 'rgba(0,0,0,.04)' : 'rgba(255,255,255,.06)'};position:sticky;top:0}
    .muted{opacity:.55}
  </style></head><body>${html || ''}</body></html>`;
  return <iframe key={session.path} className="pv-md" sandbox="" srcDoc={doc} title={session.name} style={{ backgroundColor: page }} />;
}

function SpreadsheetPane({ session }: { session: Session }) {
  const sheets = session.office?.sheets || [];
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(0); }, [session.path]);
  if (!sheets.length) return <div className="pv-empty">{COPY[session.uiLanguage].empty}</div>;
  const current = sheets[Math.min(index, sheets.length - 1)];
  return (
    <div className="pv-sheet">
      <div className="pv-sheet-scroll" dangerouslySetInnerHTML={{ __html: current.html }} />
      {sheets.length > 1 ? (
        <div className="pv-sheet-tabs" role="tablist">
          {sheets.map((sheet, i) => (
            <button
              key={`${sheet.name}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={i === index ? 'is-on' : undefined}
              onClick={() => setIndex(i)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlidesPane({ session }: { session: Session }) {
  const slides = session.office?.slides || [];
  if (!slides.length) return <div className="pv-empty">{COPY[session.uiLanguage].empty}</div>;
  return (
    <div className="pv-slides">
      {slides.map((slide, i) => (
        <section key={`${slide.label}-${i}`} className="pv-slide">
          <div className="pv-slide-n">{i + 1}</div>
          <div className="pv-slide-body" dangerouslySetInnerHTML={{ __html: slide.html }} />
        </section>
      ))}
    </div>
  );
}

function FontPane({ session }: { session: Session }) {
  const t = COPY[session.uiLanguage];
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session.mediaUrl) {
      setFailed(true);
      return;
    }
    let gone = false;
    let face: FontFace | null = null;
    const format = FONT_FORMAT[session.ext] || 'truetype';
    const source = `url(${JSON.stringify(session.mediaUrl)}) format(${JSON.stringify(format)})`;
    const run = async () => {
      try {
        face = new FontFace(FONT_CSS_FAMILY, source);
        await face.load();
        if (gone) {
          document.fonts.delete(face);
          return;
        }
        document.fonts.add(face);
        setReady(true);
      } catch {
        if (!gone) setFailed(true);
      }
    };
    void run();
    return () => {
      gone = true;
      if (face) {
        try { document.fonts.delete(face); } catch { /* ignore */ }
      }
    };
  }, [session.mediaUrl, session.ext]);

  if (failed) return <InfoCard session={session} message={session.message || t.fallback} />;
  if (!ready) return <div className="pv-empty">{t.pending}</div>;
  return (
    <div className="pv-font">
      <div className="pv-font-family">{t.family}: {session.fontFamily || session.name}</div>
      {FONT_SIZES.map((size) => (
        <p key={size} className="pv-font-sample" style={{ fontFamily: FONT_CSS_FAMILY, fontSize: size }}>
          <span className="pv-font-size">{size}</span>
          {t.pangram}
        </p>
      ))}
      <pre className="pv-font-alpha" style={{ fontFamily: FONT_CSS_FAMILY }}>{t.alphabet}</pre>
    </div>
  );
}

function InfoCard({ session, message }: { session: Session; message: string }) {
  const t = COPY[session.uiLanguage];
  return (
    <div className="pv-fallback">
      {session.iconDataUrl ? <img src={session.iconDataUrl} alt="" /> : null}
      <h1>{session.name}</h1>
      <p>{message || session.sizeLabel || t.fallback}</p>
      <p>{t.type}: {session.ext ? session.ext.toUpperCase() : (session.kind === 'folder' ? t.folder : '—')}</p>
      <p>{t.modified}: {formatWhen(session.modified, session.uiLanguage)}</p>
      <p>{t.created}: {formatWhen(session.created, session.uiLanguage)}</p>
    </div>
  );
}

function Body({ session }: { session: Session }) {
  const t = COPY[session.uiLanguage];
  if (session.kind === 'word' || session.kind === 'spreadsheet' || session.kind === 'presentation') {
    if (session.engine === 'pending') return <div className="pv-empty">{session.office?.message || t.pending}</div>;
    if (session.engine === 'native') return <div className="pv-native">{session.office?.message || t.native}</div>;
    if (session.engine === 'info') return <InfoCard session={session} message={session.office?.message || t.fallback} />;
    if (session.engine === 'js' && session.kind === 'spreadsheet' && session.office?.sheets?.length) {
      return <SpreadsheetPane session={session} />;
    }
    if (session.engine === 'js' && session.kind === 'presentation' && session.office?.slides?.length) {
      return <SlidesPane session={session} />;
    }
    if (session.engine === 'js' && (session.office?.html || session.html)) {
      return <HtmlDoc session={session} html={session.office?.html || session.html || ''} />;
    }
    return <InfoCard session={session} message={session.office?.message || t.fallback} />;
  }
  if (session.kind === 'heic') {
    if (session.engine === 'pending') return <div className="pv-empty">{t.pending}</div>;
    if (session.mediaUrl) return <ImagePane key={session.mediaUrl} src={session.mediaUrl} />;
    return <InfoCard session={session} message={session.message || t.fallback} />;
  }
  if (session.kind === 'font') {
    return <FontPane session={session} />;
  }
  if (session.kind === 'image' || session.kind === 'svg') {
    return session.mediaUrl ? <ImagePane key={session.mediaUrl} src={session.mediaUrl} /> : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'video') {
    return session.mediaUrl ? <MediaPane key={session.mediaUrl} src={session.mediaUrl} kind="video" /> : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'audio') {
    return session.mediaUrl ? <MediaPane key={session.mediaUrl} src={session.mediaUrl} kind="audio" /> : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'pdf') {
    return session.mediaUrl
      ? <iframe key={session.mediaUrl} className="pv-pdf" src={session.mediaUrl} title={session.name} />
      : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'text') {
    const html = highlightCode(session.text || '', session.languageHint || 'text');
    return <pre className="pv-code" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (session.kind === 'markdown' || session.kind === 'html') {
    return <HtmlDoc session={session} html={session.html || ''} />;
  }
  if (session.kind === 'folder' && session.folder) {
    return <ListPane items={session.folder.items} />;
  }
  if (session.kind === 'zip' && session.zip) {
    if (session.zip.error) return <InfoCard session={session} message={session.message || t.tooLarge} />;
    return (
      <ListPane
        items={session.zip.entries.map((entry) => ({
          name: entry.name,
          isDir: entry.isDir,
          sizeLabel: entry.isDir ? '' : new Intl.NumberFormat(session.uiLanguage === 'pt' ? 'pt-BR' : 'en').format(entry.size),
        }))}
      />
    );
  }
  return <InfoCard session={session} message={session.message || session.sizeLabel || t.fallback} />;
}

export function PreviewApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const api = window.preview;
    if (!api) return;
    let alive = true;
    const unsub = api.onSession((next) => {
      if (!alive) return;
      setSession(next as Session);
      setVisible(!!next);
    });
    const unsubA = api.onAppearance((appearance) => {
      if (!alive) return;
      setSession((current) => (current ? { ...current, appearance: appearance as Appearance } : current));
    });
    void api.getSession().then((next) => {
      if (!alive || !next) return;
      setSession((current) => current || (next as Session));
      setVisible(true);
    });
    void api.action('ready');
    return () => { alive = false; unsub(); unsubA(); };
  }, []);

  const run = useCallback((action: string) => {
    void window.preview?.action(action);
  }, []);

  const lastPress = useRef(0);
  const press = useCallback((action: string) => (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (event.type !== "pointerdown" && now - lastPress.current < 400) return;
    lastPress.current = now;
    run(action);
  }, [run]);

  const appearance = session?.appearance;
  const t = COPY[session?.uiLanguage === 'en' ? 'en' : 'pt'];
  const accentStyle = useMemo(() => {
    const hex = appearance?.accent && /^#[0-9a-f]{6}$/i.test(appearance.accent) ? appearance.accent : '#FFFFFF';
    const white = /^#ffffff$/i.test(hex);
    const theme = appearance?.theme === 'white' ? 'white' : 'black';
    const accent = white ? (theme === 'white' ? '#101012' : '#ffffff') : hex;
    const on = (0.2126 * parseInt(accent.slice(1, 3), 16) + 0.7152 * parseInt(accent.slice(3, 5), 16) + 0.0722 * parseInt(accent.slice(5, 7), 16)) / 255 > 0.56 ? '#0a0a0b' : '#ffffff';
    return { ['--pv-accent' as string]: accent, ['--pv-on-accent' as string]: on };
  }, [appearance]);

  const glass = appearance?.glass !== false;
  const opacity = appearance?.opacity ?? 0.8;
  const subtitle = session
    ? [
        session.kind === 'folder' && session.folder
          ? `${session.folder.count} ${t.items}`
          : session.sizeLabel,
        session.total > 1 ? `${session.index + 1}/${session.total}` : '',
        session.truncated
          ? ((session.kind === 'word' || session.kind === 'spreadsheet' || session.kind === 'presentation') ? t.partial : t.truncated)
          : '',
      ].filter(Boolean).join(' · ')
    : '';

  if (!session) {
    return <div className="pv-empty">{t.empty}</div>;
  }

  return (
    <div
      className={`pv-frame ${glass ? 'is-glass' : 'is-solid'}${visible ? ' is-in' : ''}`}
      data-theme={appearance?.theme === 'white' ? 'white' : 'black'}
      style={accentStyle}
    >
      <header
        className="pv-bar"
        style={glass ? { backgroundColor: appearance?.theme === 'white' ? `rgba(252,252,253,${opacity})` : `rgba(21,21,21,${opacity})` } : undefined}
      >
        <div className="pv-title" title={session.path}>{session.name}</div>
        <div className="pv-meta">{subtitle}</div>
        <div className="pv-actions" onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={`pv-btn${session.pinned ? ' is-on' : ''}`}
            title={session.pinned ? t.unpin : t.pin}
            aria-label={session.pinned ? t.unpin : t.pin}
            aria-pressed={session.pinned}
            onPointerDown={press("pin")}
            onClick={press("pin")}
          >
            <Pin size={15} fill={session.pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.openWith}
            aria-label={t.openWith}
            onPointerDown={press("open-with")}
            onClick={press("open-with")}
          >
            <AppWindow size={15} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.reveal}
            aria-label={t.reveal}
            onPointerDown={press("reveal")}
            onClick={press("reveal")}
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.close}
            aria-label={t.close}
            onPointerDown={press("close")}
            onClick={press("close")}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="pv-stage">
        <Body key={session.path} session={session} />
      </div>
    </div>
  );
}
