// Phase 0 standalone E2E: boot a real cordis app (WebServer + LocalCredentialProvider
// + this plugin) in-process against the real profile dependencies, then hit the
// plugin's routes over HTTP. No GUI restart needed.
//
// Run: node test/standalone.test.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration test: requires a local DSH installation whose @deepseek-ai
// packages are reachable at $DSH_HOME/profiles/node_modules/@deepseek-ai
// (the standard profile fallback), plus a working DEEPSEEK_API_KEY credential.
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CANDIDATES = [
  path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
];
const root = CANDIDATES.find((p) => fs.existsSync(p));
if (!root) {
  console.error('no @deepseek-ai package root found (need a local DSH install at ' + dshHome + ')');
  process.exit(1);
}
const imp = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')).href);

const { Context } = await imp('cordis');
const { WebServer } = await imp('dsh-host-webserver');
const { LocalCredentialProvider } = await imp('dsh-credentials-local');
const plugin = await import('../lib/index.js');

console.log('[boot] dshHome =', dshHome);

const ctx = new Context();
await ctx.plugin(LocalCredentialProvider, { dshHome });
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {});

const port = ctx.webServer.port;
console.log('[boot] webServer on 127.0.0.1:' + port);

let failures = 0;
async function hit(pathname, label) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { cache: 'no-store' });
  const j = await res.json();
  const ms = Date.now() - t0;
  console.log(`[route] ${pathname} HTTP ${res.status} (${ms}ms)`);
  return { res, j, ms };
}

// 1) balance route
{
  const { res, j } = await hit('/api/dsh-usage/balance', 'balance');
  const ok = res.ok && j.ok && typeof j.total === 'number';
  console.log('  balance:', ok ? `total=${j.total} ${j.currency} granted=${j.granted} topped=${j.topped_up} available=${j.is_available}` : JSON.stringify(j));
  if (!ok) failures++;
}

// 2) stats route (includes session-log history scan)
{
  const { res, j } = await hit('/api/dsh-usage/stats', 'stats');
  const u = j.usage;
  const ok = res.ok && j.ok && u && Array.isArray(u.days) && u.days.length === 7;
  console.log('  stats ok:', ok);
  if (ok) {
    const withData = u.days.filter((d) => d.hasData);
    console.log(`  today tokens=${u.today.tokens} (in=${u.today.input} out=${u.today.output} cache=${u.today.cacheRead} hit=${u.today.cacheHitRate})`);
    console.log(`  totals=${u.totals} avgDaily=${u.avgDaily} | days with data=${withData.length}`);
    console.log('  days sample:', JSON.stringify(u.days.filter((d) => d.hasData).slice(0, 3)));
  } else {
    console.log('  stats:', JSON.stringify(j).slice(0, 300));
    failures++;
  }
}

// 3) 404 for unknown path (route registry sanity)
{
  const res = await fetch(`http://127.0.0.1:${port}/api/dsh-usage/nope`, { cache: 'no-store' });
  if (res.status !== 404) {
    console.log('[route] unexpected status for unknown path:', res.status);
    failures++;
  } else {
    console.log('[route] unknown path -> 404 (fallback seat, expected)');
  }
}

await ctx.fiber.dispose();
console.log(failures === 0 ? '\nSTANDALONE E2E PASS ✅' : `\nSTANDALONE E2E FAIL (${failures}) ❌`);
process.exit(failures === 0 ? 0 : 1);
