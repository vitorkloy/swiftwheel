import React from 'react';
import { createRoot } from 'react-dom/client';
import { FilePetalWheel } from '../../src/components/FilePetalWheel';
import type { AppItem } from '../../src/types';

const q = new URLSearchParams(location.search);
const theme = (q.get('theme') === 'white' ? 'white' : 'black') as 'black' | 'white';
const accent = q.get('accent') || '#FFFFFF';
const mk = (id: string, label: string, iconName = 'Circle'): AppItem => ({ id, label, iconName } as unknown as AppItem);
const conv = ['JPG', 'PNG', 'WEBP', 'HEIC', 'TIFF', 'AVIF', 'BMP', 'PDF'].map((f) => mk(`conv:${f.toLowerCase()}`, f));
const tools = [
  mk('tool:compress', 'Comprimir', 'Shrink'), mk('tool:redactImage', 'Ocultar', 'EyeOff'), mk('tool:removeMetadata', 'Metadados', 'Tag'),
  mk('tool:cropImage', 'Cortar', 'Crop'), mk('tool:editImage', 'Editar', 'SlidersHorizontal'), mk('tool:frameImage', 'Fundo', 'Frame'),
  mk('tool:annotateImage', 'Anotar', 'PenLine'), mk('tool:rotate90', 'Girar', 'RotateCw'),
];
const actions = [mk('act:airDrop', 'Compartilhar', 'Share2'), mk('act:float', 'Flutuar', 'Layers'), mk('act:copy', 'Copiar', 'Copy'), mk('act:move', 'Mover', 'FolderInput'), mk('act:copyPath', 'Caminho', 'Link'), mk('act:openTerminal', 'Terminal', 'Terminal')];
const cell = (title: string, items: AppItem[], active: number | null, label: string) => (
  <div style={{ position: 'relative', width: 260, height: 290 }}>
    <div style={{ position: 'absolute', left: 130, top: 130 }}>
      <FilePetalWheel items={items} activeIndex={active} centerActive={false} formatLabel={label} bloom accent={accent} theme={theme} surfaceAlpha={0.8} />
    </div>
    <div style={{ position: 'absolute', bottom: 6, width: '100%', textAlign: 'center', font: '600 11px Segoe UI', color: theme === 'white' ? '#333' : '#ddd' }}>{title}</div>
  </div>
);
createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', gap: 10, padding: 20 }}>
    {cell('Shift · converter', conv, 2, 'PNG · 14 KB')}
    {cell('Ctrl · ferramentas', tools, 3, 'PNG · 14 KB')}
    {cell('Alt · ações', actions, null, '3 ITENS')}
  </div>,
);
