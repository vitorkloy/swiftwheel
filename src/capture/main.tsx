import React from 'react';
import ReactDOM from 'react-dom/client';
import { CaptureOverlay } from './CaptureOverlay';
import './capture.css';

const root = document.getElementById('root');
if (!root) throw new Error('capture root missing');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <CaptureOverlay />
  </React.StrictMode>,
);
