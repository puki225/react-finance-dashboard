import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

// Registers public/service-worker.js - a deliberate no-op passthrough (see that file's own
// comment), needed only so the browser recognizes the site as installable alongside
// manifest.json. Skipped outside a secure context (plain http:// in local dev) since
// browsers refuse to register service workers there anyway.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // Installability is a progressive enhancement - nothing in the app depends on this
      // succeeding, so a failed registration (e.g. an unusual hosting setup) is silent.
    });
  });
}
