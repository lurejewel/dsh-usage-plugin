// Unit tests for the session-log reader: multi-frame zstd decode + per-step dedup.
// Run directly: node test/usage-history.test.mjs   (sandbox-safe; --test spawns children)
import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanZstdFrames, decodeSessionLog, aggregateSessionLog, computeUsageHistory, localDayKey, generationOf, selectSessionArtifact, scanAllSessions } from '../lib/usage-history.js';

const D = 86400000;
const today = new Date().setHours(0, 0, 0, 0);
const yesterday = today - D;

function writeSession(batches, name = 'session.jsonl.zstd') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshu-test-'));
  const file = path.join(dir, name);
  const buf = Buffer.concat(batches.map((b) => zstdCompressSync(Buffer.from(b.join('\n') + '\n'))));
  fs.writeFileSync(file, buf);
  return { dir, file };
}

/** Lay out sessions/<ws>/<sid>/<name> so scanAllSessions finds it. */
function layout(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshu-root-'));
  const sessionDir = path.join(root, 'ws', 'session-x');
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const [name, batches] of Object.entries(files)) {
    const buf = Buffer.concat(batches.map((b) => zstdCompressSync(Buffer.from(b.join('\n') + '\n'))));
    fs.writeFileSync(path.join(sessionDir, name), buf);
  }
  return { root, sessionDir };
}

function usageRow(time, turn, step, input) {
  return JSON.stringify({
    type: 'assistant/message', time,
    data: { turn, step, usage: { inputTokens: input, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } },
  });
}

const header = (version, createdAt) => JSON.stringify({ type: 'session', version, id: 's', createdAt });

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

// ---- format generations -----------------------------------------------------

test('generationOf parses canonical generations and rejects noncanonical names', () => {
  assert.equal(generationOf('session.jsonl.zstd'), 0);
  assert.equal(generationOf('session.jsonl'), 0);
  assert.equal(generationOf('session.v1.jsonl.zstd'), 1);
  assert.equal(generationOf('session.v3.jsonl.zstd'), 3);
  assert.equal(generationOf('session.v12.jsonl'), 12);
  // noncanonical: v0 tag, leading zero, uppercase, temp, unrelated
  assert.equal(generationOf('session.v0.jsonl.zstd'), null);
  assert.equal(generationOf('session.v03.jsonl.zstd'), null);
  assert.equal(generationOf('session.V3.jsonl.zstd'), null);
  assert.equal(generationOf('session.v3.jsonl.zstd.tmp'), null);
  assert.equal(generationOf('session_projcache.json'), null);
});

test('selectSessionArtifact prefers the highest generation', () => {
  const dir = 'D:\\sessions\\session-x';
  const entries = [
    { name: 'session.jsonl.zstd', isFile: () => true },
    { name: 'session.v3.jsonl.zstd', isFile: () => true },
    { name: 'session.lock', isFile: () => true },
    { name: 'sub', isFile: () => false },
  ];
  const best = selectSessionArtifact(entries, dir);
  assert.equal(best.version, 3);
  assert.equal(best.file, path.join(dir, 'session.v3.jsonl.zstd'));
  assert.equal(selectSessionArtifact([{ name: 'session.lock', isFile: () => true }], dir), null);
});

test('scanAllSessions reads the current (vN) generation, not just the v0 root', () => {
  // The real-world shape: a v0 root holding only the session prelude, plus a
  // v3 successor carrying every event — including today's usage.
  const { root } = layout({
    'session.jsonl.zstd': [[header(0, yesterday)]],
    'session.v3.jsonl.zstd': [[header(3, yesterday), usageRow(today + 1000, 1, 1, 100), usageRow(today + 2000, 1, 2, 200)]],
  });
  const hist = computeUsageHistory(root, 7);
  assert.equal(hist.days[6].tokens, 300);
  assert.equal(hist.today.tokens, 300);
  assert.equal(hist.days[6].hasData, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanAllSessions never double counts a migrated session', () => {
  // v0 holds step 1; the v3 successor holds step 1 again plus step 2. Only the
  // successor may count, so step 1 must not be counted twice.
  const { root } = layout({
    'session.jsonl.zstd': [[header(0, yesterday), usageRow(yesterday + 1000, 1, 1, 100)]],
    'session.v3.jsonl.zstd': [[header(3, yesterday), usageRow(yesterday + 1000, 1, 1, 100), usageRow(today + 2000, 1, 2, 200)]],
  });
  const hist = computeUsageHistory(root, 7);
  assert.equal(hist.totals, 300); // 100 once + 200, not 400
  assert.equal(hist.days[5].tokens, 100); // the migrated day keeps its old value
  assert.equal(hist.days[6].tokens, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanAllSessions still reads unmigrated v0-only sessions', () => {
  const { root } = layout({
    'session.jsonl.zstd': [[header(0, today), usageRow(today + 1000, 1, 1, 42)]],
  });
  const hist = computeUsageHistory(root, 7);
  assert.equal(hist.days[6].tokens, 42);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- damaged-frame tolerance ------------------------------------------------

test('decodeSessionLog keeps the surviving rows when one committed frame is corrupt', () => {
  const { file } = writeSession([
    [header(3, today)],
    [usageRow(today + 1000, 1, 1, 100)],
    [usageRow(today + 2000, 1, 2, 200)],
  ]);
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  assert.equal(frames.length, 3);
  // Flip a payload byte inside the SECOND frame only, leaving its
  // length/checksum structure intact so the scan still finds all three.
  const second = frames[1];
  const corrupt = Buffer.from(buf);
  corrupt[second.end - 5] ^= 0xff;
  fs.writeFileSync(file, corrupt);

  const types = decodeSessionLog(file).map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ['session', 'assistant/message']);
  const byDay = aggregateSessionLog(file);
  const e = byDay.get(localDayKey(today));
  assert.equal(e.tokens, 200); // step 2 survived, step 1 was lost
  assert.equal(e.samples, 1);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('scanAllSessions survives a missing root', () => {
  assert.equal(scanAllSessions(path.join(os.tmpdir(), 'dshu-does-not-exist-' + Date.now())).size, 0);
});
