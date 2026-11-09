// Harness das superfícies React do VOR: definições (todas as páginas), roda principal e toast de erro.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrecisionSettings } from '../../src/components/PrecisionSettings';
import { RadialMenu } from '../../src/components/RadialMenu';
import { Toast } from '../../src/components/Toast';
import { DEFAULT_APPS, DEFAULT_UI_CONFIG } from '../../src/defaults';
import type { AppItem, UIConfig } from '../../src/types';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'white' ? 'white' : 'black';
const view = q.get('view') || 'settings';
const accent = q.get('accent') || '#FFFFFF';

function App() {
  const [config, setConfig] = React.useState<UIConfig>({ ...DEFAULT_UI_CONFIG, language: 'pt', appearanceTheme: theme, radialHoverColor: accent } as UIConfig);
  const [apps, setApps] = React.useState<AppItem[]>(DEFAULT_APPS);
  if (view === 'radial') {
    const w = window.innerWidth, h = window.innerHeight;
    return (
      <RadialMenu isOpen position={{ x: w / 2, y: h / 2 }} viewportSize={{ width: w, height: h }} onClose={() => {}}
        apps={apps.slice(0, 8)} config={config} animationReady currentWorkspace={config.workspaces?.[0]} />
    );
  }
  if (view === 'toast') {
    return <Toast app={{ id: 'error', label: 'Não foi possível abrir o Spotify', description: 'O atalho aponta para um arquivo que não existe mais.' } as AppItem} />;
  }
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <PrecisionSettings isOpen isPage onClose={() => {}} apps={apps} setApps={setApps} config={config} setConfig={setConfig}
        onReset={() => {}} onOpenDashboard={() => {}} />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
