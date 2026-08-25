// 重启 dsh web 后的一键验证：检查插件是否在目标实例上完整生效。
// 用法：node scripts\verify-install.mjs [port]   （默认 3080）
// 检查项：服务端统计路由 / 余额路由 / 客户端 bundle / boot manifest
const targetPort = Number(process.argv[2] || 3080);
const base = `http://127.0.0.1:${targetPort}`;

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

console.log(`verify dsh-usage on ${base}\n`);

await check("stats route 200 + 真实数据", async () => {
  const res = await fetch(`${base}/api/dsh-usage/stats`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'stats failed');
  return `balance=${j.balance.total}${j.balance.currency} today=${j.usage.today.tokens} tokens 命中率=${(j.usage.today.cacheHitRate * 100).toFixed(0)}%`;
});

await check("balance route 200", async () => {
  const res = await fetch(`${base}/api/dsh-usage/balance`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'balance failed');
  return `total=${j.total}${j.currency}`;
});

await check("client bundle 200 + ModuleLoader", async () => {
  const res = await fetch(`${base}/plugins/dsh-usage-plugin/client.js`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('__ModuleLoader__')) throw new Error('bundle lacks __ModuleLoader__');
  return `${text.length} bytes`;
});

await check("boot manifest 包含插件", async () => {
  const res = await fetch(`${base}/`, { cache: 'no-store' });
  const html = await res.text();
  const m = html.match(/__DSH_BOOT__\s*=\s*(\{.*?\})\s*<\/script>/s);
  if (!m) throw new Error('no boot manifest found');
  if (!m[1].includes('dsh-usage-plugin')) throw new Error('manifest missing dsh-usage-plugin');
  return 'ok';
});

console.log(failures === 0 ? '\nVERIFY PASS ✅ 插件已完整生效' : `\nVERIFY FAIL (${failures}) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
// 让 keep-alive 连接自然关闭后再退出，避免 libuv 关闭断言噪音
setTimeout(() => process.exit(process.exitCode), 1500);
