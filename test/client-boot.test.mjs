// Execute the REAL client bundle in Node: stub window/module-loader, provide
// react + primitives shims, call apply() with a mock ctx, and assert it
// registers without throwing. Catches runtime boot errors the HTTP verify
// cannot see (bad registration API usage, missing exports, etc.).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE = new URL('../lib/client.js', import.meta.url);
const code = fs.readFileSync(FILE, 'utf8');

// --- module loader stub ---
const modules = new Map();
globalThis.window = { __ModuleLoader__: { load: (spec) => modules.set(spec.id, spec.factory) } };

// --- require shim ---
const shim = (spec) => {
  if (spec === 'react') return reactShim;
  if (spec === 'react/jsx-runtime') return reactShim;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesShim;
  throw new Error('unexpected require: ' + spec);
};

// --- react shim: the real thing (module-level destructures only; hooks are never invoked in apply) ---
const reactShim = { createElement: () => ({}), useState: () => [], useEffect: () => {}, useCallback: () => {}, useSyncExternalStore: () => undefined, memo: (f) => f, Fragment: null };

// --- primitives shim: named exports used by the bundle ---
const primitivesShim = { Tooltip: () => null, Modal: () => null, IconDataOutline16: () => null, IconRefreshOutline16: () => null };

// --- execute the bundle ---
(0, eval)(code);
const factory = modules.get('dsh-usage-plugin');
if (!factory) { console.error('bundle did not self-register'); process.exit(1); }
const exports = factory(shim);
console.log('bundle exports:', Object.keys(exports).join(', '));

// --- call apply() with a mock ctx ---
const registered = [];
const mockCtx = {
  effect: () => {},
  locale: { register: (ns, dicts) => { registered.push(['locale', ns, Object.keys(dicts.zh).length]); } },
  slots: {
    inject: (name, factoryFn) => {
      const entry = factoryFn();
      registered.push(['slot', name, entry.name, entry.id]);
    },
    register: (entry) => entry,
  },
};
exports.apply(mockCtx);
console.log('apply() OK. registrations:');
for (const r of registered) console.log('  ', r.join(' | '));

const slots = registered.filter((r) => r[0] === 'slot');
const ok = slots.some((s) => s[1] === 'sidebar.footer.action') && slots.some((s) => s[1] === 'shell.overlay');
console.log(ok ? '\nCLIENT BOOT CHECK PASS ✅ (sidebar.footer.action + shell.overlay registered)' : '\nCLIENT BOOT CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
