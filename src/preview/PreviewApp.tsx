import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, FolderOpen, Pin, X } from 'lucide-react';
import { highlightCode } from './highlight';

type Kind = 'image' | 'svg' | 'video' | 'audio' | 'pdf' | 'text' | 'markdown' | 'html' | 'folder' | 'zip' | 'fallback';

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
  zip: { entries: ZipItem[]; truncated: boolean } | null;
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
  },
};

function formatWhen(iso: string, lang: 'pt' | 'en') {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
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

function Body({ session }: { session: Session }) {
  const t = COPY[session.uiLanguage];
  if (session.kind === 'image' || session.kind === 'svg') {
    return session.mediaUrl ? <ImagePane src={session.mediaUrl} /> : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'video') {
    return (
      <div className="pv-media">
        {session.mediaUrl ? <video src={session.mediaUrl} controls autoPlay /> : t.empty}
      </div>
    );
  }
  if (session.kind === 'audio') {
    return (
      <div className="pv-media">
        {session.mediaUrl ? <audio src={session.mediaUrl} controls autoPlay /> : t.empty}
      </div>
    );
  }
  if (session.kind === 'pdf') {
    return session.mediaUrl
      ? <iframe className="pv-pdf" src={session.mediaUrl} title={session.name} />
      : <div className="pv-empty">{t.empty}</div>;
  }
  if (session.kind === 'text') {
    const html = highlightCode(session.text || '', session.languageHint || 'text');
    return <pre className="pv-code" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (session.kind === 'markdown' || session.kind === 'html') {
    const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;padding:16px 20px 28px;font:15px/1.55 Segoe UI,system-ui,sans-serif;color:${session.appearance.theme === 'white' ? '#1a1a1c' : '#eee'};background:transparent}
      pre,code{font-family:ui-monospace,Consolas,monospace} pre{overflow:auto;padding:12px;border-radius:8px;background:rgba(127,127,127,.12)}
      a{color:inherit} img{max-width:100%}
    </style></head><body>${session.html || ''}</body></html>`;
    return <iframe className="pv-md" sandbox="" srcDoc={doc} title={session.name} />;
  }
  if (session.kind === 'folder' && session.folder) {
    return <ListPane items={session.folder.items} />;
  }
  if (session.kind === 'zip' && session.zip) {
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
  return (
    <div className="pv-fallback">
      {session.iconDataUrl ? <img src={session.iconDataUrl} alt="" /> : null}
      <h1>{session.name}</h1>
      <p>{session.sizeLabel || t.fallback}</p>
      <p>{t.type}: {session.ext ? session.ext.toUpperCase() : (session.kind === 'folder' ? t.folder : '—')}</p>
      <p>{t.modified}: {formatWhen(session.modified, session.uiLanguage)}</p>
      <p>{t.created}: {formatWhen(session.created, session.uiLanguage)}</p>
    </div>
  );
}

export function PreviewApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const api = window.preview;
    if (!api) return;
    const unsub = api.onSession((next) => {
      setSession(next as Session);
      setVisible(!!next);
    });
    const unsubA = api.onAppearance((appearance) => {
      setSession((current) => (current ? { ...current, appearance: appearance as Appearance } : current));
    });
    void api.getSession().then((next) => {
      if (next) {
        setSession(next as Session);
        setVisible(true);
      }
    });
    void api.action('ready');
    return () => { unsub(); unsubA(); };
  }, []);

  const run = useCallback((action: string) => {
    void window.preview?.action(action);
  }, []);

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
        session.truncated ? t.truncated : '',
      ].filter(Boolean).join(' · ')
    : '';

  if (!session) {
    return <div className="pv-empty">{t.empty}</div>;
  }

  return (
    <div
      className={`pv-frame ${glass ? 'is-glass' : 'is-solid'}${visible ? ' is-in' : ''}`}
      data-theme={appearance?.theme === 'white' ? 'white' : 'black'}
      style={{ ...accentStyle, ...(glass ? { backgroundColor: appearance?.theme === 'white' ? `rgba(252,252,253,${opacity})` : `rgba(21,21,21,${opacity})` } : {}) }}
    >
      <header className="pv-bar">
        <div className="pv-title" title={session.path}>{session.name}</div>
        <div className="pv-meta">{subtitle}</div>
        <div className="pv-actions" onMouseDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className={`pv-btn${session.pinned ? ' is-on' : ''}`}
            title={session.pinned ? t.unpin : t.pin}
            aria-label={session.pinned ? t.unpin : t.pin}
            aria-pressed={session.pinned}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); run('pin'); }}
          >
            <Pin size={15} fill={session.pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.openWith}
            aria-label={t.openWith}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); run('open-with'); }}
          >
            <AppWindow size={15} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.reveal}
            aria-label={t.reveal}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); run('reveal'); }}
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            className="pv-btn"
            title={t.close}
            aria-label={t.close}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); run('close'); }}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="pv-stage">
        <Body session={session} />
      </div>
    </div>
  );
}
