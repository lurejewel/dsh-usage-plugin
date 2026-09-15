# dsh-usage-plugin

[![npm version](https://img.shields.io/npm/v/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![npm downloads](https://img.shields.io/npm/dm/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A native sidebar usage panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web: shows your **official DeepSeek balance** and **token usage history** (today / last 7 days) right in the sidebar, with no separate process and no cross-origin calls.

A trigger button appears at the bottom of the left sidebar, above Settings — full-width with a label when the sidebar is expanded, a compact icon when collapsed. Click it to open the panel: live balance, today's input / output / cache tokens, and a 7-day trend computed from your own session logs.

## Features

- **Official balance** — live query of `api.deepseek.com/user/balance` using the API key DSH already has (`DEEPSEEK_API_KEY` from your credentials), never stored in the browser.
- **Token usage history** — reads your `$DSH_HOME/sessions` logs and aggregates input / output / cache tokens per day (today, totals, daily average, cache hit rate).
- **Sidebar integration** — registers a `sidebar.footer.action` trigger and a `shell.overlay` modal; layout follows the DSH design tokens (light/dark themes included).
- **Zero footprint** — no daemon, no config, no database; data comes from the same DSH installation you already run.

## Requirements

| Requirement | Version |
|---|---|
| DeepSeek Harness | `>= 0.1.0-rc.7` (verified on `0.1.5-rc.2`) |
| Node.js | `>= 20` |
| pnpm | `>= 10` (for `dsh plugin` installation) |
| API key | an existing `DEEPSEEK_API_KEY` credential (the one DSH already uses) |

## Installation

From anywhere, run:

```sh
dsh plugin --profile web add dsh-usage-plugin
```

That's it — the package declares a `dsh.bundle` patch, so `dsh plugin` automatically mounts it into the profile layer stack. Then:

1. **Restart** `dsh web` (stop and start the process). The loader tree is composed once at boot, so a plugin installed into a running server is not picked up until then.
2. **Hard refresh** the browser (`Cmd/Ctrl+Shift+R`).
3. Look for the usage icon at the bottom of the left sidebar.

### Verifying the install

`GET /api/dsh-usage/balance` and `GET /api/dsh-usage/stats?days=N` sit behind the same **process-token fence** as the rest of DSH's `/api` (dsh >= 0.1.5), so a bare `curl` gets `401 unauthorized`. Use the browser page, or pass the token that `dsh web` prints at startup:

```sh
# dsh web: http://127.0.0.1:3080/?token=XXXXXXXX
node scripts/verify-install.mjs 3080 XXXXXXXX
```

The verifier ships with the package, so an npm install can run it from `~/.dsh/profiles/web/node_modules/dsh-usage-plugin`.

### Alternatives

- **From GitHub**: `dsh plugin --profile web add github:lurejewel/dsh-usage-plugin`
- **From a release tarball**: `dsh plugin --profile web add https://github.com/lurejewel/dsh-usage-plugin/archive/refs/tags/v0.1.3.tar.gz`
- **From a local checkout** (development): run the same command from inside this repo. Quote the path: `dsh plugin` forwards its arguments to pnpm through a shell without quoting them, so an unquoted path containing spaces is split into several package specs — `D:\Software\DeepSeek Harness\dsh-usage-plugin` becomes `link:D:/Software/DeepSeek` plus a phantom `Harness\dsh-usage-plugin` dependency, and the plugin is dropped from `dsh.profile.bundles`:

```sh
dsh plugin --profile web add '"D:\Software\DeepSeek Harness\dsh-usage-plugin"'
```

`scripts/install-local.ps1` does exactly this.

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

- DSH session logs (`session.<generation>.jsonl.zstd`) are **multiple concatenated zstd frames** (one frame per persistence batch); the reader scans frame-by-frame instead of assuming a single frame. One damaged frame costs only its own rows.
- Session artifacts are **versioned format generations** — `session.jsonl.zstd` is the released v0 root, `session.vN.jsonl.zstd` a later one, and DSH always writes and reads the highest generation present in a session directory. The reader therefore selects the **highest canonical generation per session** (never the plain v0 file alone, and never more than one file per session): a lower generation stops at that session's migration point, while reading two of them would double-count.
- `assistant/message` and `assistant/chunk` events report the **same usage numbers for the same (turn, step)**; the reader de-duplicates by (turn, step) so totals are not double-counted.
- The API key is resolved through DSH's `credentials` service — the same source the DeepSeek provider uses. Nothing is stored in the browser; all calls are same-origin.
- Both routes inherit DSH's browser-trust fence, and on dsh >= 0.1.5 the client bundle is delivered as part of the shell's single combined `/plugins/??…` request rather than per-package URLs. Neither changes the browser half: it runs inside the authenticated page.

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
npm run verify -- 3080 <token> # post-restart check against a running dsh web
```

`lib/` is the shipped artifact and doubles as readable source (plain ESM, documented).

### Windows helper scripts (optional)

- `scripts/install-local.ps1` — one-click local install as a `link:` to this repo (quotes the path for the `dsh plugin` shell hop).
- `scripts/restart-web.ps1` — restart `dsh web`, read the tokenized URL from the server log, then run the verification.
- `scripts/verify-install.mjs` — post-restart check: token exchange, stats/balance routes, materialized client row, combined bundle contents. On dsh >= 0.1.5 it needs `<port> <token>`.

The two `.ps1` helpers live in the git checkout only; `verify-install.mjs` is published in the npm package as well.

## License

[MIT](LICENSE)
