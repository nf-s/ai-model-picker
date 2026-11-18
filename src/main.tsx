import './lib/zod-config';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { loadAccess } from './lib/access';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  // Restricted results must be in place before the app derives its tables,
  // so the app module loads after the session check.
  const access = await loadAccess();
  const { default: App } = await import('./App');
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App access={access} />
    </React.StrictMode>,
  );
}
