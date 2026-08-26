# dsh-usage-plugin

[![npm version](https://img.shields.io/npm/v/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![npm downloads](https://img.shields.io/npm/dm/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A native sidebar usage panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web: shows your **official DeepSeek balance** and **token usage history** (today / last 7 days) right in the sidebar, with no separate process and no cross-origin calls.

A small trigger button appears at the bottom of the left sidebar (beside Settings). Click it to open the panel: live balance, today's input / output / cache tokens, and a 30-day trend computed from your own session logs.

## Features

- **Official balance** — live query of `api.deepseek.com/user/balance` using the API key DSH already has (`DEEPSEEK_API_KEY` from your credentials), never stored in the browser.
- **Token usage history** — reads your `$DSH_HOME/sessions` logs and aggregates input / output / cache tokens per day (today, totals, daily average, cache hit rate).
- **Sidebar integration** — registers a `sidebar.footer.action` trigger and a `shell.overlay` modal; layout follows the DSH design tokens (light/dark themes included).
- **Zero footprint** — no daemon, no config, no database; data comes from the same DSH installation you already run.

## Requirements

| Requirement | Version |
|---|---|
| DeepSeek Harness | `>= 0.1.0-rc.7` (tested on `0.1.0-rc.7` and `0.1.1-rc.2`) |
| Node.js | `>= 20` |
| pnpm | `>= 10` (for `dsh plugin` installation) |
| API key | an existing `DEEPSEEK_API_KEY` credential (the one DSH already uses) |

## Installation

From anywhere, run:

```sh
dsh plugin --profile web add dsh-usage-plugin
```

That's it — the package declares a `dsh.bundle` patch, so `dsh plugin` automatically mounts it into the profile layer stack. Then:

1. **Restart** `dsh web` (stop and start the process).
2. **Hard refresh** the browser (`Cmd/Ctrl+Shift+R`).
3. Look for the usage icon at the bottom of the left sidebar.

### Alternatives

- **From GitHub**: `dsh plugin --profile web add github:lurejewel/dsh-usage-plugin`
- **From a release tarball**: `dsh plugin --profile web add https://github.com/lurejewel/dsh-usage-plugin/archive/refs/tags/v0.1.1.tar.gz`
- **From a local checkout** (development): run the same command from inside this repo — `dsh plugin --profile web add .`
- **Manual mount on older setups**: add the row below to `~/.dsh/profiles/web/cordis.patch.yml`, then restart:

```yaml
- insert:
    - id: dsh-usage-plugin
      name: dsh-usage-plugin
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-usage-plugin
```

Then restart `dsh web`.

## How it works

One package, two halves, mounted as a normal Cordis plugin:

```
lib/index.js          Host half: same-origin HTTP routes on the DSH web server
lib/client.js         Browser half: __ModuleLoader__ bundle served to the web GUI
lib/usage-history.js  Session-log reader (zstd frame scan + per-step dedup + daily aggregation)
```

- `GET /api/dsh-usage/balance` — live official balance (server-side call, key never leaves the server).
- `GET /api/dsh-usage/stats?days=N` — balance + usage history; `N` defaults to 7, clamped to 1–90.

Implementation notes worth knowing:

- DSH session logs (`session.jsonl.zstd`) are **multiple concatenated zstd frames** (one frame per persistence batch); the reader scans frame-by-frame instead of assuming a single frame.
- `assistant/message` and `assistant/chunk` events report the **same usage numbers for the same (turn, step)**; the reader de-duplicates by (turn, step) so totals are not double-counted.
- The API key is resolved through DSH's `credentials` service — the same source the DeepSeek provider uses. Nothing is stored in the browser; all calls are same-origin.

## Privacy & security

- The balance call goes from your **server** to `api.deepseek.com`; the API key never enters the browser.
- The panel only reads your own session logs under `$DSH_HOME/sessions`.
- No telemetry, no third-party network calls.

## Development

```sh
npm test                       # unit tests (frame scan / decode / dedup / 30-day window)
npm run test:client-boot       # boot the real client bundle in Node against mock slots
npm run test:standalone        # in-process E2E: real cordis + real API + real logs
                              #   (needs a local DSH install with @deepseek-ai packages
                              #    reachable at $DSH_HOME/profiles/node_modules, a
                              #    DEEPSEEK_API_KEY credential, and session logs)
```

`lib/` is the shipped artifact and doubles as readable source (plain ESM, documented).

### Windows helper scripts (optional)

- `scripts/install-local.ps1` — one-click local install (`dsh plugin --profile web add .`).
- `scripts/restart-web.ps1` — restart `dsh web` and run `scripts/verify-install.mjs`.
- `scripts/verify-install.mjs` — post-restart check: stats/balance routes, client bundle, boot manifest.

## License

[MIT](LICENSE)
