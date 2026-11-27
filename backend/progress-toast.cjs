"use strict";

/**
 * Toast de progresso do ShiftDrop ("Convertendo para PDF…"), numa janela leve
 * reaproveitada. Criada só no primeiro uso e destruída após 60 s sem trabalho.
 * O mesmo cartão serve a verificação manual de atualizações.
 */
const TOAST_HTML = `<!doctype html><meta charset="utf-8"><style>
        :root{--bg:rgba(24,24,26,.9);--line:rgba(255,255,255,.12);--text:rgba(255,255,255,.94);--text2:rgba(255,255,255,.55);--track:rgba(255,255,255,.12);--accent:#fff;--elev:0 14px 34px rgba(0,0,0,.45)}
        [data-theme=white]{--bg:rgba(250,250,251,.94);--line:rgba(0,0,0,.09);--text:rgba(0,0,0,.88);--text2:rgba(0,0,0,.52);--track:rgba(0,0,0,.08);--elev:0 14px 34px rgba(0,0,0,.16)}
        html,body{margin:0;background:transparent;overflow:hidden;font:12.5px/1.3 "Segoe UI Variable Text","Segoe UI",sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
        .t{margin:10px;padding:11px 14px 12px;border-radius:14px;background:var(--bg);background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,0));
           box-shadow:inset 0 0 0 1px var(--line),var(--elev);opacity:0;transform:translateY(8px) scale(.97);transition:opacity .14s,transform .22s cubic-bezier(.2,1.3,.35,1)}
        .t.on{opacity:1;transform:none}
        .r{display:flex;align-items:baseline;gap:8px}
        .l{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .n{color:var(--text2);font-variant-numeric:tabular-nums;font-size:11.5px;white-space:nowrap}
        .b{margin-top:9px;height:3px;border-radius:2px;background:var(--track);overflow:hidden}
        .f{height:100%;width:100%;background:var(--accent);border-radius:2px;transform-origin:0 50%;transform:scaleX(0);transition:transform .2s cubic-bezier(.22,1,.36,1)}
        .f.i{width:30%;transform:none;animation:k 1.1s cubic-bezier(.45,0,.55,1) infinite}
        @keyframes k{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
      </style><div class="t" id="t"><div class="r"><div class="l" id="l"></div><div class="n" id="n"></div></div><div class="b"><div class="f" id="f"></div></div></div>
      <script>window.theme=function(a){document.documentElement.dataset.theme=a.theme==='white'?'white':'black';var c=/^#ffffff$/i.test(a.accent||'#ffffff')?(a.theme==='white'?'#101012':'#ffffff'):a.accent;document.documentElement.style.setProperty('--accent',c);};
      window.set=function(text,pct,on){var m=String(text).match(/^(.*?)\\s(\\d+ de \\d+)$/);document.getElementById('l').textContent=m?m[1]:text;document.getElementById('n').textContent=m?m[2]:'';var f=document.getElementById('f');
      if(pct<0){f.className='f i';f.style.transform='';}else{f.className='f';f.style.transform='scaleX('+Math.max(0,Math.min(1,pct))+')';}
      document.getElementById('t').className=on?'t on':'t';};</script>`;

/**
 * @param {{ BrowserWindow: Function, screen: { getDisplayNearestPoint: Function, getCursorScreenPoint: Function }, getAppearance: () => object }} deps
 */
function createProgressToast({ BrowserWindow, screen, getAppearance }) {
  let win = null;
  let hideTimer = null;
  let killTimer = null;

  const show = (text, pct) => {
    try {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      const appearance = typeof getAppearance === "function" ? getAppearance() : {};
      const push = () => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(`window.theme && window.theme(${JSON.stringify(appearance)}); window.set && window.set(${JSON.stringify(text)}, ${Number(pct)}, true)`).catch(() => {});
        if (!win.isVisible()) win.showInactive();
      };
      if (!win || win.isDestroyed()) {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const w = 320;
        const h = 80;
        win = new BrowserWindow({
          width: w, height: h, x: area.x + area.width - w - 12, y: area.y + area.height - h - 12,
          frame: false, transparent: true, resizable: false, movable: false, focusable: false,
          alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
          webPreferences: { contextIsolation: true, sandbox: true },
        });
        win.setIgnoreMouseEvents(true);
        win.setAlwaysOnTop(true, "screen-saver");
        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TOAST_HTML)}`).then(push).catch(() => {});
      } else push();
    } catch { /* toast é só cosmético */ }
  };

  const hide = (delay = 0) => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (!win || win.isDestroyed()) return;
      win.webContents.executeJavaScript("window.set && window.set(document.getElementById('l').textContent, 1, false)").catch(() => {});
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.hide(); } catch { /* ignore */ } }, 180);
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTimer = null;
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
        win = null;
      }, 60000);
    }, delay);
  };

  return { show, hide };
}

module.exports = { TOAST_HTML, createProgressToast };
