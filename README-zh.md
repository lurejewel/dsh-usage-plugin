# dsh-usage-plugin

[![npm version](https://img.shields.io/npm/v/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![npm downloads](https://img.shields.io/npm/dm/dsh-usage-plugin.svg)](https://www.npmjs.com/package/dsh-usage-plugin) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 的原生侧边栏用量面板：在侧边栏直接展示你的**官方 DeepSeek 余额**与 **token 用量历史**（今日 / 近 7 天）。无独立进程、无跨域请求。

左侧边栏底部（Settings 上方）会出现一个用量按钮——侧边栏展开时为全宽带文字按钮，收起时为紧凑图标。点击弹出面板：实时余额、今日输入/输出/缓存 token 分列、以及基于你自己会话日志计算的 7 天趋势。

## 功能

- **官方余额** — 使用 DSH 已有的 API Key（credentials 中的 `DEEPSEEK_API_KEY`）实时查询 `api.deepseek.com/user/balance`，Key 绝不进入浏览器。
- **用量历史** — 读取 `$DSH_HOME/sessions` 会话日志，按天聚合输入 / 输出 / 缓存 token（今日、总量、日均、缓存命中率）。
- **侧边栏集成** — 注册 `sidebar.footer.action` 触发器与 `shell.overlay` 模态弹窗；样式跟随 DSH 设计令牌（深浅色主题自动适配）。
- **零负担** — 无守护进程、无配置、无数据库，数据全部来自你正在运行的同一套 DSH。

## 环境要求

| 要求 | 版本 |
|---|---|
| DeepSeek Harness | `>= 0.1.0-rc.7`（已在 `0.1.5-rc.2` 上验证） |
| Node.js | `>= 20` |
| pnpm | `>= 10`（用于 `dsh plugin` 安装） |
| API Key | 已有 `DEEPSEEK_API_KEY` 凭据（即 DSH 本身在用的那个） |

## 安装

任意目录下执行：

```sh
dsh plugin --profile web add dsh-usage-plugin
```

包声明了 `dsh.bundle` patch，`dsh plugin` 会自动把它挂进 profile 的配置层栈，无需手动写挂载行。之后：

1. **重启** `dsh web`（停掉再启动进程）。加载树只在 boot 时组装一次，装到正在运行的实例里不会被感知；
2. 浏览器**硬刷新**（`Cmd/Ctrl+Shift+R`）；
3. 左侧边栏底部出现用量图标。

### 安装后自检

`GET /api/dsh-usage/balance` 与 `GET /api/dsh-usage/stats?days=N` 和 DSH 其余 `/api` 一样在**进程令牌栅栏**之后（dsh >= 0.1.5），裸 `curl` 只会拿到 `401 unauthorized`。用浏览器页面，或者带上 `dsh web` 启动时打印的令牌：

```sh
# dsh web: http://127.0.0.1:3080/?token=XXXXXXXX
node scripts/verify-install.mjs 3080 XXXXXXXX
```

自检脚本随包发布，npm 安装的用户可以在 `~/.dsh/profiles/web/node_modules/dsh-usage-plugin` 里执行它。

### 其他安装方式

- **GitHub**：`dsh plugin --profile web add github:lurejewel/dsh-usage-plugin`
- **Release tarball**：`dsh plugin --profile web add https://github.com/lurejewel/dsh-usage-plugin/archive/refs/tags/v0.1.2.tar.gz`
- **本地开发**：在本仓库目录内执行安装命令，但**路径必须带引号**——`dsh plugin` 把参数经 shell 转发给 pnpm 时不加引号，含空格的路径会被拆成多个 spec：`D:\Software\DeepSeek Harness\dsh-usage-plugin` 会变成 `link:D:/Software/DeepSeek` 加一个假依赖 `Harness\dsh-usage-plugin`，并让插件从 `dsh.profile.bundles` 里消失：

```sh
dsh plugin --profile web add '"D:\Software\DeepSeek Harness\dsh-usage-plugin"'
```

`scripts/install-local.ps1` 已经按这个方式处理。

- **老版本手动挂载**：在 `~/.dsh/profiles/web/cordis.patch.yml` 追加以下内容后重启：

```yaml
- insert:
    - id: dsh-usage-plugin
      name: dsh-usage-plugin
```

### 卸载

```sh
dsh plugin --profile web remove dsh-usage-plugin
```

然后重启 `dsh web`。

## 工作原理

一个包、双面，作为普通 Cordis 插件挂载：

```
lib/index.js          服务端半：在 DSH web 服务器上注册同源 HTTP 路由
lib/client.js         浏览器半：__ModuleLoader__ bundle，随 Web GUI 下发
lib/usage-history.js  会话日志读取器（zstd 多帧扫描 + 按步去重 + 按天聚合）
```

- `GET /api/dsh-usage/balance` — 实时官方余额（服务端发起请求，Key 不出服务器）。
- `GET /api/dsh-usage/stats?days=N` — 余额 + 用量历史；`N` 默认 7，范围 1–90。

值得了解的实现细节：

- DSH 会话日志（`session.jsonl.zstd`）是**多个独立 zstd 帧拼接**（每次持久化一批事件一帧）；读取器逐帧扫描，而不是假定单帧。
- `assistant/message` 与 `assistant/chunk` 事件会对**同一个 (turn, step) 重复上报相同数值**；读取器按 (turn, step) 去重，避免总量翻倍。
- API Key 通过 DSH 的 `credentials` 服务解析——与 DeepSeek 模型提供商同源；浏览器不存任何 Key，所有请求均同源。
- 两个路由都继承 DSH 的浏览器信任栅栏；且 dsh >= 0.1.5 把客户端 bundle 合并进 shell 的单个 `/plugins/??…` 请求，不再按包单独下发。这两点都不影响浏览器半——它运行在已鉴权的页面里。

## 隐私与安全

- 余额请求由你的**服务器**发往 `api.deepseek.com`，API Key 永不进入浏览器。
- 面板只读取 `$DSH_HOME/sessions` 下你自己的会话日志。
- 无遥测、无任何第三方网络调用。

## 开发

```sh
npm test                       # 单元测试（帧扫描 / 解码 / 去重 / 30 天窗口）
npm run test:client-boot       # 在 Node 中用 mock slots 启动真实 client bundle
npm run test:standalone        # 进程内 E2E：真实 cordis + 真实接口 + 真实日志
                              #   （需要本机 DSH 安装：$DSH_HOME/profiles/node_modules
                              #    下可解析 @deepseek-ai 包、有 DEEPSEEK_API_KEY 凭据与会话日志）
npm run verify -- 3080 <token> # 针对正在运行的 dsh web 做安装后自检
```

`lib/` 即交付产物，同时也是可读源码（纯 ESM，带注释）。

### Windows 辅助脚本（可选）

- `scripts/install-local.ps1` — 一键本地安装（以 `link:` 指向本仓库，路径按 `dsh plugin` 的 shell 转发要求加了引号）。
- `scripts/restart-web.ps1` — 重启 `dsh web`，从服务日志里取回带令牌的地址，再跑自检。
- `scripts/verify-install.mjs` — 重启后自检：令牌换 cookie、stats/balance 路由、客户端行是否物化、合并 bundle 内容。dsh >= 0.1.5 下需要 `<port> <token>`。

两个 `.ps1` 只在 git 仓库里；`verify-install.mjs` 同时随 npm 包发布。

## License

[MIT](LICENSE)
