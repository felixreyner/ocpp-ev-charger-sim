import { createRoot } from 'react-dom/client';
import '@sim/ui/src/theme.css';
// The three apps' own stylesheets, each scoped under .scope-<app> (see vite.config.ts).
import '../../../csms/web/src/app.css';
import '../../../charger/web/src/app.css';
import '../../../rogue/web/src/app.css';
import './app.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
