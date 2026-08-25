// Session-log usage history reader.
//
// DSH persists each session as a *concatenation of independent Zstandard
// frames* (one frame per durable event batch), stored at
// $DSH_HOME/sessions/<workspace>/<session-id>/session.jsonl.zstd.
// Node's one-shot zstd API decodes a single frame, so we first scan frame
// boundaries (mirroring dsh-session-persistence-jsonl's scanZstdFrames), then
// decode frame by frame and parse JSONL rows. Rows that report provider token
// usage (assistant/message with data.usage, or assistant/chunk usage chunks)
// are folded into per-day buckets.
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528, little-endian

/** Locate complete zstd frames in a session artifact; torn tail is ignored. */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  outer: while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break outer;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break outer;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Decode a session artifact into its JSONL lines. */
export function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  const frames = scanZstdFrames(buf);
  const lines = [];
  for (const f of frames) {
    const text = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim()) lines.push(line);
    }
  }
  return lines;
}

/** Extract provider token usage from an event row, or null. */
export function usageOf(event) {
  if (!event || typeof event !== 'object') return null;
  const t = event.type;
  if (t === 'assistant/message' && event.data && event.data.usage) {
    return { time: event.time, usage: event.data.usage };
  }
  if (t === 'assistant/chunk' && event.data && event.data.chunk && event.data.chunk.type === 'usage') {
    return { time: event.time, usage: event.data.chunk.usage };
  }
  return null;
}

/** Bucket a usage record into countable token groups. */
export function tokensOf(usage) {
  const input = usage.inputTokens ?? 0;
  const output = (usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0);
  const cacheRead = usage.cacheReadTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    total: input + output + cacheRead,
  };
}

export function localDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Fold one session artifact into a per-day Map<dayKey, {tokens, input, output, cacheRead, samples}>. */
export function aggregateSessionLog(file, byDay = new Map()) {
  // Each step's usage is reported twice in the log: once as an assistant/chunk
  // usage chunk and once on the final assistant/message row, with identical
  // numbers. Dedupe per (turn, step) so each step is counted once.
  const seenSteps = new Set();
  for (const line of decodeSessionLog(file)) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const hit = usageOf(ev);
    if (!hit) continue;
    const { turn, step } = ev.data || {};
    if (typeof turn === 'number' && typeof step === 'number') {
      const key = `${turn}:${step}`;
      if (seenSteps.has(key)) continue;
      seenSteps.add(key);
    }
    const day = localDayKey(hit.time);
    const t = tokensOf(hit.usage);
    const e = byDay.get(day) || { tokens: 0, input: 0, output: 0, cacheRead: 0, samples: 0 };
    e.tokens += t.total;
    e.input += t.input;
    e.output += t.output;
    e.cacheRead += t.cacheRead;
    e.samples += 1;
    byDay.set(day, e);
  }
  return byDay;
}

/**
 * Scan every session artifact under the session root for the last `days`
 * calendar days (all time, then the caller windows). Corrupt/partial files
 * are skipped.
 */
export function scanAllSessions(root, byDay = new Map()) {
  if (!fs.existsSync(root)) return byDay;
  const walk = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (e.isFile() && /^session\.jsonl(\.zstd)?$/.test(e.name)) {
        try {
          aggregateSessionLog(p, byDay);
        } catch {
          /* skip corrupt artifact */
        }
      }
    }
  };
  walk(root, 0);
  return byDay;
}

/** Last `days` calendar-day keys ending today (local time), oldest first. */
export function buildDays(days = 30) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(localDayKey(d.getTime()));
  }
  return out;
}

/** Aggregate session history into a 7-day series (default) + today totals. */
export function computeUsageHistory(sessionRoot, windowDays = 7) {
  const byDay = scanAllSessions(sessionRoot);
  const keys = buildDays(windowDays);
  const series = keys.map((key) => {
    const e = byDay.get(key);
    return {
      date: key,
      tokens: e ? e.tokens : 0,
      input: e ? e.input : 0,
      output: e ? e.output : 0,
      cacheRead: e ? e.cacheRead : 0,
      hasData: !!e,
    };
  });
  const today = series[series.length - 1];
  const cacheHitRate = (e) =>
    e && e.tokens > 0 ? Math.round((e.cacheRead / e.tokens) * 10000) / 10000 : 0;
  const todayE = byDay.get(today.date);
  const totalsE = series.reduce(
    (s, d) => ({
      tokens: s.tokens + d.tokens,
      input: s.input + d.input,
      output: s.output + d.output,
      cacheRead: s.cacheRead + d.cacheRead,
    }),
    { tokens: 0, input: 0, output: 0, cacheRead: 0 }
  );
  return {
    days: series,
    today: {
      tokens: today.tokens,
      input: today.input,
      output: today.output,
      cacheRead: today.cacheRead,
      cacheHitRate: cacheHitRate(todayE),
    },
    totals: totalsE.tokens,
    totalsCacheHitRate: cacheHitRate(totalsE),
    avgDaily: Math.round((totalsE.tokens / windowDays) * 100) / 100,
  };
}
