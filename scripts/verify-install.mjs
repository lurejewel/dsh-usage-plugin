// 重启 dsh web 后的一键验证：检查插件是否在目标实例上完整生效。
// 用法：node scripts\verify-install.mjs <port> <token>
//   token 也可通过环境变量 DSH_WEB_TOKEN 传入。
//
// 适配 dsh >= 0.1.5：Web UI 与 /api 都在「进程令牌栅栏」之后，未带令牌一律 401。
// 令牌出现在 dsh web 启动时打印的地址里：
//   dsh web: http://127.0.0.1:3080/?token=XXXXXXXX
// 客户端 bundle 也不再按包单独提供，而是在首页用一个合并请求下发：
//   /plugins/??<id>/client.js,<id>/client.js&rev=…
const targetPort = Number(process.argv[2] || 3080);
const token = process.argv[3] || process.env.DSH_WEB_TOKEN || '';
const base = `http://127.0.0.1:${targetPort}`;
const COMBINED = /\/plugins\/\?\?[^"'\s]+/g;

console.log(`verify dsh-usage on ${base}\n`);

if (!token) {
  console.log('  ✗ 缺少进程令牌：/api 与首页在令牌栅栏之后，不带令牌必然 401。');
  console.log('    令牌来自 dsh web 启动时打印的地址，例如');
  console.log('      dsh web: http://127.0.0.1:3080/?token=XXXXXXXX');
  console.log('    用法：node scripts\\verify-install.mjs <port> <token>');
  process.exit(2);
}

let failures = 0;
async function check(label, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
  } catch (e) {
    failures++;
    console.log(`  ✗ ${label}: ${e.message}`);
  }
}

/** 用进程令牌换取会话 cookie：GET /?token=… 返回 303 并种下 cookie。 */
async function cookieFromToken() {
  const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', cache: 'no-store' });
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`token exchange HTTP ${res.status} returned no cookie (stale token?)`);
  return cookie;
}

let cookie = '';
await check('进程令牌换取会话 cookie', async () => {
  cookie = await cookieFromToken();
  return `${cookie.split('=')[0]}=…`;
});

const authed = (path, init) => fetch(`${base}${path}`, { cache: 'no-store', ...init, headers: { cookie, ...init?.headers } });

/** 首页里那个包含本插件的合并 bundle 请求。 */
async function pluginBundleUrl() {
  const html = await (await authed('/')).text();
  const combined = html.match(COMBINED) ?? [];
  if (combined.length === 0) throw new Error('首页没有 /plugins/?? 合并清单');
  const hit = combined.find((u) => u.includes('dsh-usage-plugin/client.js'));
  if (!hit) throw new Error('合并清单里没有 dsh-usage-plugin/client.js —— loader 未挂载该插件行');
  return hit.replaceAll('&amp;', '&');
}

await check('stats route 200 + 真实数据', async () => {
  const res = await authed('/api/dsh-usage/stats');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'stats failed');
  return `balance=${j.balance.total}${j.balance.currency} today=${j.usage.today.tokens} tokens 命中率=${(j.usage.today.cacheHitRate * 100).toFixed(0)}%`;
});

await check('balance route 200', async () => {
  const res = await authed('/api/dsh-usage/balance');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'balance failed');
  return `total=${j.total}${j.currency}`;
});

await check('客户端行已物化（首页合并清单含本插件）', async () => {
  await pluginBundleUrl();
  return 'ok';
});

await check('合并 bundle 200 且内含本插件面板', async () => {
  const url = await pluginBundleUrl();
  const res = await fetch(`${base}${url}`, { cache: 'no-store', headers: { cookie } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('__ModuleLoader__')) throw new Error('bundle lacks __ModuleLoader__');
  if (!text.includes('dsh-usage-plugin-panel')) throw new Error('bundle lacks this plugin\'s panel id');
  return `${(text.length / 1024 / 1024).toFixed(1)} MB`;
});

console.log(failures === 0 ? '\nVERIFY PASS ✅ 插件已完整生效' : `\nVERIFY FAIL (${failures}) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
// 让 keep-alive 连接自然关闭后再退出，避免 libuv 关闭断言噪音
setTimeout(() => process.exit(process.exitCode), 1500);
