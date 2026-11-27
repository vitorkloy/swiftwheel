import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Volume2, VolumeX, Wifi, WifiOff, Battery, BatteryCharging, LayoutGrid } from 'lucide-react';

interface DockItem {
  id: string;
  label: string;
  command: string;
  commandType?: string;
  icon?: string;
  pinned: boolean;
  running: boolean;
  hwnds: Array<string | number>;
}

interface DockSession {
  visible?: boolean;
  settings: {
    iconSize: number;
    liftPx: number;
    magnification: boolean;
    autoHide: boolean;
    position: 'bottom' | 'left' | 'right';
  };
  appearance?: { theme?: string; accent?: string; glass?: boolean; opacity?: number };
  language?: 'pt' | 'en';
  items: DockItem[];
  tray: { vol: number; mute: number; battery: number; ac: number; online: number; hasbatt: number };
}

const COPY = {
  pt: { clock: 'Relógio', sound: 'Som', notify: 'Notificações', tray: 'Ícones da bandeja', online: 'Rede', battery: 'Bateria' },
  en: { clock: 'Clock', sound: 'Sound', notify: 'Notifications', tray: 'Tray icons', online: 'Network', battery: 'Battery' },
};

function nextMinuteDelay() {
  const now = new Date();
  return (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 16;
}

function formatClock(date: Date, language: 'pt' | 'en') {
  const locale = language === 'en' ? 'en-US' : 'pt-BR';
  return {
    time: date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    date: date.toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: 'short' }),
  };
}

function accentVars(appearance: DockSession['appearance']): React.CSSProperties {
  const hex = appearance?.accent && /^#[0-9a-f]{6}$/i.test(appearance.accent) ? appearance.accent : '#FFFFFF';
  const theme = appearance?.theme === 'white' ? 'white' : 'black';
  const white = /^#ffffff$/i.test(hex);
  const accent = white ? (theme === 'white' ? '#101012' : '#ffffff') : hex;
  const on = (0.2126 * parseInt(accent.slice(1, 3), 16) + 0.7152 * parseInt(accent.slice(3, 5), 16) + 0.0722 * parseInt(accent.slice(5, 7), 16)) / 255 > 0.56 ? '#0a0a0b' : '#ffffff';
  return { ['--dk-accent' as string]: accent, ['--dk-on-accent' as string]: on };
}

export function DockApp() {
  const [session, setSession] = useState<DockSession | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const paintedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const unsub = window.dock?.onSession((next) => {
      if (alive) setSession(next as DockSession);
    });
    void window.dock?.getSession().then((next) => {
      if (alive && next) setSession(next as DockSession);
    });
    void window.dock?.action({ action: 'ready' });
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  useEffect(() => {
    if (!session || paintedRef.current) return;
    paintedRef.current = true;
    void window.dock?.action({ action: 'painted' });
  }, [session]);

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, nextMinuteDelay());
    };
    timer = window.setTimeout(tick, nextMinuteDelay());
    return () => window.clearTimeout(timer);
  }, []);

  const language = session?.language === 'en' ? 'en' : 'pt';
  const t = COPY[language];
  const clock = useMemo(() => formatClock(now, language), [now, language]);
  const items = session?.items ?? [];
  const settings = session?.settings;
  const position = settings?.position ?? 'bottom';
  const glass = session?.appearance?.glass !== false;
  const opacity = session?.appearance?.opacity ?? 0.8;
  const theme = session?.appearance?.theme === 'white' ? 'white' : 'black';
  const hotIndex = hot ? items.findIndex((item) => item.id === hot) : -1;

  const pillStyle = glass
    ? { backgroundColor: theme === 'white' ? `rgba(252,252,253,${opacity})` : `rgba(21,21,21,${opacity})` }
    : undefined;

  const run = useCallback((payload: { action: string; id?: string; name?: string }) => {
    void window.dock?.action(payload);
  }, []);

  return (
    <div
      className={`dk-root${position === 'left' ? ' is-left' : position === 'right' ? ' is-right' : ''}${settings?.magnification ? ' is-mag' : ''}`}
      data-theme={theme}
      style={{
        ...accentVars(session?.appearance),
        ['--dk-lift' as string]: `${settings?.liftPx ?? 6}px`,
        ['--dk-icon' as string]: `${settings?.iconSize ?? 48}px`,
      }}
      onPointerEnter={() => run({ action: 'pointer-in' })}
      onPointerLeave={() => { setHot(null); run({ action: 'pointer-out' }); }}
    >
      <div className={`dk-pill${glass ? '' : ' is-solid'}`} style={pillStyle}>
        <div className="dk-items">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`dk-item${item.running ? ' is-running' : ''}${hot === item.id ? ' is-hot' : ''}${settings?.magnification && hotIndex >= 0 && Math.abs(index - hotIndex) === 1 ? ' is-near' : ''}`}
              title={item.label}
              onPointerEnter={() => setHot(item.id)}
              onClick={() => run({ action: 'click', id: item.id })}
              onContextMenu={(event) => {
                event.preventDefault();
                run({ action: 'menu', id: item.id });
              }}
            >
              <span className="dk-glyph">
                {item.icon
                  ? <img src={item.icon} alt="" />
                  : <span className="dk-fallback">{(item.label || '?').slice(0, 1).toUpperCase()}</span>}
              </span>
              <i className="dk-dot" />
            </button>
          ))}
        </div>
        <div className="dk-tray" aria-label={t.tray}>
          <button type="button" className="dk-clock" title={t.clock} onClick={() => run({ action: 'tray', name: 'notify' })}>
            {clock.time}
            <small>{clock.date}</small>
          </button>
          <button type="button" className="dk-chip" title={t.sound} onClick={() => run({ action: 'tray', name: 'sound' })}>
            {(session?.tray?.mute || (session?.tray?.vol ?? 1) === 0) ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button type="button" className="dk-chip" title={t.online} onClick={() => run({ action: 'tray', name: 'overflow' })}>
            {session?.tray?.online ? <Wifi size={14} /> : <WifiOff size={14} />}
          </button>
          {session?.tray?.hasbatt ? (
            <button type="button" className="dk-chip" title={t.battery} onClick={() => run({ action: 'tray', name: 'overflow' })}>
              {session.tray.ac ? <BatteryCharging size={14} /> : <Battery size={14} />}
            </button>
          ) : null}
          <button type="button" className="dk-chip" title={t.notify} onClick={() => run({ action: 'tray', name: 'notify' })}>
            <Bell size={14} />
          </button>
          <button type="button" className="dk-chip" title={t.tray} onClick={() => run({ action: 'tray', name: 'overflow' })}>
            <LayoutGrid size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
