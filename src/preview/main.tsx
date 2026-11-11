import React from 'react';
import ReactDOM from 'react-dom/client';
import { PreviewApp } from './PreviewApp';
import './preview.css';

declare global {
  interface Window {
    preview?: {
      getSession: () => Promise<unknown>;
      action: (action: string) => Promise<{ ok: boolean; pinned?: boolean; error?: string }>;
      onSession: (callback: (session: unknown) => void) => () => void;
      onAppearance: (callback: (appearance: unknown) => void) => () => void;
    };
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('preview root missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PreviewApp />
  </React.StrictMode>,
);
