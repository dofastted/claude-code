# 本地二进制与部署

只留在本机。不要在父仓库 `git add local-src/`，不要打进 release，不要放进 Netcup overlay 以外的源码包。

`AGENTS.md` 只指向本文件。

## 产物根目录

仓库根 `/mnt/x/vm2api`（Windows `X:\vm2api`）。

| 产物 | 路径 | 是否入库 |
|---|---|---|
| 换票 | `bin/oauth-auth` | 是，只提交 ELF |
| Rust kernel | `bin/kernel` | 是，只提交 ELF |
| 槽内 kernel 副本 | `share/wrap-cli/kernel.bin` | 是 |
| crag kernel | `share/crag/kernel` | 是。单独源码树不在下面三处 |
| cli-node | `share/wrap-cli/cli-node` | 是，只提交 ELF |
| cc-node | `share/wrap-cli/cc-node` | 是 |
| Codex kernel | `bin/codex-kernel` | 是。源码在 `.local/codex-kernel/`（父仓库忽略） |
| Go worker / egress | `bin/worker`、`bin/egress` | 是。源码在已入库的 `worker/`，release workflow 现编 |

`bin/*` 默认忽略，上面这几个 ELF 由 `.gitignore` 的 `!` 放行。

## 源码目录

都在 `local-src/`，整目录被父仓库 `.gitignore` 的 `/local-src/` 忽略。这里有独立的本地 Git 仓库，当前初始分支为 `cleanup/local-src`；未配置远程、未创建提交。仅在本目录管理源码，不在父仓库暂存本目录。依赖、`target/`、`dist/`、临时文件和凭证由本目录 `.gitignore` 忽略，换行统一为 LF。

| 二进制 | 源码 | 说明 |
|---|---|---|
| `bin/oauth-auth` | `local-src/oauth-auth/` | 编译输入是 `service-entry.cjs`。`service-entry.mjs` 是入口草稿。`src/lib/oauth/auth.js` 仍单独忽略，当前工作区没有这份文件 |
| `bin/kernel` | `local-src/kin-kernel/` | Rust 2024 / 1.98。`cargo build --release` 的缓存位于本树 `target/`；旧 `crates/kin-kernel/target` 已于 2026-10-03 清理 |
| `share/wrap-cli/cli-node` | `local-src/cli-node/` | 唯一工作树，版本 2.1.284。`X:\project\kin-kernel-20slot\claude-code` 是旧来源，不要改那份 |
| `bin/codex-kernel` | `.local/codex-kernel/` | 从 `X:\kin\kin-gateway\codex-kernel` 迁入，独立本地 git。父仓库 `.gitignore` 的 `.local/` 忽略整树。`cargo test` / `cargo build --release` 缓存在该树 `target/`。协议对齐 `X:\workspace\codex-proxy-rs`（`fast`→`priority`、`x-codex-routing-hint`、envelope 头）；SOCKS5/`socks5h` 保留 |

旧路径 `crates/kin-kernel`、`patches/claude-code`、`.local/oauth-auth-build` 的源码已迁走。`.local/cookie-auth-build` 是旧的 cookie 工具，不是现在的换票；2026-10-03 清理了二进制、`build/`、`dist/` 和 Python 缓存，保留源码与 `.spec` 构建说明。

## 临时文件与测试

2026-10-03 清理了根目录 `.tmp/`（含 1.3.2–1.3.4 部署包及旧解包目录）、7 个 `.tmp-*` 调试脚本、`.tmp-replay/当时的生产机-2026-09-22/` 一次性回放数据，以及旧 Rust / cookie 工具构建产物。`docs/benchmarks.zip` 与 `docs/benchmarks/` 逐文件字节相同，仅删除 zip 副本。

正式测试保留：Node `test/unit/`、`test/e2e/`、`test/fixtures/`，前端 `web/src/**/*.test.ts`，Go `worker/` 与 `api-kernel/`，以及本地 CLI / Rust 源码内的测试。Node fixtures 仍被 `acceptance.test.mjs` 引用；`docs/benchmarks/` 是文档引用的题库与结果归档。文件日期、旧版本号和 `test` 命名不作为删除依据。

清理后 `npm run test:unit` 通过：178 个文件，2057 passed / 9 skipped / 0 failed。2328 个保留文件（测试、题库、本地源码、预编译二进制与父仓库 `.gitignore`）的 SHA256 与清理前一致。

## 编译和压缩

### 换票

```sh
sh local-src/oauth-auth/build.sh
```

`npx pkg service-entry.cjs --targets node18-linux-x64`，输出 `bin/oauth-auth`。

整文件 UPX 会坏：pkg 按绝对 `PAYLOAD_POSITION` 读尾部，压缩后偏移对不上，运行是 `Pkg: Error reading from file.`

可用的压法：

1. 留下未压缩 ELF。当前 plain 备份如果还在，是 `/tmp/oauth-auth.plain`。
2. 在 section table 结束处切开（等于 `PAYLOAD_POSITION`）。node18 底包不变时切点是 **46205192**。
3. 把 ELF 里 22 字符的 `PAYLOAD_POSITION` / `PRELUDE_POSITION` 改到固定垫片 **13250000**，以及 `13250000 + PAYLOAD_SIZE`。`PAYLOAD_SIZE` / `PRELUDE_SIZE` 每次构建都会差几个字节（pkg 产物不可复现），以本次 plain 为准。
4. 只压前半：`upx --best --lzma`。
5. NUL 垫到 13250000，再接上原来的尾部。

1.3.78 结果 **14432142** 字节，SHA256 `0c25576b00ac05809f7977a9a1caa7d07fe023b4e3b950e02b0d98ecbe267e5f`。

2026-10-01 #198：`service-entry.cjs` 里打包的 `parseSocksURL` 去掉 IPv6 方括号（socks-proxy-agent 10.1.0 把 `[::1]` 当主机名解析）。本次 `PAYLOAD_SIZE=1107783`、`PRELUDE_SIZE=74383`，结果 **14432166** 字节，SHA256 `123b2e33f4eaa3a6749fd939c756d8bc60bc93e16e0f55fa703756f7c49eb6bd`。`::1` SOCKS5 回环可完成握手，IPv4 对照不变。

2026-10-03 本地出口换票：`normalizeSocks("")` 返回空串（直连），`execute` 改 `input.proxy_url ?? null`，`null` 仍报 `proxy_required`；`service-entry.mjs` 草稿同步。本次 `PAYLOAD_SIZE=1107807`、`PRELUDE_SIZE=74383`，UPX 前半 13105756 字节，结果 **14432190** 字节，SHA256 `ddb668f5ce2e9695d500f442f7c6e15c736bdea34abc518224f1c640b650751c`。`proxy_url:""` 直连到上游（假 code 回 400），`null` 回 `proxy_required`，`[::1]` 死 SOCKS 回 `ECONNREFUSED ::1:1`，坏操作仍退出 1。

2026-10-03 sessionKey 换票 `CLAUDE_WEB is not defined`：`service-entry.cjs` 内联的 oauth-contract 段缺 `var CLAUDE_WEB = "https://claude.ai";`（自 a5ef473 起所有已提交二进制都坏），`resolveOrganizationUuid` 在发请求前抛 ReferenceError。已补回。改 bundle 后先跑 Biome `correctness/noUndeclaredVariables`（独立 biome.json，`files.maxSize` 调大），只允许 `arguments` 误报。本次 `PAYLOAD_SIZE=1107879`、`PRELUDE_SIZE=74383`，UPX 前半 13105068 字节，结果 **14432262** 字节，SHA256 `f24e99feb393b77e32a73a1f0aab5330fdb3b1d5975acec97756245d5b65895c`。死 SOCKS 回 `get_organizations_transport`，`proxy_url:""` 直连到 `claude.ai/api/organizations`（假 sessionKey 回 403 `account_session_invalid`），`null` 回 `proxy_required`，坏操作仍退出 1。回归测试：`test/unit/session-oauth-seam.test.mjs` 的 `binary dials the claude.ai organizations hop`。

拆分提交：main `1bc508d` 只带 `CLAUDE_WEB` 修复。构建时临时去掉 bundle 里 px-local 的 `if (proxyUrl === "") return "";`，在 `/tmp` 下用 pkg 构建。`PAYLOAD_SIZE=1107860`、`PRELUDE_SIZE=74374`，UPX 前半 13104916 字节，结果 **14432234** 字节，SHA256 `2167d3b1964c7d1f29075941563b7febd343109d01cfe105020291d4a3a93aa8`。这个构建里 `""` 仍回 `proxy_required`。PR #216（`fix/px-local-oauth-direct`）用的是上面 **14432262** 那份（px-local + `CLAUDE_WEB`）。当前 `service-entry.cjs` 两处改动都在。

2026-10-04 Cookie authorize 400：`service-entry.cjs` 的 authorize JSON 补 `organization_uuid: org`。经 vm-14 同一 SOCKS5 对照假 sessionKey：缺字段 400 `Invalid request format`，补字段 403 `Invalid authorization`，platform/claude.ai 两域一致；保留原 platform endpoint，不增加重试。`PAYLOAD_SIZE=1107895`、`PRELUDE_SIZE=74383`，UPX 5.0.2 前半 13106436 字节，产物 **14432278** 字节，SHA256 `1029f5d198e41582ed23d12430cae49e10d05a5bc47db49be37b558c033defeb`。真实 ELF + 本地 SOCKS/TLS authorize 回归从 400 红转绿；当时的生产机 同一 ELF 的对应 fixture 1/1 通过。未取得真实有效 sessionKey，不能等同于真实账号换票成功。

坏操作必须退出 1，正文是 `invalid_operation`。不要用 `subprocess.check_output` 去探它。

```sh
printf '%s' '{"operation":"nope"}' | bin/oauth-auth; echo exit:$?
```

### kernel

源码树里没有 UPX 步骤。现网 `bin/kernel` 是普通动态 ELF，未 strip，也不是 UPX。

```sh
cd local-src/kin-kernel
cargo build --release
install -m 755 target/release/kernel ../../bin/kernel
install -m 755 target/release/kernel ../../share/wrap-cli/kernel.bin
```

Rust 1.98。不要把 `target/` 或 `src/` 提交。

### Codex kernel

```sh
cd .local/codex-kernel
cargo test
cargo build --release
install -m 755 target/release/codex-kernel ../../bin/codex-kernel
```

不要把 `.local/` 或 `target/` 提交进父仓库。换 ELF 后重启 Codex 槽的宿主 kernel 进程（Node 子进程），不要 `docker rm`。

2026-10-18 未发布 OpenAI WS/隐私配置：`.local/codex-kernel/` 增加每请求 `options.upstream_transport/user_agent/client_features/analytics/installation_id`。安装元数据与独立 Analytics 均默认关闭；安装 ID 每 hop 用本槽持久随机 UUID 覆盖旧启动指纹，非法值零上游拒绝。Analytics 使用官方 `codex_thread_initialized`，只上报真实 kernel 运行环境，不伪造 CLI 工具活动。HTTP/WS 的下游取消能关闭对应上游连接；显式 HTTP 不探 WS，协议 warmup 不降级 HTTP。

本机 `bin/kin-codex-kernel` SHA256 `05b22ff0604f1f4290d1a3841b5c78ef7bbef0fd56dc1b42343032f88b0f5533`，旧 ELF 备份 `/tmp/kin-codex-kernel-before-openai-20261018`（旧 SHA256 `11c8ec08d2660a3d8beef4a3b55ed795c4b550a77ee6c8ff50d9b4af9c92d895`）。`CARGO_TARGET_DIR=target-terminalfix cargo test`：32 passed；release 构建成功。真实 ELF + 回环 HTTP/WS：默认零安装头/Analytics、per-hop UUID 覆盖旧指纹且 header/body 一致、非法 ID 零上游、UA 热切换、两种传输取消断连、Analytics 鉴权/完整事件/去重与关闭后的新会话零上报均通过。完整真实 gateway→ELF→回环链路验证 2 轮回放、两级开关、HTTP 保留、warmup 拒绝、画像/隐私热更新和安装 UUID 与持久文件一致。未用真实 OpenAI 账号，未发布 payload、未部署或重启现有槽。父仓库仍只交付 payload，不提交私有源码。

### cli-node

`scripts/compile-cli-node.ts` 只编译，不压缩。目标是 `bun-linux-x64-baseline`，入口 `src/entrypoints/cli.tsx`，版本宏目前是 `2.1.284`。

```sh
cd local-src/cli-node
bun run scripts/compile-cli-node.ts dist/cli-node
```

现网 `share/wrap-cli/cli-node` 是已打包 ELF（没有 section header）。编译脚本没有记录 UPX 参数。换字节之前先对现网文件做 `sha256`，不要凭记忆重压后直接覆盖。

2026-10-01 未发布的 #191 修复在 `services/api/claude.ts` 的 `message_delta` 分支：`isKinQuerySource(options.querySource)` 时不生成交互式 `max_output_tokens` 错误，正常转发上游终结帧。重编后用 `/tmp/upx-5.0.2-amd64_linux/upx --best --lzma <新 ELF>` 压缩，再 `install -m 755 <新 ELF> share/wrap-cli/cli-node`。本次产物 27162364 字节，SHA256 `75a1a7b939553a5deeea98075359a87a2d4132535f71e29ef88df291e79ea55d`。真实 kernel + 此 CLI 的流式 / 非流式本地 SSE fixture 均保留 `max_tokens`、内容和 usage；不等于真实 Anthropic 账号或线上验证。

2026-10-02 取消 / 恢复修复，已发布为 1.3.91（`6a32923` / tag `v1.3.91`）并部署 当时的生产机：native cancel 不阻塞共享 reader，匹配 ack 前不复用 slot；早到取消与完整 JSONL 提交有竞态保护；真实错误跨层保留；CLI / 容器分别限次恢复，预算耗尽停调度并通知。native 一 job 一上游执行，不进入交互式 retry / non-streaming fallback；SDK 0.39 SSE 错误从其 decoder cause 恢复原始字段，本地异常与真正断流分开。

- `bin/kernel` 与 `share/wrap-cli/kernel.bin`：SHA256 `7916d51e121b07553fd858f92151912ca9878f6ef25aa776f7fd60d7132704df`。
- `share/wrap-cli/cli-node`：UPX `--best --lzma`，27164016 字节，SHA256 `a32241fb000f9696f846efcc32ab72d07714465edbc16fe914b33f62d65c83cc`。
- `cargo test --release` 108 passed / 1 ignored；CLI classifier / stale-connection 7 passed / 32 assertions；Node 全量 unit 完成且无失败。真实 ELF + 本地 SSE fixture 验证取消关闭上游 / 恢复 slots、真实 400 与 retry-after、断流、CLI kill 后自动 respawn 与后续 pong。2026-10-02 上线后 `POST /v1/messages` haiku 返回 `pong`。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.91-20261001T195651Z`。


1.3.78 没有重编 kernel 和 cli-node。两边 SHA256：

- kernel `3751e35dd7e037b20a0969e1d9bd457ff041817b8b9b20d262d695aa3abefdc7`（12539904）
- cli-node `3202378ad990d0ba098d813e7a2a4b488ba9d0930fa96b5ddbbd16cc144d709a`（28575504）

2026-10-03 auto 权限分类适配的**离线阶段**：Node 识别分类用途并经内部 request_context 传 kernel/native CLI；分类 system/cache、disabled 和原预算保留。已知必须 adaptive 的 XML 加2048且幂等，旧强制工具冲突明确拒绝并保留原模型。kernel JSON 保留上游 id/stop_sequence，错误保留 upstream_code/request-id/retry-after；CLI 握手声明 classifier_request_context。后续用户授权的热更新见下方记录。

| 当前本机产物 | 字节 | SHA256 |
|---|---:|---|
| share/wrap-cli/cli-node | 27164424 | c711a9660d59fd1833e207a34782331f3b65d5d7a0f644880bb26e77e15d7ff1 |
| bin/kernel、share/wrap-cli/kernel.bin | 各12848504 | fccd1a3564c9d24175aeaff1d12ccf3aca31e64cf45d954804df2ced4c45f610 |

CLI 编译 stubbed 0 missing modules，plain 111151232 字节，使用 UPX 5.0.2 `--best --lzma` 压缩。Rust `cargo test --release` 110 passed/1 ignored，release 构建成功（既有 continuation_ttl_secs warning）；Bun native 6文件36 passed/105 assertions；Node unit 181文件2092 passed/9 skipped/0 failed。暂存plain/compressed分别验证，最终交付ELF分类+max_tokens e2e 11 passed，包含真实旧CLI组合。

CLI 全量 typecheck 改前/最终各7287个错误，去掉行号后按错误multiset比较零新增；**全量类型检查仍未通过**。本机fixture不等于真实模型/账户验证；真实“分类器不可用”未闭环。详细记录在 `.trellis/tasks/10-03-auto-mode-adaptation/research/verification.md`，A06 wire-only、A18 PENDING。

构建前备份 `/tmp/vm2api-automode-original-20261003/{cli-node,kin-kernel}`（临时目录可能被清理）。旧CLI hash `78eba26cfc8997a034fa7461b8769b9d110ebb03b343dc176f5a677a6c15daca`，旧kernel hash `7916d51e121b07553fd858f92151912ca9878f6ef25aa776f7fd60d7132704df`。确认备份hash后，在根目录恢复本机ELF：

```sh
install -m 755 /tmp/vm2api-automode-original-20261003/cli-node share/wrap-cli/cli-node
install -m 755 /tmp/vm2api-automode-original-20261003/kin-kernel bin/kernel
install -m 755 /tmp/vm2api-automode-original-20261003/kin-kernel share/wrap-cli/kernel.bin
```

完整回滚还须只撤回本任务Node变更；不能整体恢复共享脏工作区。单独回退ELF时新Node会明确拒绝分类用途。私有源码/target/dist仍不入库。

2026-10-03 后续用户授权 **当时的生产机 最小包热更新**：只应用本任务10个Node文件和3份ELF，版本保留远端1.3.92；Node重启一次，6个Claude wrap槽位最终健康、classifier_request_context=true、payload hash与上表一致，容器ID不变，Codex槽位未处理。备份 `/opt/kin-gateway/.deploy-bak-auto-mode-20261002T195539Z`，是最小补丁布局，不直接用于完整overlay的remote-rollback.sh；回滚按manifest只恢复本任务文件，再同步6槽位旧payload。

Windows Claude2.1.285、opus-5-5、auto的单次真实-p对话，通过临时SSH隧道连接当时的生产机8787入口（公网预检Cloudflare403）。auto模式可进入，但主会话遭503 pool_unavailable；SDK3次自动重试的网关日志均attempt_count=0，没有工具/分类请求。5个账户额度安全线，vm-05会话并发上限；未放宽这些限制。临时配置/原始日志和隧道已清理，未修改用户持久endpoint；未提交发布。记录在 `.trellis/tasks/10-03-auto-mode-adaptation/research/当时的生产机.md`，A18仍PENDING。

2026-10-03 #220 `<severity>` 分类适配（分支 `fix/auto-mode-severity-classifier`，未提交）：kernel `provider/mod.rs` 与 cli-node `kin/classifierRequest.ts` 的 xml 一致性校验去掉 system 含 `<block>` 的要求，只看无 `tool_choice` + messages 含 `<transcript>`。改前本机 ELF 即上表 c711a96… / fccd1a3…；新 Node + 旧 ELF 的 severity 分类实测 400 `invalid_request_context`。

| 当前本机产物 | 字节 | SHA256 |
|---|---:|---|
| share/wrap-cli/cli-node（UPX 5.0.2 `--best --lzma`，plain 111151232 / `9f0d8645a30184480f2b1afc095787c917d857e9e97705036cf4634db887afee`） | 27164296 | 72714299db914432158d7832a3c4fb9aef2e481d444b8a3ff49b8c0f603101dd |
| bin/kernel、share/wrap-cli/kernel.bin | 各12848544 | f9347e29f616ad98e162c2f382745233a7881745e2031965d675a4ffa14fcf6c |

`cargo test --release` 110 passed/1 ignored；Bun `classifierRequest.test.ts` 2 passed；交付 ELF 下 `auto-mode.e2e` + `cli-hop-max-tokens.e2e` 10 passed/1 skipped（旧 CLI 组合需 `KIN_AUTOMODE_OLD_CLI`，暂存产物阶段已跑通 4/4）。本地 fixture，未经真实 Anthropic / 真实 2.1.283 客户端验证。

2026-10-04 单一换票者（未提交）：cli-node `utils/auth.ts` 在 `CLAUDE_CODE_KIN_HOST_REFRESH=1` 时，临期 / 401 强制刷新只重读磁盘凭证，不请求 token 端点、不写回；kernel `multiplex_cli/supervisor.rs` 给拉起的 CLI 固定设置该变量，面板运维终端 rc 同样导出。在上表 #220 产物源码之上构建，未改其它逻辑。

| 当前本机产物 | 字节 | SHA256 |
|---|---:|---|
| share/wrap-cli/cli-node（UPX 5.0.2 `--best --lzma`，plain 111151232 / `d5d80de5bb506e17f1eb509966e3c0daa109ead0d3160d61041295c29ce4904c`） | 27164352 | 7b23385e502b5158f4d73cb8444b4aca0a171076d255a34a4d8379c28ef494ce |
| bin/kernel、share/wrap-cli/kernel.bin | 各12848256 | 6ec05f35429e6fac69d3e940070c939d2f67e2b6b741b5bb862a784194d9486a |

`cargo test --release` 110 passed/1 ignored；交付 ELF 下 `credential-rotation.e2e` + `auto-mode.e2e` + `cli-hop-max-tokens.e2e` 12 passed/1 skipped（需 `env -u CI`，否则 CLI 走 CI 仅环境变量鉴权）。本地 mock token 端点：同一 plain CLI 不设变量时与 kin-worker 并发重复使用 rt-0；设变量后只有 kin-worker 换票，`kinGeneration`/email 保留。kernel 拉起的 CLI 进程 environ 实测含该变量。未经真实 Anthropic 验证。

2026-10-05 服务端 auto mode 审查透传（未发布）：只在主请求带 `safeguards` 时，cli-node 把该字段放进上游 Messages，并只给这一次追加 `afk-mode-2026-01-31`。默认 beta 列表不变。kernel 生产代码未改，`MessageRequest.extra` 本来就会留下该字段，所以没有重编 `bin/kernel` / `share/wrap-cli/kernel.bin`（仍是 `6ec05f35…`）。Node 单测 `server-safeguards.test.mjs` 3 passed；Bun `officialBetas.test.ts` 5 passed；`cargo test --release safeguards_survive` 1 passed。未经真实 Anthropic 账号验证。

| 当前本机产物 | 字节 | SHA256 |
|---|---:|---|
| share/wrap-cli/cli-node（UPX 5.0.1 `--best --lzma`，本机没有 5.0.2；plain 111159424 / `b8ec0e1515c155864ca92d5fc3dfb25b9e0d812b3fb08838ea69a2bcd1856e46`） | 27165568 | d4f6c0c286c5a30c8432a84d06b2f26991a5eb1a7d3d2628599ff860748722a5 |


## GitHub Release

仓库 `dofastted/vm2api`。tag 必须等于 `v` + `VERSION` 文件，workflow `.github/workflows/release.yml` 会核对。

1. 改 `VERSION`、`CHANGELOG.md`，以及这次要发的已入库代码和 ELF。
2. 源码目录不进暂存区。`git add` 之后再看 `git status -sb`，确认没有 `local-src/`、`AGENTS.md`、`src/lib/oauth/auth.js`、`crates/`、`patches/`。
3. 提交。`git.exe tag vX.Y.Z`，推 main 和 tag。
4. `gh release create`。推 tag 会跑 workflow：核对版本，编 `kin-worker` / `kin-egress`，把仓内 ELF 拷到 release asset，并推 ghcr 镜像。
5. asset：`kin-kernel`、`kin-kernel-crag`、`kin-codex-kernel`、`kin-worker`、`kin-egress`、`kin-oauth-auth`、`cli-node`、`cc-node`。
6. 补发说明用 `gh release edit`，不要为了改正文重新打 tag。同一 tag 换二进制用 `--clobber`。

`gh` 走 `ALL_PROXY=socks5h://127.0.0.1:10808`，先去掉别的 HTTP(S)/ALL_PROXY。Git 用 Windows `git.exe`。

## 部署

主力服务器只有 Netcup。SSH 别名 `netcup`，地址和公网入口只写在 `skills/version-switch/host.env`（`VM2API_SSH_HOST`、`VM2API_PUBLIC_URL`）。不要再连接、部署或启动其他旧生产机。不要把别名、地址或厂商写进技能正文、提交、PR 或公开文档。Release 发布之后把版本、备份路径、是否 sync 和验证结果补进本文件。

只走本机 `skills/version-switch` 和 `~/.codex/skills/ssh-skill`。`skills/` 不入库。先加载配置再 SSH：

```sh
set -a
. skills/version-switch/host.env
set +a
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py "$VM2API_SSH_HOST" "<cmd>"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" "<local>" "<remote>"
```

树在 `/opt/kin-gateway`。不要改成 `/opt/vm2api`。

```sh
sh skills/version-switch/scripts/pack-overlay.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" /tmp/vm2api-overlay-<VERSION>.tgz /tmp/vm2api-overlay-<VERSION>.tgz
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" skills/version-switch/scripts/remote-apply.sh /tmp/vm2api-remote-apply.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py "$VM2API_SSH_HOST" --timeout 240 "sh /tmp/vm2api-remote-apply.sh <VERSION>"
```

`remote-apply.sh` 会重启 `kin-gateway` 一次。不要再重启。不要动 `kin-gateway-go`。不要 `docker rm` `kin-*`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

`wrap-cli/sync` 只在 `bin/kernel` 或 `share/wrap-cli/cli-node` 的字节和线上不一致时做。版本号相同不算一致，要比 SHA256。

回滚前先在目标机列出 `/opt/kin-gateway/.deploy-bak-vm2api-*`。上传 `skills/version-switch/scripts/remote-rollback.sh` 到 `/tmp/vm2api-remote-rollback.sh`，再 `sh /tmp/vm2api-remote-rollback.sh [BAK]`。回滚会再重启一次 Node。

2026-10-07 1.3.112 Release：合入 PR #261（codex-kernel 结束帧按顶层 type 判断，merge `4df2cb3`）和侧栏版本号不截断（`fcaef37`，含 `web/dist`）。版本提交 / tag `v1.3.112` = `dd0ee27`，Release workflow `37568520284` 四个 job 全成功，10 附件（8 amd64 + 2 arm64）；release asset `kin-codex-kernel` 与仓内一致 `98715a2f…`。正文已用 `gh release edit` 补上 CHANGELOG 1.3.112 段。

2026-10-07 1.3.112 部署 Netcup：线上原来是 1.3.111。部署前核对 5 个 `bin/kin-*`、`share/wrap-cli`（cli-node / cc-node / kin-kernel / kin-kernel.bin）、`share/crag/kin-kernel`、distill-rules 以及 `src/lib` + `server.mjs`（243 个文件）与 tag 全部一致，实际差异只有 `web/dist` 和 VERSION；没做 wrap-cli/sync。overlay `8e823c6c…`（105457077 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.112-20261007T035456Z`。Node 重启一次，前门 `vm2api-go` 未动（启动时间仍是 10-06 22:20 UTC）；Node 重启后自行拉起新的 `kin-codex-kernel` 子进程，`web/dist/dl` 符号链接保留。verify-live 全 PASS（version/panel 1.3.112、11 VM、9/9 容器 Up 且 ID 不变、haiku 200 pong）；公网首页引用新的 `index-Cr1JHFex.js`。

2026-10-07 codex-kernel 热修（VERSION 仍是 1.3.111）：GPT 长输出时客户端收到空回复，日志记 `codex_upstream`、status 200、tokens 0。原因是 `is_terminal_frame` 拿子串匹配整帧，`*.done` 帧的正文里只要出现 `response.completed` 就会被当成结束帧，内核提前断开 ws。改成只看顶层 `type`（completed/incomplete/failed/error）或顶层 `status_code` 429，和 codex-proxy-rs 一致。源码在 `.local/codex-kernel-terminalfix` 分支 `fix/terminal-frame-by-type`（`9aed5e2`），基于干净 HEAD `c92b176`；`.local/codex-kernel` 主工作区还有没提交的改名 WIP（鉴权头改成 `x-internal-token`），不能从那里构建。上线的是 strip 后的 `98715a2f…`，旧版 `4fd6189f…` 备份为 `/opt/vm2api/bin/kin-codex-kernel.bak-terminalfix-20261007T033146Z`。先停掉两个 codex-kernel 进程，再把 Node 重启一次（Node 的 `starts` 表留着旧子进程句柄，只杀进程不重启 Node 的话 vm-01 会一直 503），前门没动。验证：网关 `/v1/responses` 把触发句完整跑到 `response.completed` 并记为 verified，verify-live 有 7 项 PASS（haiku 200 pong），容器 ID 前后对比没变（9 个）。

2026-10-07 1.3.111：线上原来是 1.3.109。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.111-20261006T220328Z`。PR #260 调度设置已在 main `9561892`。kernel、cli-node、cc-node、codex-kernel、worker、egress、oauth-auth 哈希与线上一致，没做 wrap-cli/sync。Node 重启一次，前门未动。verify-live 全 PASS（10 VM、9/9 容器 ID 不变、haiku 200 pong）。目录仍是 `/opt/kin-gateway`，因为槽位挂载和前门二进制绑在这里；应用本身是 vm2api。

2026-10-03 1.3.96：线上原来是 1.3.94。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.96-20261003T064641Z`，里面另存了 `VERSION-before`（1.3.94）。kernel、cli-node、cc-node、codex-kernel 的 hash 和线上一致，所以没做 wrap-cli/sync。`kin-worker` 换成 1.3.95 的 `f310d647…`，`kin-oauth-auth` 换成 `f24e99fe…`。

2026-10-03 1.3.97：线上原来是 1.3.96。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.97-20261003T132037Z`。PR #221 合入后打 tag；kernel `f9347e29…`、cli-node `72714299…` 与 1.3.96 不同，wrap-cli/sync `restart:true` 6/6。worker / oauth-auth 哈希未变，未 docker restart 槽。6 个 Claude wrap 槽 `/internal/health` healthy 且 `classifier_request_context=true`。8 容器 ID 不变。haiku pong 503 `pool_unavailable`（Claude 槽全在额度安全线），未放宽限制、未宣称分类已在真实账号验证。

2026-10-03 1.3.98：线上原来是 1.3.97。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.98-20261003T144921Z`。PR #222 合入后打 tag。`kin-codex-kernel` `4fd6189f…`（线上原 `cb882a08…`）。kernel `f9347e29…`、cli-node `72714299…` 与 1.3.97 相同，**没做 wrap-cli/sync**。apply 后无残留 `kin-codex-kernel` 进程。8 容器 ID 不变。`/health` `service=vm2api`。haiku pong 503 `overloaded_error`（号池当前没有可用账号），与 1.3.97 同类，未放宽限制。

2026-10-03 1.3.99：线上原来是 1.3.98。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.99-20261003T151641Z`。PR #223 合入后打 tag。kernel / cli-node / codex-kernel 哈希与 1.3.98 相同（`f9347e29…` / `72714299…` / `4fd6189f…`），**没做 wrap-cli/sync**。8 容器 ID 不变。`/health` `service=vm2api`。`GET /api/panel/vms` 上 `vm-codex-01`（lemeryvorhees）`total_cost=139.87`，用量行 email 已补上；`vm-01` 仍有费用。


**worker 重载不要用 `POST /api/panel/vms/fleet-update {"action":"reload"}`**。`reloadSlotWorker` 发现宿主机上没有 `run/worker.sock`（wrap/kernel 槽都没有）时，会走 `startVmRuntime(recreate:true)`，这等于 docker rm 再重建：这次 7 个槽（vm-01、03、05、10、13 和两个 `*-3hicloudcom`/`*-3gicloudcom`）容器 ID 全变了。挂载、`unless-stopped`、egress 网络、`--user` 都由 vm.json 重建，没有异常，pong 正常。要保住容器 ID，直接对每个槽 `docker restart kin-<id>`。kin-worker 是单文件 bind mount，`mv` 换文件后不重启，容器里看到的还是旧 inode。

`remote-apply.sh` 不处理 `package*.json` / `node_modules`。新增依赖时（如 1.3.90 的 `https-proxy-agent`）要在 apply 之前先装好，否则重启后 Node 起不来：把新 `package*.json` 传到 `/opt/kin-gateway/.npm-stage-<VERSION>/`，在里面 `npm ci --omit=dev`，再把旧 `node_modules` 和 `package*.json` 挪进 `.deps-bak-vm2api-<旧版本>-<UTC>/`、换上新的，然后跑 `remote-apply.sh`（只重启这一次）。1.3.90 的依赖备份是 `/opt/kin-gateway/.deps-bak-vm2api-1.3.89-20261001T124303Z`；回滚代码不必还原依赖（新依赖是超集）。

上线后核对：`/health` 的 `service` 是 `vm2api`；首页有 `<title>vm2api</title>` 和 `id="root"`；面板登录后 `GET /api/panel/vms`；`POST /v1/messages` 用 `claude-haiku-4-5`、`max_tokens` 32，正文 `Reply with the single word pong.`；`kin-*` 容器 ID 不变且仍是 Up。密钥从 systemd `Environment=` 读，不要打印。

2026-10-04 1.3.101：用户授权 #224/#226/#227 修复上线，随后授权提交 PR、合并 main 并发布。PR #228 已合并，main/tag 为 `9b3657b65df61bfa52bb801c61646c94fa781d8e`。第一次修复工作区按 1.3.100 上线，备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.100-20261003T174419Z`，`VERSION-before=1.3.99`；因 v1.3.100 已发布，新增修复正式切到 1.3.101，备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.101-20261003T175133Z`，`VERSION-before=1.3.100`。两次版本切换各重启一次 Node；Go 入口未动，kernel/CLI/worker 与原线上一致，未做 wrap-cli/sync 或重启槽容器。

1.3.101 完整 `verify-live.py` gate 退出 0；额度窗口结束后真实 haiku 对话返回 200 `pong`，未放宽额度/冷却规则。385 个部署文件 SHA256 一致，8/8 容器 ID/StartedAt 和 CLI PID/start ticks 不变，13 个出口身份探测通过。PR/main CI 和 Release 工作流成功；[v1.3.101](https://github.com/dofastted/vm2api/releases/tag/v1.3.101) 已正式发布，含 8 个 linux amd64 附件及 GHCR 镜像。详细证据：`.trellis/tasks/10-04-issue-226-227-review/deployment.md`。

2026-10-04 vm-14 换票热修复：仅更新 `src/lib/cluster/remote-fs.mjs`（SHA256 `c459e1d3d4146c8dcb6ecfb258cdd38930e33b55fc32df14c405b9bbbfd6b08f`，字符串转 Buffer）和上面的 `bin/oauth-auth`，VERSION 保留 1.3.101。备份 `/opt/kin-gateway/.deploy-bak-vm14-oauth-20261003T185925Z`，保留这两份原文件、VERSION-before 和容器对照。Node 重启一次，Go 未动；原有 9 个 kin 容器 ID/StartedAt 全不变，未 wrap-cli/sync。vm-14 原无容器，修前 start 500 `buffer is not a Buffer`；修后 start 200，扩展节点新增 kin-14 和 kin-14-egress，kernel `/internal/health` 200、healthy=true、ready_slots=20、credential_state=missing。没有复制 vm-15 票据或写入测试票据。

本次目标单测 33 passed / 7 skipped / 0 failed，Biome 4 文件通过，源文件和 bundle `node --check` 通过。全量 `npm run test:unit` 在 240 秒超时，末尾 `vm-db-sync.test.mjs` cancelled（pending promise），**未完成全量验证**。真实授权码 / Cookie 不保存于失败请求中，需面板新授权才能完成真实换票验证；不要复用重启前的授权 session。

热修复后真实 `/v1/messages` haiku 回 200 `pong`（input/output 各 5 tokens），证明原号池入口正常；不等于尚无票据的 vm-14 已完成真实推理。

用户随后授权提交、PR 与合入 main：修复提交 `bef44329a756a15ba4efd53c8e6493b4dc3f2227`，PR [#229](https://github.com/dofastted/vm2api/pull/229) 已合并，main 为 `c32ed9088d9da329c36eb14967076eeee816a436`。PR CI [37147073729](https://github.com/dofastted/vm2api/actions/runs/37147073729) 与 main CI [37147442726](https://github.com/dofastted/vm2api/actions/runs/37147442726) 的 unit/worker/kernel/web 全部通过；本地全量超时记录仍保留，不等于 CI 失败。现有 main 工作树 `.local/release-1.3.94` 在确认干净后快进同步，根工作树保留本次修复分支。未打 tag、发布版本或再次重启线上；真实账号换票仍待面板有效输入复测。

2026-10-04 1.3.102 正式发布并部署：版本提交 `50b53c5ef688b016da6a09c3912219682df9a7f4`，发布 PR [#230](https://github.com/dofastted/vm2api/pull/230) 已合并，main/tag `v1.3.102` 为 `a3b267c99d3fc9b356ade2bb0e3c858f891db19e`。PR CI `37148471048`、main CI `37148736850`、Release workflow `37148952001` 全部成功；[Release](https://github.com/dofastted/vm2api/releases/tag/v1.3.102) 非 draft / 非 prerelease，8 个 linux amd64 附件及 GHCR `v1.3.102`/`latest` 已发布。下载的 OAuth 附件与仓内 ELF 字节一致，SHA256 `1029f5d198e41582ed23d12430cae49e10d05a5bc47db49be37b558c033defeb`。web 构建首轮 180 秒截止超时，延长单次截止后正常完成，13176 modules；重建产物与已入库 web/dist 一致，无新增前端改动。

当时的生产机 备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.102-20261003T195111Z`，包含完整 overlay 前文件、VERSION-before、容器 ID/StartedAt 前后、前门进程状态及受保护配置哈希。部署包 SHA256 `f029132097098c3565ae2d53b81bca38c9f1a975be5740df40f31c91329cb1a3`（105041144 字节）；线上 385 个对应文件哈希一致。Node 重启一次，Go 前门 PID/启动时间不变；本机 9 个与扩展节点 2 个槽/出口容器合计 11 个 ID/StartedAt 均不变，未 wrap-cli/sync 或重启槽。routing/.env 哈希不变，dl 链接保留；未覆盖 vms/data。

按 当时的生产机 overlay 约定保留与线上一致的仓内 Go 产物：worker `f310d6470bb8e01488ff347ee9b0149ee599a0087cc50b8e2871517a0aa42f61`、egress `3e720a1a36193f1753e801b2e4addefd56624a1e098b71e9c5fefcc91110298f`；本次无 Go 代码改动。Release workflow 重新编译的 Go 附件哈希分别为 `b37f9478e2f116222ee959130fcbca62408738d1e0fdc07b80c04468367df16d`、`eb75ca36856249545c2e4c278265177c490b11d920ee096670fb85bdb4f0e632`，未用它们替换当前槽内 Go 挂载。

完整 verify-live gate 退出 0：VERSION 与面板 1.3.102、Node health 200 vm2api、10 个 VM、首页正常、9/9 本机容器 Up/ID 保留、真实 haiku 200 pong。真实 Chromium 控制台版本文字与 Release 链接为 v1.3.102；截图与实际 DOM 已验证。部署后 vm-14 kernel health 200、healthy=true、ready_slots=20、cli_restarts=0、credential_state=missing；真实账号换票仍须面板有效输入复测，不把健康/fixture 当作已拿票。

2026-10-04 1.3.103 发布并部署：单一换票者（cli-node `CLAUDE_CODE_KIN_HOST_REFRESH`）+ 初装/`setup-token` 改用槽内 cli-node。feat/macos 上的改动在 origin/main 独立工作树 `.local/release-1.3.103`（分支 `fix/single-refresher-cli-node`）手工移植（main 无 guest-account，路径用 `CONTAINER_CLI_NODE_BIN`）。PR [#233](https://github.com/dofastted/vm2api/pull/233) 未等 CI 直接合并，main/tag `v1.3.103` = `e3402ed14cf50dfcde15bba01e84aad8c022a997`；事后 PR/main CI 与 Release workflow `37189975713` 均成功，8 个附件齐。kernel `6ec05f35…`、cli-node `7b23385e…`。

当时的生产机：`scripts/` 不在 overlay 内，先把 `official-cc-resident.py`、`claude-setup-token-pty.py` 备份到 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.103-scripts-20261004T084854Z/` 再替换，`repair-official-cc-bins.mjs` 移入同一目录；随后 remote-apply，备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.103-20261004T084854Z`，Node 重启一次，Go 未动。wrap-cli/sync `restart:true` 返回 7/7 `kernel_restart_failed`（重启后立刻探 `kernel.sock` 尚未出现），实际 7 槽容器 docker restart 后 ID 不变，`/internal/health` 全 healthy、ready_slots=20，内核拉起的 CLI environ 含 `CLAUDE_CODE_KIN_HOST_REFRESH=1`。verify-live 全 PASS（9/9 容器 ID 不变、真实 haiku 200 pong）。vm-01 不在 sync 列表，仍是旧 cli-node `c711a966…`，未处理；扩展节点 vm-14 镜像内二进制未更新。初装 hello 的 cli-node 真实账号路径未验证。

2026-10-04 1.3.104：1.3.103 回归——`cli-node-guard` 只留 PID 最小的 `-p` cli-node，其余 `-p` 一律 SIGKILL，导致初装 hello/`/usage`、`setup-token` 和面板终端 `claude -p` 被杀（用户截图 `Killed`）。改为按 environ 识别（内核 `CLAUDE_CODE_KIN_NATIVE_SLOTS`，豁免 `KIN_OFFICIAL_CC=1`/`KIN_SETUP_TOKEN=1`/活跃 `KIN_PANEL_SHELL`，environ 不可读不动）。PR [#234](https://github.com/dofastted/vm2api/pull/234) 未等 CI 合并，main/tag `v1.3.104` = `021018a78a629f212cce1780969a48545c907ebe`。当时的生产机：`claude-setup-token-pty.py` 先备份到 `.deploy-bak-vm2api-1.3.104-scripts-20261004T091407Z/`，overlay 备份 `.deploy-bak-vm2api-1.3.104-20261004T091407Z`，Node 重启一次，kernel/CLI 未变、未 wrap-cli/sync。kin-13 内带标记的 `-p hello` 与 `setup-token` 假进程存活 35s（>2 个守护周期），内核 CLI pid 13 不变；verify-live 全 PASS（9/9 容器 ID 不变、haiku 200 pong）。

2026-10-05 1.3.105：#239 日志/统计、#235 代理名称（迁移改 028）、#241 首条 user reminder 开头会话碰撞（#236，替代 #237）、#242 API Key 在 HTTP 下复制。发版 PR [#244](https://github.com/dofastted/vm2api/pull/244)，main/tag `v1.3.105` = `9df0d40527fddd18b50fbd673cc8ae56f76884e3`，Release workflow `37222259215` 成功、8 附件齐。打包必须在 tag 的干净工作树里做（`pack-overlay.sh` 取脚本所在仓库根，根工作区在 feat/macos 有未提交改动）：把 `skills/当时的生产机-version-switch` 拷进 tag 工作树再跑；git 里 `share/wrap-cli/cc-node` 是 644，打包前要在该工作树 `chmod 755`（remote-apply 也会 chmod）。包 SHA256 `d46a297f…`（105343844 字节）。kernel `6ec05f35…`、cli-node `7b23385e…`、cc-node、codex-kernel、worker `f310d647…`、egress、oauth-auth、crag、`package*.json` 与线上一致，**没做 wrap-cli/sync、没装依赖**。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.105-20261004T182145Z`，Node 重启一次，Go 前门启动时间不变（2026-09-18）。迁移 027/028 已应用（`usage_logs.session_id`/`reasoning_effort`、`proxies.label`），新请求已写 session_id；`/api/panel/usage-logs*`、`/api/panel/statistics*`、`/api/panel/proxies` 在 8788 与 8787 均 200；`dl` 软链保留。verify-live 全 PASS（9/9 容器 ID 不变、10 VM、haiku 200 pong）。远端 `/tmp` 包和 stage 已删。

2026-10-05 1.3.106：DNS 64/65 开关，PR [#245](https://github.com/dofastted/vm2api/pull/245)；功能提交 `1373309`、版本提交 `eca6f2d`，main/tag `v1.3.106` = `8b4de0dafe55e15068aedaeaa30be9b90b07aed5`。按用户要求先发布 Release 再部署 当时的生产机。PR CI `37229759216`、main CI `37230225560`、Release `37230299005` 全成功，8 个附件齐全。发布工作树 `/mnt/x/vm2api-dns-1.3.106` 从最新主线建立，仅提取 DNS 改动；原 `feat/macos` 工作区保留。`bin/egress` SHA256 `a1cd7e18e5a61323a816d86de9e09926c0bade24e0c33559fd2c02f45b7fd3ad`；kernel、CLI、worker、换票、crag、依赖清单与线上原版本一致，无需 `wrap-cli/sync`。包 SHA256 `092fe1306fc98ae22f69c1ac98fcc632637159dc5c79e4a646189438988f3918`（105416957 字节）。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.106-20261004T200210Z`，额外保存旧 `VERSION` 供回滚；Node 重启一次，Go 前门启动时间不变。verify-live 全 PASS（10 VM、9/9 容器 ID 不变、真实 haiku `200 pong`）；8787/8788 均能读取新参数，线上开关当前为 true；4/4 本机已绑定出口运行新二进制且配置 `dns_empty_types: [64,65]`，实际网桥监听的 UDP/TCP type64/65 共16项验证全部返回 NOERROR 空答案。未重建槽容器；集群出口仍按下次启动/重载读取新配置的约定。独立工作树相关 Node 61项、API1项、前端295项、worker全量race、DNS vet、前端类型/构建/lint/格式检查通过。

2026-10-05 1.3.107：#246 ARM64 发布物（含 #243）+ #247 `/logs` 详情弹窗 / 出站 Session（含 #240）。#247 远端分支已由他人合过 main@#240 并重建 `web/dist`，与本地合入 #246 后的非 web 源码零差异（本地全量 unit 2132 pass / 0 fail），直接合并。发版 PR [#249](https://github.com/dofastted/vm2api/pull/249)，main/tag `v1.3.107` = `8cddc24744d71c23ed15c2e80f468911e0418702`，PR CI `37255093238`（含 arm64）、Release `37255393482` 全成功；10 附件（8 个 amd64 + `kin-worker-linux-arm64` / `kin-egress-linux-arm64`），GHCR `v1.3.107` 为 amd64+arm64 多架构清单。workflow 自带的 Release 正文只有架构说明，已用 `gh release edit` 把 CHANGELOG 1.3.107 段放在前面。kernel、CLI、cc-node、codex-kernel、worker、egress、oauth-auth、`package*.json` 与线上 1.3.106 SHA256 一致，**没做 wrap-cli/sync、没装依赖**。包 SHA256 `7ba083736a53717b156cdc51272d85021d67d58dac8df7df119534fbcff2525f`（105423214 字节）。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.107-20261005T023241Z`，Node 重启一次，Go 前门启动时间不变（2026-09-18）。verify-live 全 PASS（10 VM、9/9 容器 ID 不变、haiku `200 pong`）。迁移 029 已应用，重启后新行 `outbound_session_id` 与客户端 `session_id` 不同；`/api/panel/usage-logs`、`active-sessions`、`overview`、`statistics` 在 8788/8787 均 200，返回 `sessionId`（出站）+ `clientSessionId`。线上 `logs-WLr2AAP8.js` 与 `index.html` 与 tag 构建字节一致（公网首页差异仅 Cloudflare 注入的隐藏链接）。发布工作树 `/mnt/x/vm2api-logs-247` 已删。

2026-10-05 1.3.108：搜索历史修复跳不再被已用尽的 120 秒总重试期限丢掉，并带上已在 main 的 #250（出站请求体只在运维 Debug 模式保存）。PR [#251](https://github.com/dofastted/vm2api/pull/251)，main/tag `v1.3.108` = `dac0e18`（merge），功能提交 `aec4501`、版本提交 `73b3a90`。PR CI `37288488221`、Release `37289562650` 全成功；10 附件（8 amd64 + 2 arm64）。workflow 正文只有架构说明，已用 `gh release edit` 把 CHANGELOG 1.3.108 段放在前面。kernel `6ec05f35…`、cli-node `7b23385e…`、cc-node、codex-kernel `4fd6189f…`、worker `f310d647…`、egress `a1cd7e18…`、oauth-auth `1029f5d1…`、crag `5764a186…` 与线上 1.3.107 一致，**没做 wrap-cli/sync、没装依赖**。包 SHA256 `26b00ddf1a27b4f29dbc2a7ad2a25f2007e256d883ec153659199e71b241f4ff`（105418411 字节）。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.108-20261005T093128Z`。apply 重启 Node 一次（09:31:43 UTC）后，开机 5 秒的定时备份在主线程 `VACUUM INTO` 2.3GB `kin.db` 再 `tar`，面板不响应；09:44:48 UTC 又重启了一次 Node（杀掉进行中的 tar，残留 501MB 坏包已删）。第二次备份跑完后 `/health` 恢复。Go 前门启动时间仍是 2026-09-18。verify-live 全 PASS（10 VM、9/9 容器 ID 不变、haiku `200 pong`）。远端 `/tmp` 包已删。磁盘约 93%。

## 本机一键脚本

`deploy/install.sh` 按 GitHub Release 装到 `/opt/vm2api`，不是 Netcup 的 `/opt/kin-gateway`。控制台用仓内预编译 `web/dist`，镜像和一键脚本都不在目标机跑 `pnpm build`。

```sh
sudo bash deploy/install.sh status
sudo bash deploy/install.sh check
sudo bash deploy/install.sh upgrade
```

`upgrade` 会 `git checkout -f` 到 tag。工作区里还没入库的 ELF 会被盖掉。验未提交二进制不要跑 upgrade。

本机源码烟测用 compose，并且关掉自动 wrap 同步：

```sh
KIN_AUTO_SYNC_WRAP=0 docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker exec vm2api node --input-type=module -e 'const r = await fetch("http://127.0.0.1:8787/health"); const body = await r.json(); if (!r.ok || body.service !== "vm2api") throw new Error(JSON.stringify(body)); console.log(JSON.stringify(body));'
```

容器名是 `vm2api`。Docker 用 host 网络时，WSL 里 `curl 127.0.0.1:8787` 打不到，要在容器里探。

2026-10-03 PR阶段：用户反馈自测暂时正常并授权PR包含压缩二进制，A18更新USER_REPORTED，未取得其分类trace；此前自动-p号池受阻结果保留。PR使用origin/main独立工作树，CLI/kernel hash沿用上表；公开E2E改用最小客户端XML解析语义fixture，去掉忽略的docs/auto-mode源码依赖。

2026-10-03发布完成：[v1.3.94](https://github.com/dofastted/vm2api/releases/tag/v1.3.94)，包含PR208原生重置、PR209auto适配及PR210版本/web重编；main 5e6df3f541e8aa3cc3db3e48d7a55f0cadaeb78e。两项PR的登录页格式CI已修复，最终main CI/Release工作流全绿。当时的生产机完整gate退出0，6运行Claude槽worker更新、配套kernel/CLI hash和能力一致，8容器ID不变，真实对话pong、重置只读查询200。详情research/release-1.3.94.md；真实分类trace限制和A18 USER_REPORTED保留。

2026-10-06 1.3.109 热修复（VERSION 不变）：PR [#256](https://github.com/dofastted/vm2api/pull/256)（`4a9a4a4`，merge `b983cde`）运行中本地槽判活改看 `run/kernel.sock`，reload/start 不再 `docker rm -f`；遥测 sidecar 在 restart/start 后补起 + 看门狗每 10 分钟自愈。首次部署（备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.109-20261006T031449Z`）后发现看门狗 `isKernelWatchdogTarget` 对线上全部 10 个 VM 为 false（`inference_engine` 为空、无 `runtime.engine`），自愈没跑；PR [#257](https://github.com/dofastted/vm2api/pull/257)（`3cbac95`，merge `cfb00c9`）改为对所有非 kvm、非停机槽检查。二次部署备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.109-20261006T035422Z`，包 SHA256 前缀 `c53dfc6d`。两次各重启 Node 一次，Go 前门 PID 3083711 未动；kernel/cli-node/cc-node/codex-kernel/worker/egress/oauth-auth 与线上一致，没做 wrap-cli/sync。两次 verify-live 全 PASS（9/9 容器 ID 不变、haiku 200 pong；第二次首跑因 Node 未就绪失败，20 秒后重跑通过）。部署后 5 个遥测开启且缺 sidecar 的槽被看门狗补起，所有开启遥测的槽各 1 个 sidecar；vm-15、codex-01 遥测关闭。**未处理**：看门狗 L4 容器重启同样对线上所有槽不生效（目标过滤），开启会改变生产重启行为，待决定；VM 详情页遥测探针 2.5s 超时在线上恒为「未知」（docker exec 3–5s）。

2026-10-12 [v1.3.148](https://github.com/dofastted/vm2api/releases/tag/v1.3.148) 发版并部署 Netcup：线上原来是 1.3.147（另有 01:08Z 手动热修的 `kin-oauth-auth` 未压缩版 `dccca54f…` 与 `cli-node` `c1316b7d…`，备份 `/opt/vm2api/.deploy-bak-vm2api-bins-20261012T010912Z`）。内容：main 上 #374/#373/#371/#367/#366/#364，加本地 cherry-pick 的换票止于 bootstrap、显式 fallback beta、硬正则跳过工具回传，示例 `routing.json` 写明 `codex.catalog_client_version: "auto"`。payload 新发 `payload-2026.10.12`（预发布，非 latest），只换 `kin-oauth-auth`（同一次 07:44 构建按本文切点 46205192 / 垫片 13250000 压前半，UPX 5.0.1，`PAYLOAD_SIZE=1105991`、`PRELUDE_SIZE=74383`，前半 13105828 字节，产物 **14430374** 字节，SHA256 `fe64b4ea20ca694863f9041fd02fd2c0c4e6d30cce99e273ee693d7d730a8095`）和 `cli-node`（`c1316b7d…`，2.1.293 请求组装对齐）。PR [#377](https://github.com/dofastted/vm2api/pull/377)，先部署未合并分支再合并，merge `50c32123`，tag `v1.3.148`（版本提交 `5398f58e`，合并后树与验证树一致）。Release workflow `38206443886` 四 job 成功，10 附件，正文已放 CHANGELOG 1.3.148 段；附件 oauth-auth / cli-node 与 pin 一致。overlay SHA256 `1df66874c1919412…`（105682417 字节），kin-worker / kin-egress 用线上原文件（`7269deb3…` / `bf242027…`）。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.148-20261012T050300Z`。与备份相比只有 `bin/kin-oauth-auth` 变（未压缩 → 压缩），kernel / cli-node / cc-node / codex-kernel 字节相同，**没做 wrap-cli/sync**，没重载槽（cli-node `c1316b7d…` 仍只在宿主 `share/wrap-cli`，槽内是否已同步未核对）。Node 重启一次，前门未动（daemon-reload 提示同 1.3.131，未执行）。`verify-live.py 1.3.148` 退出 0：版本/面板 1.3.148、health 200、虚拟机 11、9/9 容器 Up 且 ID 不变、haiku 200 pong。全量 unit 209 文件 2439 pass / 0 fail；压缩版 oauth-auth 的二进制测试 28 pass。#366 的 kin-kvm 修复在 runner 镜像里，guest-images workflow 已在 `7c7072d0` 上重建，现有 KVM 槽未重建。

2026-10-12 #383 消息级 effort 修复（本地工作区，未合并、未发正式应用版本、未部署）：Node 在官方支持模型保留空 system effort 控制与原位置，kernel `Message` serde round-trip 消息扩展字段，现有 CLI 无需重编。Rust release suite 112 passed / 1 ignored，release 构建成功；Node 完整 unit suite 通过，定向 effort 18/18；Bun requestBody 7/7；实际 Node → 新 kernel ELF → 现有 CLI → 本地 SSE fixture 及相关 native e2e 11 passed / 1 skipped（旧 CLI fixture 未提供）。新 kernel **12823808** 字节，SHA256 `d27bdaba1171ed6100ac3b4f00902807ae7b3d0d31a1ea1ff55e5d667e6370ea`，已安装本机 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`。发布 [payload-2026.10.12-effort](https://github.com/dofastted/vm2api/releases/tag/payload-2026.10.12-effort)（prerelease、非 latest）；只更新 manifest 的两处 kernel 引用，其余 9 路径使用既有已发布 asset/hash，不把本机 unrelated payload 改动带入包。隔离组装的 11 路径 manifest check 通过、10 assets 上传完成且 GitHub digest 对上。将来部署需 Node + kernel 并做 `wrap-cli/sync`；本次没有 sync、远端连接或服务重启。没有真实 Anthropic 账户/cache-hit 复验。

2026-10-12 [v1.3.151](https://github.com/dofastted/vm2api/releases/tag/v1.3.151) 正式发布（未部署）：#383 消息级 effort 修复经 PR [#387](https://github.com/dofastted/vm2api/pull/387) 五项 CI 全绿后合并，main/tag `v1.3.151` = `8b599112ee029389d349ed397df41bad237f409c`。Release workflow [38241819936](https://github.com/dofastted/vm2api/actions/runs/38241819936) 四个 job 成功，10 附件（8 amd64 + 2 arm64），双架构镜像与 manifest 发布完成，正文已补修复和升级说明，GitHub latest 为 v1.3.151。六个固定二进制的 size/digest 与 `deploy/payload.json` 一致；正式附件 `kin-kernel` 下载后的 SHA256 为 `d27bdaba1171ed6100ac3b4f00902807ae7b3d0d31a1ea1ff55e5d667e6370ea`，用该 ELF 跑实际 Node → kernel → CLI → 本地 SSE fixture effort 回归通过。#383 已关闭为 completed；#376 HA 未实现，不关闭为已修复。没有部署或远端服务重启，无部署备份，未执行 `wrap-cli/sync`；现有实例需更新 Node/kernel 并 sync 才应用修复。仍未验证真实上游 cache-hit。

2026-10-12 原 PR [#384](https://github.com/dofastted/vm2api/pull/384) / [#363](https://github.com/dofastted/vm2api/pull/363) 接管修复后合并（未另发版、未部署）：保留作者提交，在原 fork head 追加修复及 main merge，没有 force push/rebase。#384 修复 `3358645e`，merge `606a5bc82b6090d45af7e41e3bd9ed721c5f5938`：严格读取仅缺文件返回 null，坏 JSON/其他 I/O 抛错；既有 best-effort 调用者自行捕获；固定 1024 项 LRU，删除/home wipe/备份恢复清理记录和凭证缓存。#363 修复 `10c8ba40`，最终组合 head `26448cb6582c16e259b7b948d10c75e8a6d43d5d`，merge `4ac0c519af6ca3b4e3dd6e6233ffc12db70eb76c`：混合提供商按行 prompt 分母、账号窗口再汇总；空完成无 TTFT、元数据不计时、生成工具名（包括无参数 delta）计首输出，日志入口时间优先于 hop 时间。

验收：最终组合 head 定向 85 passed / 0 failed；实际文件系统缓存与 Unix HTTP SSE 烟测通过。#384 [CI 38246348143](https://github.com/dofastted/vm2api/actions/runs/38246348143) 与 #363 最终 head [CI 38247590341](https://github.com/dofastted/vm2api/actions/runs/38247590341) 的 unit/kernel/worker/web/arm64 均通过。早期 CI payload 下载 HTTP 504 只重跑失败 job；本地全量首次缺 payload/egress 的 3 个旧失败文件在隔离工作树补齐前置后各 41 passed / 6 skipped / 0 failed，不冒称首次本地全量绿。API transport 和数据库页 PromptCacheMetricsPanel 未修改；#376 HA/shutdown 未动。本机 main 已快进到上述 #363 merge，并行 #385 的 CHANGELOG 和源码、私有仓既有改动保留。本轮未改 VERSION、未打应用 tag、未发布 Release、未部署或执行 wrap-cli/sync；v1.3.151 不包含这两个新合并 PR。

## 2026-10-17 kernel 消息块往返与缓存连续性

- 线上请求日志中，出站 session `196b3fa8-52a6-4763-870d-c06989215de4` 连续三轮都在同 VM / 同账号 / 同 caller session、单次 attempt、HTTP 200，缓存 TTL 均为 1h。cache read 为 `0 → 212762 → 34080`，第三轮 `cache_prefix.break={section: messages,index:278,kind:structure}`。诊断只覆盖 Node object；`wire_observed=false`，未保存完整提示词，不能据此把精确差异归给 Anthropic TLS wire。
- `kin-kernel/src/model.rs` 原先用 `.filter_map(...ok())` 静默丢弃不认识的 block，且已知 type 的新增字段会被 serde 忽略。现保留单一 typed enum，用严格字段解析加 `Raw(Value)` 分支保存未知类型和含扩展的已知类型；删除重复 enum、序列化整块 clone 和空 Text 兜底。扩展 tool_result 仍参与 continuation ID 与大小限制。
- 这项 kernel 缺陷不等于已证明的事故根因：第三轮差异在 kernel 之前的 Node object 已出现。200000 字符 preview 不含 index 278 的完整历史，无法确定其具体改动；未观察事故最终 CLI/TLS wire。此前 114 passed / 1 ignored 只覆盖第一版补丁，后续补齐扩展字段测试后重新验收。
- 最终源码提交 `31d95c3`（仅本任务 model/api hunks；原有环境变量、header 改名等未提交改动保留）。只格式化这两个 Rust 文件，UTF-8 无 BOM / LF；`cargo test` 116 passed / 1 ignored。debug 和 release ELF 均通过真实 kernel → 现有 CLI → 本地 HTTP 三轮捕获：未知块、已知类型扩展、工具结果、消息前缀和 session 完整保留。fixture 不验证上游对新增字段的接受能力。
- `cargo build --release` 基于当前本地源码树（包含原有未提交改动），未压缩产物 SHA256 `39996c1e39399cdae63aac188b1fcaa7814f3d51ca905d5f6911e95b6dd5de56`；本机 `bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin` 已安装。原产物 `56527336…`，本机备份 `/tmp/vm2api-kernel-before-9f8sxdon`。未提交产物、未 push、未改 payload manifest、未发布 Release；线上 VERSION 保持 1.3.184。
- 按本次用户授权替换 9 个 Anthropic 槽。备份 `/opt/vm2api/.deploy-bak-kernel-preserve-20261017-31d95c3`（原 kernel 两份、VERSION、槽记录、容器快照及验收数据）。宿主机 7 槽逐个停调度并排空后 sync/restart，容器 ID 全保留，均 healthy / ready_slots=20，进程实际映射新 kernel、无 deleted 旧映射。`vm-05` 保持 paused / oauth_revoked；未修改额度限制。
- 用户单独批准集群镜像升级及容器重建后，节点构建 `vm2api/kin-slot-ubuntu-24.04:301276cbfcfc`，`jp-pro` 和 `aws-vm` 经现有 reload API 更新。二者新 kernel 同 SHA256、启动验收 healthy / ready_slots=20；`jp-pro` 保持运行，`aws-vm` 原先不运行，验收后停止且保留 paused / oauth_revoked。节点旧容器定义备份 `/home/ubuntu/.vm2api/.kernel-preserve-backup-31d95c3`，旧镜像保留。
- Node / Go 前门未重启；两个 Codex 槽的容器 ID 与 StartedAt 不变。全部 9 槽原 `status`、`schedulable`、`schedule_manual` 已核对恢复。
- 真实上游 smoke：`vm-03` 三轮 200 pong，cache read `0 / 12880 / 12893`，creation `12880 / 13 / 13`；`jp-pro` 三轮 200 pong，read `0 / 12876 / 12889`，creation `12876 / 13 / 13`。SQLite 中两组各三条共享同一组内 outbound session。仅证明这两组新会话的缓存复用，不证明原事故 index 278 已定位或解决。

## 2026-10-18 获准后九槽补丁部署完成

- 后续已明确授权重建 `aws-vm`、`jp-pro`、`jp-pro2`；本条取代上一节“仍需授权 / 未切换”的当前状态。源码 revision `9dd8fe20` 已部署，VERSION 仍为 `1.3.187`；未 push / tag / Release。
- 新鲜备份 `/opt/vm2api/.deploy-bak-cc296-authorized-20261017T193611Z-9dd8fe20`（0700），旧备份和旧镜像保留。Node 单次切换 PID `136935 → 1723282`，Go PID `996741` 不变；6 本地槽定向同步成功、ID 不变；集群镜像 `vm2api/kin-slot-ubuntu-24.04:d4c829ff783a`，仅获准的 3 个容器重建。
- 9/9 槽实际 kernel `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977`、CLI `244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7`；9/9 配置 2.1.296。8 运行槽 healthy / 20 ready，实际 CLI 环境 2.1.296 / native 20 / sdk-cli / host refresh 1，父进程映射新内核。AWS 保持未启动、paused / oauth_revoked；JP-pro2 调度仍关闭。
- 7 个原可调度槽共 14 次真实 200 pong：默认 1h、显式 5m、Environment off 的 caller 原文保留均通过 Node 出站记录核验。恢复后自动调度再 1 次 200 pong；原有效配置与全部 11 VM 调度/手动字段恢复。GPT 的 ID / StartedAt、8 个非目标母本二进制和其他容器 ID 不变，未覆盖凭据、身份、代理或卷。
- 本次配置恢复产生过一次可定位的缓存重建：19:54:40 UTC 恢复 `official_full`，随后同一 Opus 链的 Environment 从短时区块变为完整续文块，read 降至 14611、creation 100099；下一条 read 恢复至 114710（恰为两者之和）。账号 / VM / session / TTL 未变，不是换号或缓存随机失效；后续验证不应在真实流量下切换全局 persona。
- 新前端 308 项 manifest 校验；实际公网浏览器页面可用，5 个入口资源 200 且哈希等于新包。私有完整过程、断言归一化差异、旧 gate 不适用项和验证边界见 `CHANGELOG.md` 本条记录及备份内 JSON。未抓取最终 TLS wire；缓存计数为日志观测，部署探针响应层 cache_read=0 不等于上游缓存失效。不重置已有管理员凭据，也不伪称旧完整 gate 通过。

## 2026-10-18 搜索历史重复 400 的 Node-only 热修复

- 已按后续明确授权先上线 `8594008d` 的两份 Node 修复；VERSION 保持 `1.3.187`。备份 `/opt/vm2api/.deploy-bak-search-repair-20261018T010742Z-8594008d`（0700）；Node 单次切换 `1723282 → 3790730`，Go `996741` 不变。没有槽位 sync/restart/recreate、二进制或生产设置修改。
- 真实隔离会话三轮 200 pong，同一出站 session，attempt `[400,200] → [200] → [200]`；全部容器 ID/状态/StartedAt、VM 调度/手动字段、routing 与二进制哈希保持基线。证据为备份内 `apply-result.json` / `live-search-repair-verification.json`，详细请求 ID 与模块哈希见 `CHANGELOG.md` 最新条目。
- PR [#517](https://github.com/dofastted/vm2api/pull/517)，候选 `1.3.188`，隔离分支 `fix/search-history-repair-188`；未合并或发布。旧管理员登录门禁无法由 master 验收冒充，替代门禁未获明确授权，按保守默认暂停；旧脚本只看宿主机 Docker，AWS 原停止状态另行核对保留。发布前需对齐新 native payload 资产/manifest 并验证完整 1.3.188 树，不能把当前 1.3.187 热修复报告成完整发版。
- 候选前端 TypeScript/Vite 构建通过；11 个 native 资产已本地准备并校验，目录 `/tmp/vm2api-payload-cc296-foiyqzyw`，仅 kernel/CLI 两项更新、其余 9 项不变。资产尚未发布，manifest 未伪造为已可下载。
- PR CI `39085806102`：unit / worker / kernel / web / arm64 全成功；live 登录门禁仍独立阻塞，未合并或创建应用 Release。

## 2026-10-18 v1.3.188 正式发布与完整上线

- 本轮用户明确批准 master 鉴权 + 原状态保留作为本次 live 门禁；实际命令 `verify-live.py 1.3.188 --before /tmp/kin-before-1.3.187-search-repair.txt --auth-mode master --container-policy baseline` 最终退出 0。默认密码模式保留，旧密码登录不声称通过，管理员凭据未改。
- PR [#517](https://github.com/dofastted/vm2api/pull/517) 已合并，合并提交 / tag `v1.3.188` = `0629424e63cdcf26301b155f609defc7ba63d878`；最终候选 `f7e224e3` 已普通 merge 保留并发合入的 Desktop #518，组合回归 152/152，CI `39088593405` 五项全成功。
- Release [v1.3.188](https://github.com/dofastted/vm2api/releases/tag/v1.3.188) 正式公开且 latest；发布工作流 `39089080369` 四 job 全成功。11 份正式附件实际回下载并核对 SHA256/大小/ELF 架构通过（9 amd64、2 arm64）；native 资产快照 `payload-2026.10.18-cc296` 已公开并与 manifest 对齐，两个新 hash 为 kernel `98357559…`、CLI `244ef884…`，其他资产不变。
- OCI `ghcr.io/dofastted/vm2api:v1.3.188` 的 index digest `sha256:b36b42e75e0e5a5c4a9098fc56acdebf99b010f60dbd50243945d6965c4242a3`，含 amd64/arm64；直接 Registry 核验 latest 相同、两个单架构 tag 的 digest 与 index 描述符相符。
- 第一次完整候选备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.188-20261018T014826Z`；纳入并行 main 后最终备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.188-20261018T020306Z`。310 运行文件和 286 前端文件逐项校验。每次候选切换 Node 各 stop/start 一次，最终 PID `4178362`；Go `996741` 始终不变，全部容器 ID/状态/StartedAt、调度/手动字段、routing 和二进制哈希保留，没有槽 sync/restart/recreate。
- 最终真实同会话三回合 200 pong，attempt `2 → 1 → 1`，8 个运行内核 healthy、配置 20 native slots。ready_slots 是空闲数，不能在真实流量中要求永远全空闲；错误的附加断言已修正，没有为跑绿重启健康槽。AWS 继续停止，JP-pro2 继续调度关闭，GPT 容器不变；没有全局 persona/TTL 验证翻转。
- 实际公网浏览器登录界面正常，5 个入口资源 200 且等于候选 hash。最终备份内包含 source / live gate / real probe / final-state / public asset / OCI 证据；详细请求 ID、全部 SHA 和 CI 分析见 `CHANGELOG.md` 最新条目。未抓最终 TLS wire。
- 原 `/mnt/x/vm2api` main 未强制重置，保留本地既有提交与私有源码修改；当前发布源树在 `/mnt/x/vm2api-wt-search-repair-188`。本条取代上一节“PR 待门禁 / 未发布”的当前状态，但保留其历史记录。

## 2026-10-18 v1.3.190 OpenAI WS / Codex kernel 发布与 HostDzire 部署

- PR [#533](https://github.com/dofastted/vm2api/pull/533) 已合并，merge commit `362c8a4b`；tag `v1.3.190` 已发布。Release workflow `39100256285` 四个 job 全成功，amd64/arm64 镜像和 11 个正式附件完成。应用候选工作树为 `/mnt/x/vm2api-wt-openai-ws-190`，未改原开发工作树用户未提交内容。
- 新 payload Release `payload-2026.10.18-openai-ws-190` 已公开、非 latest/prerelease。唯一变化的槽位资产是 `kin-codex-kernel`：7892048 字节，SHA256 `0ffec538a57afbe66f13832513ee4c2a27ecc970faa9367c7cb8a13551196dd3`，Ubuntu 22.04 构建，最高 GLIBC `2.34`，适配线上 GLIBC 2.35；其余 payload 与 `payload-2026.10.18-cc296` 一致。`deploy/payload.json` 已更新到新 payload tag。
- HostDzire 从 1.3.188 切到 1.3.190。候选包 `/tmp/vm2api-overlay-1.3.190-candidate.tgz`，SHA256 `fde74dfb238a9605906e7db2578ffa56b8edcc2b2a87b664fe37e1e774f00eec`；备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.190-20261018T051029Z`。先等运行中请求连续 3 次零 inflight，停止旧 Node / Codex 子进程，应用 overlay，Node 单次重启；Go 前门 PID 保持不变。8/8 容器身份与原状态保持，未 `docker rm`，未执行 Anthropic `wrap-cli/sync`，未覆盖 `routing.json`、`vms/`、`data/` 或 `.env`。
- `verify-live.py 1.3.190 --auth-mode master --container-policy baseline` 全部通过：version、health、panel master、11 VM、web、8/8 容器 ID/状态、Claude `pong`。新 Codex kernel 已实际启动，线上 `/proc` SHA256 为 `0ffec538…`。live GPT 账号在本次探测时被上游额度闸 `quota_exhausted` 阻止真实 completion；因此不伪称 GPT 模型回答通过，但 kernel health/ELF/hash、鉴权前置、HTTP/WS 路由已部署，回环 HTTP/WS 与 public WS 错误帧验证在发布前通过。
- nginx 已加窄范围 `location ~ ^/(v1/)?responses$`，直连 Node 8788 并保留 Upgrade；原配置备份 `/opt/vm2api/.deploy-bak-openai-ws-190-20261018T050343Z/nginx/kin.fkcodex.com`，`nginx -t` 和 reload 通过。公网 WS 已能完成握手并返回真实 quota error，而不是 Upgrade 失败。Analytics 与安装元数据默认关闭；本次未启用远程隐私上报。

## 2026-10-18 出站 Session 漂移根因与取消修复（未部署）

- 用户给出的 `a46d14f8-0f8a-47ed-b039-3aac66689441` / `e58b99b9-4545-4032-bceb-f25765c4b19b` 实为 request_id；同一入站 `01a14f60-fce8-73a7-b13b-281f691eecef`、VM `loutish-arches-3gicloudcom`、账号 `b5db293d-6881-4fbf-b9e0-9d9cd94eaf6a`。两条成功记录均仅执行一次，出站从 `041b50d0-35a7-4197-a2e3-74b3c1458d3b` 变为 `e899ee62-14e2-4b65-98c9-fa02fdd62ce0`，缓存 read 从 48062 降至 39012，creation 从 226 增至 9271。
- 两次成功之间的 `request_attempts.id=43402` / request `d67a5d77-c9d6-468e-86c3-7966b05f5a1a` 于 14:23:26.718–14:23:35.703 UTC 返回 499 / cancelled / downstream_committed=1；该请求在 usage_logs 与 request_log_debug 中均无行。Node `FailoverRunner` 的两个取消分支调用 `retireOutboundSession`，以 replaceSession + clearSlot 清空绑定，导致下轮同 VM 重建。第一代仅成功 11 次，第二代截至 14:48:05 已成功 56 次；本例不是 50 次硬阈值或 600 秒 idle 超时。
- 最小修复仅移除 returned-cancel / thrown-abort 两处 session 退役；空响应重试、换 VM、凭据失效、kernel cancel_ack 栅栏与请求 lease 释放保持。真实 SQLite 回归两项修前都在第 51 次取消后 session=null，修后跨 53 次通过；五文件相关回归 255/255，Biome 两文件通过，生产代码 LSP 无诊断。
- 用公开不可变 payload `payload-2026.10.18-cch-sticky` 的 kernel `97959c16…` / CLI `369889d8…`（下载后完整 SHA256 与生产已记录值一致）跑实际 HTTP gateway → protocol handler → FailoverRunner → SQLite → kernel ELF → CLI ELF → loopback HTTP。106 次真实 wire 请求，104 次 200 pong，第 51 / 101 次在上游收到请求后断开客户端，两次均观察到上游连接关闭并恢复 ready_slots。106 次 header 与 metadata、SQLite 及成功日志保持同一出站 `9867105e-0926-4847-99aa-a2f80eb95474`；CLI PID 3146 不变、重启 0、closed_slots=0。
- 本次生产仅只读取证，无部署、服务重启、slot sync/restart/recreate 或配置修改；Node 修复、回归与公开 CHANGELOG 已提交 `b6498403`，未 push、未发布。烟测为本地回环，不等于真实 Anthropic 缓存命中证明。临时脚本与隔离状态已清理；协议契约留在被忽略的 `.trellis/`，本私有记录只单独提交本节，不纳入用户其他既有改动。
