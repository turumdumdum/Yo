import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { captureInvitationFromUrl } from './lib/invite';
import './styles.css';

captureInvitationFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
