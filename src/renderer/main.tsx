import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './studio-next.css';
import './gateway-models.css';
import './workbench.css';
import './hud-controls.css';
import './pages.css';
import './motion.css';
import './card-studio/card-studio.css';
import './card-studio/card-studio-section.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
