import { createRoot } from 'react-dom/client';
import '@sim/ui/src/theme.css';
import './app.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);
