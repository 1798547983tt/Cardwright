import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { installErrorLogging } from './diagnostics';
import './styles.css';
import './studio-next.css';
import './gateway-models.css';
import './workbench.css';
import './hud-controls.css';
import './pages.css';
import './motion.css';
import './card-studio/card-studio.css';
import './card-studio/card-studio-section.css';
import './appearance.css';
import './conversation/conversation.css';

installErrorLogging();
// The page itself cannot navigate, so 重新加载 asks the desktop process to reload the window.
const reload = () => { if (window.cardwright) void window.cardwright.window('reload').catch(() => location.reload()); else location.reload(); };

// The pages have boundaries of their own; this one catches whatever is left, so the window is never just its background.
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary kind="app" onBack={reload}><App /></ErrorBoundary></React.StrictMode>);
