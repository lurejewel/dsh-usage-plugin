// dsh-usage server half: a cordis plugin that registers same-origin HTTP
// routes on the DSH web server.
//
//   GET /api/dsh-usage/balance  -> official DeepSeek balance (live)
//   GET /api/dsh-usage/stats    -> balance + token usage history (session logs)
//
// The API key comes from the credentials service (dsh-credentials-local reads
// $DSH_HOME/.credentials.yaml), the same source the llm-deepseek provider uses.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeUsageHistory } from './usage-history.js';

export const name = 'dsh-usage-plugin';
export const inject = ['webServer', 'credentials'];

const BASE_URL = 'https://api.deepseek.com';
const KEY_REF = 'DEEPSEEK_API_KEY';
const SESSION_ROOT =
  process.env.DSH_HOME != null
    ? join(process.env.DSH_HOME, 'sessions')
    : join(homedir(), '.dsh', 'sessions');

/** Resolve the DeepSeek API key through the credentials provider. */
export async function resolveKey(credentials, ref = KEY_REF) {
  const cred = await credentials.resolve(ref);
  if (!cred || !cred.value) throw new Error(`${ref} 未配置（检查 credentials）`);
  return cred.value;
}

/** Fetch the official balance. Throws on failure. */
export async function fetchBalance(credentials, baseUrl = BASE_URL, ref = KEY_REF) {
  const key = await resolveKey(credentials, ref);
  const res = await fetch(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`balance API HTTP ${res.status}`);
  const j = await res.json();
  const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
  const info = infos.find((i) => i.currency === 'CNY') || infos[0] || null;
  return {
    ok: true,
    is_available: j.is_available !== false,
    currency: info ? info.currency : null,
    total: info ? Number(info.total_balance) : null,
    granted: info ? Number(info.granted_balance) : null,
    topped_up: info ? Number(info.topped_up_balance) : null,
  };
}

/** Full stats payload: balance + usage history (session root overridable for tests). */
export async function buildStats(credentials, sessionRoot = SESSION_ROOT, days = 7) {
  const balance = await fetchBalance(credentials);
  const usage = computeUsageHistory(sessionRoot, days);
  return { ok: true, balance, usage, generatedAt: Date.now() };
}

/** Parse `?days=` from a request URL; defaults to 7, clamped to 1..90. */
export function daysFromQuery(req, fallback = 7) {
  const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('days');
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(90, Math.round(n)));
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-usage/balance',
    handler: async (_req, res) => {
      try {
        sendJson(res, await fetchBalance(ctx.credentials));
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) }, 502);
      }
    },
  });

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-usage/stats',
    handler: async (req, res) => {
      try {
        sendJson(res, await buildStats(ctx.credentials, SESSION_ROOT, daysFromQuery(req)));
      } catch (e) {
        sendJson(res, { ok: false, error: String(e.message || e) }, 502);
      }
    },
  });
}
