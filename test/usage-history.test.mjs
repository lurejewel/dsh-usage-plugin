// Unit tests for the session-log reader: multi-frame zstd decode + per-step dedup.
// Run directly: node test/usage-history.test.mjs   (sandbox-safe; --test spawns children)
import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanZstdFrames, decodeSessionLog, aggregateSessionLog, computeUsageHistory, localDayKey } from '../lib/usage-history.js';

const D = 86400000;
const today = new Date().setHours(0, 0, 0, 0);
const yesterday = today - D;

function writeSession(batches) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshu-test-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const buf = Buffer.concat(batches.map((b) => zstdCompressSync(Buffer.from(b.join('\n') + '\n'))));
  fs.writeFileSync(file, buf);
  return { dir, file };
}

test('scanZstdFrames finds all frames in a multi-frame artifact', () => {
  const header = { type: 'session', version: 0, id: 's', createdAt: Date.now() };
  const ev1 = { type: 'user/message', time: Date.now(), data: {} };
  const { file } = writeSession([[JSON.stringify(header)], [JSON.stringify(ev1)], [JSON.stringify(ev1)]]);
  const frames = scanZstdFrames(fs.readFileSync(file));
  assert.equal(frames.length, 3);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('decodeSessionLog recovers all rows across frames', () => {
  const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: Date.now() });
  const a = JSON.stringify({ type: 'turn/start', time: today, data: {} });
  const b = JSON.stringify({ type: 'turn/end', time: today, data: {} });
  const { file } = writeSession([[header, a], [b]]);
  const lines = decodeSessionLog(file);
  assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['session', 'turn/start', 'turn/end']);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('aggregateSessionLog dedupes chunk+message usage per (turn, step)', () => {
  const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: yesterday });
  // step 1 reported twice (chunk + message, identical numbers)
  const chunk1 = JSON.stringify({
    type: 'assistant/chunk', time: yesterday + 1000,
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 5 } } },
  });
  const msg1 = JSON.stringify({
    type: 'assistant/message', time: yesterday + 2000,
    data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 5 } },
  });
  // step 2 only once (message)
  const msg2 = JSON.stringify({
    type: 'assistant/message', time: yesterday + 3000,
    data: { turn: 1, step: 2, usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 10 } },
  });
  const { file } = writeSession([[header, chunk1, msg1, msg2]]);
  const byDay = aggregateSessionLog(file);
  // localDayKey uses local time; derive the same key the lib uses:
  const key = localDayKey(yesterday);
  const e = byDay.get(key);
  assert.ok(e, 'day entry exists');
  // step1 counted once: 100+10+5 = 115; step2: 200+20+10 = 230; total 345
  assert.equal(e.tokens, 345);
  assert.equal(e.samples, 2);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('computeUsageHistory windows to 30 days ending today', () => {
  const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: today - 3 * D });
  const old = JSON.stringify({ type: 'assistant/message', time: today - 3 * D, data: { turn: 1, step: 1, usage: { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } } });
  const recent = JSON.stringify({ type: 'assistant/message', time: today + 1000, data: { turn: 2, step: 1, usage: { inputTokens: 30, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } } });
  const { dir, file } = writeSession([[header, old, recent]]);
  const root = path.dirname(file);
  // move the session dir so scanAllSessions finds it: sessions/<ws>/<sid>/session.jsonl.zstd
  const ws = path.join(dir, 'ws', 'session-x');
  fs.mkdirSync(ws, { recursive: true });
  fs.renameSync(file, path.join(ws, 'session.jsonl.zstd'));
  const hist = computeUsageHistory(path.join(dir, 'ws'), 30);
  assert.equal(hist.days.length, 30);
  assert.equal(hist.days[29].tokens, 30);
  assert.equal(hist.totals, 80); // both days in window
  assert.equal(hist.avgDaily, Math.round((80 / 30) * 100) / 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeUsageHistory defaults to 7 days', () => {
  const header = JSON.stringify({ type: 'session', version: 0, id: 's', createdAt: today });
  const ev = JSON.stringify({ type: 'assistant/message', time: today + 1000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } } });
  const { dir, file } = writeSession([[header, ev]]);
  const ws = path.join(dir, 'ws', 'session-x');
  fs.mkdirSync(ws, { recursive: true });
  fs.renameSync(file, path.join(ws, 'session.jsonl.zstd'));
  const hist = computeUsageHistory(path.join(dir, 'ws'));
  assert.equal(hist.days.length, 7);
  assert.equal(hist.days[6].tokens, 10);
  fs.rmSync(dir, { recursive: true, force: true });
});
