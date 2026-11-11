import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.jsx';
import { registerServiceWorker } from './api/push.js';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Después de pintar: el worker sólo hace falta para las notificaciones y no debe retrasar nada.
registerServiceWorker();
