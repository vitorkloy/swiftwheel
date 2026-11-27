import React from 'react';
import ReactDOM from 'react-dom/client';
import { DockApp } from './DockApp';
import './dock.css';

declare global {
  interface Window {
    dock?: {
      getSession: () => Promise<unknown>;
      action: (payload: { action: string; id?: string; name?: string }) => Promise<{ ok: boolean; error?: string }>;
      onSession: (callback: (session: unknown) => void) => () => void;
    };
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('dock root missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <DockApp />
  </React.StrictMode>,
);
