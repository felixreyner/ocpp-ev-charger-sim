import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * The dashboard reuses the real CSMS, charger and rogue components, but those
 * three apps were written as separate pages and share class names (.layout,
 * .stat, .kv, …) with different styles. This PostCSS step scopes each app's
 * stylesheet under a wrapper class (.scope-csms, .scope-charger, .scope-rogue)
 * so all three can live on one page without stepping on each other.
 * `:root` becomes the wrapper; `body` becomes `.scope-x.is-page`, used only
 * when that app is shown full-screen.
 */
const SCOPED_APPS = ['csms', 'charger', 'rogue'];
const scopeAppCss = {
  postcssPlugin: 'sim-scope-app-css',
  Once(css: any) {
    const file: string = (css.source?.input?.file ?? '').replace(/\\/g, '/');
    const app = SCOPED_APPS.find((a) => file.includes(`/apps/${a}/web/`));
    if (!app) return;
    const scope = `.scope-${app}`;
    css.walkRules((rule: any) => {
      if (rule.parent?.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
      rule.selectors = rule.selectors.map((sel: string) => {
        if (sel === ':root') return scope;
        if (/^(html|body)\b/.test(sel)) return sel.replace(/^(html|body)/, `${scope}.is-page`);
        return `${scope} ${sel}`;
      });
    });
  },
};

// One proxy entry per backend: /csms/ui -> ws://localhost:8080/ui, etc.
const BACKENDS = {
  csms: process.env.CSMS_BACKEND ?? 'localhost:8080',
  charger: process.env.CHARGER_BACKEND ?? 'localhost:8081',
  rogue: process.env.ROGUE_BACKEND ?? 'localhost:8082',
};
const proxy = Object.fromEntries(
  Object.entries(BACKENDS).map(([part, host]) => [
    `/${part}/ui`,
    { target: `ws://${host}`, ws: true, rewrite: (p: string) => p.replace(`/${part}`, '') },
  ]),
);

export default defineConfig({
  root,
  plugins: [react() as Plugin[]],
  css: { postcss: { plugins: [scopeAppCss] } },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5176, proxy },
});
