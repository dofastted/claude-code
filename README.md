# 本地二进制与部署

只留在本机。不要在父仓库 `git add local-src/`，不要打进 release，不要放进 Netcup overlay 以外的源码包。

`AGENTS.md` 只指向本文件。

## 产物根目录

仓库根 `/mnt/x/vm2api`（Windows `X:\vm2api`）。

| 产物 | 路径 | 是否入库 |
|---|---|---|
| 换票 | `bin/kin-oauth-auth` | 是，只提交 ELF |
| Rust kernel | `bin/kin-kernel` | 是，只提交 ELF |
| 槽内 kernel 副本 | `share/wrap-cli/kin-kernel.bin` | 是 |
| crag kernel | `share/crag/kernel` | 是。单独源码树不在下面三处 |
| cli-node | `share/wrap-cli/cli-node` | 是，只提交 ELF |
| cc-node | `share/wrap-cli/cc-node` | 是 |
| Codex kernel | `bin/kin-codex-kernel` | 是。源码在 `.local/codex-kernel/`（父仓库忽略） |
| Go worker / egress | `bin/kin-worker`、`bin/kin-egress` | 是。源码在已入库的 `worker/`，release workflow 现编 |

`bin/*` 默认忽略，上面这几个 ELF 由 `.gitignore` 的 `!` 放行。

## 源码目录

都在 `local-src/`，整目录被父仓库 `.gitignore` 的 `/local-src/` 忽略。这里有独立的本地 Git 仓库，当前初始分支为 `cleanup/local-src`；未配置远程、未创建提交。仅在本目录管理源码，不在父仓库暂存本目录。依赖、`target/`、`dist/`、临时文件和凭证由本目录 `.gitignore` 忽略，换行统一为 LF。

| 二进制 | 源码 | 说明 |
|---|---|---|
| `bin/kin-oauth-auth` | `local-src/oauth-auth/` | 编译输入是 `service-entry.cjs`。`service-entry.mjs` 是入口草稿。`src/lib/oauth/auth.js` 仍单独忽略，当前工作区没有这份文件 |
| `bin/kin-kernel` | `local-src/kin-kernel/` | Rust 2024 / 1.98。`cargo build --release` 的缓存位于本树 `target/`；旧 `crates/kin-kernel/target` 已于 2026-10-03 清理 |
| `share/wrap-cli/cli-node` | `local-src/cli-node/` | 唯一工作树，源码基线版本 2.1.296；源码版本不代表槽内交付版本。`X:\project\kin-kernel-20slot\claude-code` 是旧来源，不要改那份 |
| `bin/kin-codex-kernel` | `.local/codex-kernel/` | 从 `X:\kin\kin-gateway\codex-kernel` 迁入，独立本地 git。父仓库 `.gitignore` 的 `.local/` 忽略整树。`cargo test` / `cargo build --release` 缓存在该树 `target/`。协议对齐 `X:\workspace\codex-proxy-rs`（`fast`→`priority`、`x-codex-routing-hint`、envelope 头）；SOCKS5/`socks5h` 保留 |
| `bin/kin-computer` | `local-src/kin-computer/` | 闭源造机服务。算法仍在 `D:\vm-os`；`sh local-src/kin-computer/build.sh` 在 Debian 12 容器内编译，输出 `local-src/kin-computer/dist/kin-computer`，安装到 `bin/kin-computer` 后走 payload Release。父仓库不提交源码或产物字节，只提交 manifest |

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

`npx pkg service-entry.cjs --targets node18-linux-x64`，输出 `bin/kin-oauth-auth`（plain；再按下面步骤压缩）。

整文件 UPX 会坏：pkg 按绝对 `PAYLOAD_POSITION` 读尾部，压缩后偏移对不上，运行是 `Pkg: Error reading from file.`

可用的压法：

1. 留下未压缩 ELF。当前 plain 备份如果还在，是 `/tmp/oauth-auth.plain`。
2. 在 section table 结束处切开（等于 `PAYLOAD_POSITION`）。node18 底包不变时切点是 **46205192**。
3. 把 ELF 里 22 字符的 `PAYLOAD_POSITION` / `PRELUDE_POSITION` 改到固定垫片 **13250000**，以及 `13250000 + PAYLOAD_SIZE`。`PAYLOAD_SIZE` / `PRELUDE_SIZE` 每次构建都会差几个字节（pkg 产物不可复现），以本次 plain 为准。
4. 给切出的前半 `chmod 755`，仅压前半：`upx --best --lzma`。
5. NUL 垫到 13250000，再接上原来的尾部。

1.3.78 结果 **14432142** 字节，SHA256 `0c25576b00ac05809f7977a9a1caa7d07fe023b4e3b950e02b0d98ecbe267e5f`。

2026-10-01 #198：`service-entry.cjs` 里打包的 `parseSocksURL` 去掉 IPv6 方括号（socks-proxy-agent 10.1.0 把 `[::1]` 当主机名解析）。本次 `PAYLOAD_SIZE=1107783`、`PRELUDE_SIZE=74383`，结果 **14432166** 字节，SHA256 `123b2e33f4eaa3a6749fd939c756d8bc60bc93e16e0f55fa703756f7c49eb6bd`。`::1` SOCKS5 回环可完成握手，IPv4 对照不变。

2026-10-03 本地出口换票：`normalizeSocks("")` 返回空串（直连），`execute` 改 `input.proxy_url ?? null`，`null` 仍报 `proxy_required`；`service-entry.mjs` 草稿同步。本次 `PAYLOAD_SIZE=1107807`、`PRELUDE_SIZE=74383`，UPX 前半 13105756 字节，结果 **14432190** 字节，SHA256 `ddb668f5ce2e9695d500f442f7c6e15c736bdea34abc518224f1c640b650751c`。`proxy_url:""` 直连到上游（假 code 回 400），`null` 回 `proxy_required`，`[::1]` 死 SOCKS 回 `ECONNREFUSED ::1:1`，坏操作仍退出 1。

2026-10-03 sessionKey 换票 `CLAUDE_WEB is not defined`：`service-entry.cjs` 内联的 oauth-contract 段缺 `var CLAUDE_WEB = "https://claude.ai";`（自 a5ef473 起所有已提交二进制都坏），`resolveOrganizationUuid` 在发请求前抛 ReferenceError。已补回。改 bundle 后先跑 Biome `correctness/noUndeclaredVariables`（独立 biome.json，`files.maxSize` 调大），只允许 `arguments` 误报。本次 `PAYLOAD_SIZE=1107879`、`PRELUDE_SIZE=74383`，UPX 前半 13105068 字节，结果 **14432262** 字节，SHA256 `f24e99feb393b77e32a73a1f0aab5330fdb3b1d5975acec97756245d5b65895c`。死 SOCKS 回 `get_organizations_transport`，`proxy_url:""` 直连到 `claude.ai/api/organizations`（假 sessionKey 回 403 `account_session_invalid`），`null` 回 `proxy_required`，坏操作仍退出 1。回归测试：`test/unit/session-oauth-seam.test.mjs` 的 `binary dials the claude.ai organizations hop`。

拆分提交：main `1bc508d` 只带 `CLAUDE_WEB` 修复。构建时临时去掉 bundle 里 px-local 的 `if (proxyUrl === "") return "";`，在 `/tmp` 下用 pkg 构建。`PAYLOAD_SIZE=1107860`、`PRELUDE_SIZE=74374`，UPX 前半 13104916 字节，结果 **14432234** 字节，SHA256 `2167d3b1964c7d1f29075941563b7febd343109d01cfe105020291d4a3a93aa8`。这个构建里 `""` 仍回 `proxy_required`。PR #216（`fix/px-local-oauth-direct`）用的是上面 **14432262** 那份（px-local + `CLAUDE_WEB`）。当前 `service-entry.cjs` 两处改动都在。

2026-10-04 Cookie authorize 400：`service-entry.cjs` 的 authorize JSON 补 `organization_uuid: org`。经 vm-14 同一 SOCKS5 对照假 sessionKey：缺字段 400 `Invalid request format`，补字段 403 `Invalid authorization`，platform/claude.ai 两域一致；保留原 platform endpoint，不增加重试。`PAYLOAD_SIZE=1107895`、`PRELUDE_SIZE=74383`，UPX 5.0.2 前半 13106436 字节，产物 **14432278** 字节，SHA256 `1029f5d198e41582ed23d12430cae49e10d05a5bc47db49be37b558c033defeb`。真实 ELF + 本地 SOCKS/TLS authorize 回归从 400 红转绿；当时的生产机 同一 ELF 的对应 fixture 1/1 通过。未取得真实有效 sessionKey，不能等同于真实账号换票成功。

坏操作必须退出 1，正文是 `invalid_operation`。不要用 `subprocess.check_output` 去探它。

```sh
printf '%s' '{"operation":"nope"}' | bin/kin-oauth-auth; echo exit:$?
```

### kernel

源码树里没有 UPX 步骤。现网 `bin/kin-kernel` 是普通动态 ELF，未 strip，也不是 UPX。

```sh
cd local-src/kin-kernel
cargo build --release
install -m 755 target/release/kernel ../../bin/kin-kernel
install -m 755 target/release/kernel ../../share/wrap-cli/kin-kernel.bin
```

Rust 1.98。不要把 `target/` 或 `src/` 提交。

### Codex kernel

```sh
cd .local/codex-kernel
cargo test
cargo build --release
install -m 755 target/release/codex-kernel ../../bin/kin-codex-kernel
```

不要把 `.local/` 或 `target/` 提交进父仓库。换 ELF 后重启 Codex 槽的宿主 kernel 进程（Node 子进程），不要 `docker rm`。

2026-10-18 未发布 OpenAI WS/隐私配置：`.local/codex-kernel/` 增加每请求 `options.upstream_transport/user_agent/client_features/analytics/installation_id`。安装元数据与独立 Analytics 均默认关闭；安装 ID 每 hop 用本槽持久随机 UUID 覆盖旧启动指纹，非法值零上游拒绝。Analytics 使用官方 `codex_thread_initialized`，只上报真实 kernel 运行环境，不伪造 CLI 工具活动。HTTP/WS 的下游取消能关闭对应上游连接；显式 HTTP 不探 WS，协议 warmup 不降级 HTTP。

本机 `bin/kin-codex-kernel` SHA256 `05b22ff0604f1f4290d1a3841b5c78ef7bbef0fd56dc1b42343032f88b0f5533`，旧 ELF 备份 `/tmp/kin-codex-kernel-before-openai-20261018`（旧 SHA256 `11c8ec08d2660a3d8beef4a3b55ed795c4b550a77ee6c8ff50d9b4af9c92d895`）。`CARGO_TARGET_DIR=target-terminalfix cargo test`：32 passed；release 构建成功。真实 ELF + 回环 HTTP/WS：默认零安装头/Analytics、per-hop UUID 覆盖旧指纹且 header/body 一致、非法 ID 零上游、UA 热切换、两种传输取消断连、Analytics 鉴权/完整事件/去重与关闭后的新会话零上报均通过。完整真实 gateway→ELF→回环链路验证 2 轮回放、两级开关、HTTP 保留、warmup 拒绝、画像/隐私热更新和安装 UUID 与持久文件一致。未用真实 OpenAI 账号，未发布 payload、未部署或重启现有槽。父仓库仍只交付 payload，不提交私有源码。

### cli-node

`scripts/compile-cli-node.ts` 只编译，不压缩。目标是 `bun-linux-x64-baseline`，入口 `src/entrypoints/cli.tsx`，版本宏目前是 `2.1.296`。本地未发布改动、构建哈希和链路验证见 [`CHANGELOG.md`](CHANGELOG.md)；不要据源码版本推断运行中槽位版本。

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

1. 改 `VERSION`、`CHANGELOG.md` 和这次要发的源码。2026-10-11 起 git 只有源码，历史已用 filter-repo 清掉 `bin/`、`web/dist`、`share/crag`、`share/wrap-cli` 的 ELF/glibc（重写前完整备份 `X:\temp\vm2api-pre-rewrite-20261011.bundle`，`~/vm2api-history/backup.git`）。
2. 源码目录不进暂存区。`git add` 之后再看 `git status -sb`，确认没有 `local-src/`、`AGENTS.md`、`src/lib/oauth/auth.js`、`crates/`、`patches/`。
3. 换了 kernel / cli-node / cc-node / oauth-auth / crag / kin-computer：新文件放到本机对应路径，`node scripts/fetch-payload.mjs --pin payload-YYYY.MM.DD`，`--stage /tmp/payload`，`gh release create payload-YYYY.MM.DD /tmp/payload/* --prerelease --latest=false`，再提交 `deploy/payload.json`。payload Release 不能是 latest。新增附件可补传当前 payload Release，不重算或替换其他本地有改动的产物。
4. 提交。`git.exe tag vX.Y.Z`，推 main 和 tag。
5. 推 tag 会跑 workflow：核对版本，编 `kin-worker` / `kin-egress`，按 `deploy/payload.json` 拉 payload 拷到 release asset，镜像内编 `web/dist` 并推 ghcr。
6. asset：`kin-kernel`、`kin-kernel-crag`、`kin-codex-kernel`、`kin-worker`、`kin-egress`、`kin-oauth-auth`、`kin-computer`、`cli-node`、`cc-node`。
7. 补发说明用 `gh release edit`，不要为了改正文重新打 tag。同一 tag 换二进制用 `--clobber`。

`gh` 走 `ALL_PROXY=socks5h://127.0.0.1:10808`，先去掉别的 HTTP(S)/ALL_PROXY。Git 用 Windows `git.exe`。

## 部署

主力服务器为 Hostdzire，SSH 别名 `hostdzire`；Netcup 已弃用，不再部署或探测。别名和公网入口只写在 `skills/version-switch/host.env`（`VM2API_SSH_HOST`、`VM2API_PUBLIC_URL`）。不要把别名、地址或厂商写进技能正文、提交、PR 或公开文档。Release 发布之后把版本、备份路径、是否 sync 和验证结果补进本文件。

只走本机 `skills/version-switch` 和 `~/.codex/skills/ssh-skill`。`skills/` 不入库。先加载配置再 SSH：

```sh
set -a
. skills/version-switch/host.env
set +a
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py "$VM2API_SSH_HOST" "<cmd>"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" "<local>" "<remote>"
```

应用树为 `/opt/vm2api`，systemd unit 为 `vm2api.service` / `vm2api-go.service`。`/opt/kin-gateway` 仅保留兼容槽位 bind mount 的 symlink；不要替换真实目录或改 unit 工作目录。

tag 工作树里没有产物，`pack-overlay.sh` 之前先在该工作树补齐（脚本缺文件会直接失败）：

```sh
npm run fetch:payload && npm run build:egress && npm run build:worker
pnpm -C web install --frozen-lockfile && pnpm -C web build
sh skills/version-switch/scripts/pack-overlay.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" /tmp/vm2api-overlay-<VERSION>.tgz /tmp/vm2api-overlay-<VERSION>.tgz
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py "$VM2API_SSH_HOST" skills/version-switch/scripts/remote-apply.sh /tmp/vm2api-remote-apply.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py "$VM2API_SSH_HOST" --timeout 240 "sh /tmp/vm2api-remote-apply.sh <VERSION>"
```

`remote-apply.sh` 会重启 `vm2api.service` 一次。不要再重启。不要动 `vm2api-go.service`。不要 `docker rm` `kin-*`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

`wrap-cli/sync` 只在 `bin/kernel` 或 `share/wrap-cli/cli-node` 的字节和线上不一致时做。版本号相同不算一致，要比 SHA256。

回滚前先在 Hostdzire 列出 `/opt/vm2api/.deploy-bak-vm2api-*`。上传 `skills/version-switch/scripts/remote-rollback.sh` 到 `/tmp/vm2api-remote-rollback.sh`，再 `sh /tmp/vm2api-remote-rollback.sh [BAK]`。回滚会再重启一次 Node。

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

2026-10-07 [v1.3.113](https://github.com/dofastted/vm2api/releases/tag/v1.3.113)：PR [#263](https://github.com/dofastted/vm2api/pull/263)，merge `4548ab7`。Usage Policy API Error 改为 503 `refusal_guard` 并永久写入拒答缓存，不换号、不冷却账号。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.113-20261007T061006Z`，包 SHA256 `2ad11c7f237f26ba46f3406f40132841a143ed302055be311e536cb5652fdf38`。只重启 Node 一次，没做 wrap-cli/sync。kernel `6ec05f35…`、codex-kernel `98715a2f…`、cli-node `7b23385e…` 与备份一致。verify-live：version/health/web/9 容器 ID 不变/haiku 200 pong 通过；panel 登录 401（库里已有同名用户，不回落单元环境变量密码），vms 计数因此为 0。`de038c46-a1d5-4710-b912-ef47d4100236` 的完整正文已写入拒答库且 `expires_at` 为空；`43a7b8b6-09ad-434d-8962-4b0164293c5c` 调试正文被截断，未入库。

2026-10-07 [v1.3.114](https://github.com/dofastted/vm2api/releases/tag/v1.3.114)：PR [#264](https://github.com/dofastted/vm2api/pull/264)，merge `9ee33ec`。用户正文 MinHash 近似拒答（默认 0.90，面板 80/85/90/95）并永久封禁入站 device id。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.114-20261007T070844Z`，包 SHA256 `19e9e7b8449b73ecc167aa22f80723b6589419fe49a0b4bb9b11780e67ef2122`。只重启 Node 一次，没做 wrap-cli/sync。启动迁移 `030_refusal_near.sql`。verify-live：version/health/web/9 容器 ID 不变/haiku 200 pong 通过；panel 登录 401（库里已有同名管理员，不回落单元环境变量密码），与 1.3.113 相同。随后 PR [#265](https://github.com/dofastted/vm2api/pull/265)（merge `e9522da`）只修 CI 里被换行打断的源码顺序断言，不升版本、不再部署。

2026-10-07 [v1.3.115](https://github.com/dofastted/vm2api/releases/tag/v1.3.115)：PR [#266](https://github.com/dofastted/vm2api/pull/266)，merge `a4530c5`。某一档常驻约束开关打开后，即使保存的模板丢掉 `{{agent_standing}}`，也会把这段文字写进该档 agent 块。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.115-20261007T074947Z`，包 SHA256 `7e4b2279d892b28cca2337b0f19b40614a5968ff6c41465e860cb085fc07bf38`。只重启 Node 一次，没做 wrap-cli/sync，无迁移。verify-live：version/health/web/9 容器 ID 不变/haiku 200 pong 通过；panel 登录 401 与 1.3.114 相同。

2026-10-07 [v1.3.118](https://github.com/dofastted/vm2api/releases/tag/v1.3.118)：PR [#276](https://github.com/dofastted/vm2api/pull/276)，merge `a8fbc27`。官方初装 `/usage` 对齐 cli-node 2.1.284，print 模式回写全部用量窗口；启动环境改为 `CLAUDE_CODE_HOST_REFRESH`。`/dist/` 与 `share/wrap-cli/dist/` 入库忽略。cli-node sha256 `2a4c89c5a3dfae85c87cd12e8e007d3e3f67f8d9a8655396034612a161d2ec52`。Release workflow `37617841364`。本次只发 GitHub Release，没有上机，没有 wrap-cli/sync。

2026-10-07 [v1.3.119](https://github.com/dofastted/vm2api/releases/tag/v1.3.119)：PR [#278](https://github.com/dofastted/vm2api/pull/278)，merge `2dad7a2`。1.3.118 的 cli-node 不认现网内核的 `CLAUDE_CODE_KIN_NATIVE_SLOTS`，`--print` 空 stdin 退出。这次两套环境名都认。cli-node sha256 `5d0f966c7b33cd81655b85f22082ba8e7f97a75fcb190316511aa78275401c31`。只换 cli-node，不要换 kernel。本次只发 Release，没有上机。

2026-10-07 控制台预览，没有升版本：PR [#280](https://github.com/dofastted/vm2api/pull/280)，merge `687efe2`。只覆盖 `web/dist` 和 `src/lib/http/web-dist.mjs`，备份 `/opt/vm2api/.deploy-bak-vm2api-ui-20261007T141636Z`。线上 VERSION 仍是 1.3.117，没有整包 overlay。只重启 Node 一次。cli-node `7b23385e…`、kernel `6ec05f35…` 未换，没做 wrap-cli/sync。9 个槽容器 ID 不变，haiku 200 pong。公网首页已是新入口 `index-Da94u3Eb.js`，无 Google Fonts；Node 对带哈希资源返回 `immutable`。panel 登录 401 与 1.3.113 起相同。

2026-10-07 [v1.3.120](https://github.com/dofastted/vm2api/releases/tag/v1.3.120)：PR [#286](https://github.com/dofastted/vm2api/pull/286) 并入 [#283](https://github.com/dofastted/vm2api/pull/283)、[#284](https://github.com/dofastted/vm2api/pull/284)、[#271](https://github.com/dofastted/vm2api/pull/271)，merge `d3f5527`。线协议去掉 `kin_` 前缀，kernel sha256 `c59a129280673aab88a8ac210d61336c350f060a039e8f8185b4b46736647b79`，codex-kernel sha256 `11c8ec08d2660a3d8beef4a3b55ed795c4b550a77ee6c8ff50d9b4af9c92d895`。cli-node 未换。硬正则可编辑，`usage_logs.intercept` 迁移 `031`。Codex `POST /v1/alpha/search`。控制台 dist 随 #283 重命名合入，侧栏重组还在。整包 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.120-20261007T152423Z`。Node 只重启一次。`wrap-cli/sync` 8/8。`vm-01` 与 `vm-codex-01` 不在 sync 名单，已把槽内 `kin-kernel.bin` 换成同一哈希后 `docker restart`，容器 ID 仍是 `0a2a8c68bf33`、`d7afce9eb038`。9/9 容器 ID 不变。haiku 200 pong。`/api/panel/me` 经 master key 是 1.3.120，VM 11 条。verify-live 的 panel 登录 401 仍是库用户不回落单元环境变量密码，与 1.3.113 起相同。

2026-10-08 [v1.3.121](https://github.com/dofastted/vm2api/releases/tag/v1.3.121)：PR [#288](https://github.com/dofastted/vm2api/pull/288)，merge `d7486f2`。`official_full` 的 `role=system` 只留给 Opus/Sonnet 5；初装去掉 `CI=1` 且 hello 空输出算失败；保留 `eager_input_streaming`；已提交的截断流补 `max_tokens`；关键词不再开关 `web_search`。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.121-20261007T160419Z`。Node 只重启一次。kernel `c59a1292…`、codex-kernel `11c8ec08…` 与备份相同，没做 wrap-cli/sync。9/9 容器 ID 不变，haiku 200 pong。`/api/panel/me` 用 master key 读到 1.3.121，虚拟机 11 台。panel 登录 401 与 1.3.113 起相同。随后 PR [#289](https://github.com/dofastted/vm2api/pull/289) 只给无模型的 official_full 用例补上 `claude-sonnet-5`，不升版本、不再部署。

2026-10-08 [v1.3.122](https://github.com/dofastted/vm2api/releases/tag/v1.3.122)：PR [#290](https://github.com/dofastted/vm2api/pull/290)，merge `dd73f72`。确定性蒸馏正则只放在硬前置，跟蒸馏总开关；放行原因按是否真扫过记 regex / unchecked / fail-open；协议页今天展示 Jev 清洗、Jev 拦截和规则详情。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.122-20261007T181248Z`，包 SHA256 `9ba4e9b8080e6b2a8732917770bee20c2a018868b1083237810c1db956f71863`。Node 只重启一次。kernel `c59a1292…`、codex-kernel `11c8ec08…`、cli-node `5d0f966c…`、kin-worker `f310d647…`、kin-egress `a1cd7e18…` 与备份相同，没做 wrap-cli/sync。9/9 容器 ID 不变。`/api/panel/me` 用 master key 读到 1.3.122，虚拟机 11 台。panel 登录 401 与 1.3.113 起相同。haiku 429：全部 Anthropic 槽当时不接客（额度或限流），最近一档约 45 分钟，不是这次改动。Release workflow `37665445117` 成功。

2026-10-08 [v1.3.123](https://github.com/dofastted/vm2api/releases/tag/v1.3.123)：PR [#291](https://github.com/dofastted/vm2api/pull/291)，merge `adf2f60`。Claude Code 对齐 2.1.293，新增 `claude-haiku-5-5`；裸 `haiku` 仍是 Haiku 4.5。上机在打 tag 之前，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.123-20261007T203751Z`。Node 只重启一次。`wrap-cli/sync` 8/8。9/9 容器 ID 不变。`claude-haiku-4-5` 与 `claude-haiku-5-5` 都是 200 pong。panel 登录 401 与 1.3.113 起相同。发版前补了测试钉：Haiku 5 用完整 beta 头，版本断言跟 `2.1.293`。cli-node sha256 `db4f0d6b927c0479e313a15ac7028c65ed8dd8c135636c73ae0281a342358310`，kernel `166b29142a6fbba88ff9cb62c2940ac598dd630d2c1f20281192038cf2448fcb`，kin-worker `8bab97e58c153bf795339f630366466a1bee573f3f326430c4374c23b079e35d`，kin-oauth-auth `6289a6e09c482fa71a6ab20f2b0117ede41909503286f8603b8b8a730cab6d26`。Release workflow `37684409951`。

2026-10-08 [v1.3.124](https://github.com/dofastted/vm2api/releases/tag/v1.3.124)：PR [#295](https://github.com/dofastted/vm2api/pull/295)，merge `1818871`。裸 `<think>` / `</think>` 不再当蒸馏；引用技能列表不再被决策模型打成破限；Jev 拦截不再写入拒答缓存。控制面 overlay，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.124-20261008T042548Z`。Node 只重启一次。kernel `166b2914…`、cli-node `db4f0d6b…` 与线上一致，没做 wrap-cli/sync。9/9 容器 ID 不变。verify-live 全 PASS：panel 1.3.124、虚拟机 11、haiku 200 pong。面板登录用的是库里的明文密码；systemd 里旧的 20 位密码已改成同一套，哈希本身不能拿来登录。Release workflow `37729333103` 四个 job 成功，10 个附件。

## 2026-10-08 本地修复 #293 / #296 / #297（未发布、未部署）

PR #294 只采用缺失参数后缀补发的方向，不原样合入。Codex API backend / slot 的整流状态、完整 item/completed 快照、Anthropic tool_use、去重和显式冲突失败均已补齐。Claude Code 2.1.293 参数审查见 `.local/artifacts/2.1.293/protocol-audit.md`；原文和 wire-baseline 含私有证据/配置派生信息，仍只留在忽略目录。

CLI 原请求作为 `wireBody` 保留，在最终 SDK params（含自产 cache markers）上算 gate。保留 thinking/output_config、工具 true/false 开关和合法扩展字段；metadata 扩展保留、宿主身份覆盖；`betas`、`wireMessages`、`request_context` 等内部字段不进入 Messages JSON。updates / dangerous safeguards 各用正确 beta；不以 summarized/删除字段掩盖错误，不把 afk-mode 当 safeguards gate。setup-token 精简基线、API-key/OAuth 边界、Haiku 5.5 与 fast-model 能力门控已验证。SDK 指纹 0.128.0，UA 2.1.293；私有 SDK 依赖没有升级。

构建：Bun `compile-cli-node.ts`，目标 bun-linux-x64-baseline，stubbed 0 missing modules；UPX 5.0.2 best/lzma。OAuth 用 pkg 5.8.1 / node18-linux-x64，只压 ELF 前半并拼回尾部。此次 `PAYLOAD_POSITION=46205192`、`PAYLOAD_SIZE=1107903`、`PRELUDE_SIZE=74383`；压缩前半 13105964 字节，垫到 13250000 后拼回尾部。`oauth-auth/build.sh` 已改为当前 `bin/kin-oauth-auth` 路径，输出仍是 plain，后续压法不变。

| 本地交付路径 | 字节 | SHA256 |
|---|---:|---|
| `share/wrap-cli/cli-node` | 27166688 | `643f55232ec1950275daaa40adefd46f5d695eba613c622d66e0e8c1968a402c` |
| `bin/kin-oauth-auth` | 14432286 | `a8f9c16abfd64a7a684d92463045c2216e444bb8eb9f85ed6518cb6657f2b019` |

实际被测候选与交付 SHA256 一致。最终路径压缩 CLI：API-key/OAuth/setup-token 各同进程 4 job，合计 12 个真实 HTTP 请求通过；现有 E2E/OAuth 22 pass / 8 skip / 0 fail；Codex 20/20 HTTP 场景；真实 Rust → compressed CLI 的 updates/safeguards/Haiku/隔离/结果透传场景通过。压缩 OAuth 的 SOCKS5/TLS 换票、bootstrap、Grove 三跳指纹通过。受影响 Node 137 pass、全量超时后的剩余文件 280 pass、Bun 9 pass / 37 expect / 实际 4 文件。保留永久消费者回归，临时脚本/失败候选清理。

边界：全量 unit 在 300 秒后中断，sticky-router 48 pass + 1 unresolved-promise cancellation，不能称全量绿。localhost fixture 的 thread/classifier 等值仅证明传输，不等同真实上游 schema、账户特性权限或生产故障已恢复。

本轮没有重编或替换 kernel、没有部署。核对发现既存 `bin/kin-kernel` = `166b29142a6fbba88ff9cb62c2940ac598dd630d2c1f20281192038cf2448fcb`，`share/wrap-cli/kin-kernel.bin` = `c59a129280673aab88a8ac210d61336c350f060a039e8f8185b4b46736647b79`；两者各自的上述实际通道烟测通过，差异保留，发版前须核对主副本，避免 wrap 同步把现网 kernel 降级。Codex kernel `11c8ec08d2660a3d8beef4a3b55ed795c4b550a77ee6c8ff50d9b4af9c92d895` 未动。未来部署必须更新驻留 CLI，不能只覆盖 Node。未提交/push/改 VERSION/发布/合 PR/关闭 issues；用户并行改动保留。

## 2026-10-08 修复提交与统一 PR #300

上述修复已按用户新授权提交并推送。独立分支 `fix/protocol-wire-293-296-297` 从 `origin/main` 的 `1818871` 建立；工作树 `.local/pr-protocol-wire-293-296-297`。只迁移 HEAD→原工作区的目标 hunks，并复制前述两份已验证 ELF；未携带 `feat/key-group-scope` 的 `fba3c7c` 或其他并行改动，原工作区未切分支、未 reset/restore。

- `6c717d06f0fddbae9e8135e1f9e7615b4c6e60c2`：Codex 工具参数与转换错误处理，6 文件。
- `cc438892e8c4f20837c56c8d13ec58619b97fc1d`：Claude Code 参数/beta/SDK 指纹、CLI/OAuth ELF 与 changelog，17 文件。
- 单一 PR：https://github.com/dofastted/vm2api/pull/300；GitHub 核实 base `main`、head `fix/protocol-wire-293-296-297`、OPEN/非 draft、上述两笔 commits、23 文件、668 insertions/204 deletions。未合并 PR、关闭 issues、改 VERSION、发布或部署。

独立工作树验证：Biome 20 文件 No fixes applied；暂存 diff whitespace 检查通过；两个 ELF SHA256 与上表一致。`npm run test:unit` 完整运行 437 秒，190 个文件 / 2237 tests：2228 pass、9 skip、0 fail、0 cancelled；完整日志 `artifact://96`。直接受影响测试与现有实际 ELF E2E 合并运行：159 pass、8 skip、0 fail、0 cancelled，`artifact://95`；包含真实 Node→kernel→CLI 路径。跳过项为私有 OAuth helper 缺失与旧 CLI 兼容场景。此前 300 秒中断和 sticky-router cancellation 属于原混合工作区的历史观察，本次独立状态未出现，不据此推断其根因。

验证仍限于 localhost fixture；不是生产/真实账户验收。kernel 原有主副本差异保留，未重编替换；未来部署需核对同步风险并更新驻留 CLI。`gh` 在 Windows worktree 的 `.git` 路径解析失败后，改用原仓库目录显式指定 base/head 创建 PR，未改变提交范围。


2026-10-08 [v1.3.125](https://github.com/dofastted/vm2api/releases/tag/v1.3.125)：review 并逐个合入 PR [#300](https://github.com/dofastted/vm2api/pull/300)（merge `acfd101`）、[#298](https://github.com/dofastted/vm2api/pull/298)（`70cc37a`）、[#299](https://github.com/dofastted/vm2api/pull/299)（`0bbe0a3`）；#294 被 #300 取代后关闭。review 后各补一笔修复再合：#300 `5d4ce8b` 非流式 assemble 未捕获 `tool_arguments_mismatch`、Anthropic 转换 `JSON.parse` 无保护（stream:false 会 500）；#298 `961882c` `peekAccount` 不带 keyScope，count_tokens / `/v1/usage` 会 hop 到范围外 VM；#299 `1a1bddc` 包导入不校验出口归属（租户可绑 px-local / 他人同凭据 SOCKS）、租户 `seed_policy` 原样写入、`package` 未进保留 id、创建/导入/启动后没人写出口时区、运行中 PUT 包不重载 worker。发版 PR [#303](https://github.com/dofastted/vm2api/pull/303)，merge `8757c7f`：`share/wrap-cli/kin-kernel.bin` 对齐 `bin/kin-kernel` `166b2914…`（1.3.123 起 main 的 kernel CI job 因 cmp 失败），重建 `web/dist`。本地全量 unit 0 失败文件；PR/main CI 与 Release workflow `37767540980` 成功，10 个附件。部署：overlay SHA256 `d8f485dcdb0ce9a4ccfcd5ff867ecfb069fca77640f2931c425caf910f6c2023`（105637046 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.125-20261008T110419Z`，Node 重启一次，前门未动。cli-node `643f5523…`、oauth-auth `a8f9c16a…` 变了，`wrap-cli/sync` 8/8（vm-01、codex-01 不在列表，同前），vm-13 槽内 cli-node / kin-kernel.bin 与仓库一致。迁移 032 已生效（`api_keys.group_type`、`allowed_vms`）。verify-live 全 PASS：panel 登录与 1.3.125、虚拟机 11、9/9 容器 ID 不变、haiku 200 pong。关闭 #293 #296 #297；#292（创建时选代理）未实现，保留。apply 时 systemd 提示 unit 文件已变更待 daemon-reload，未执行。部署前快照里 kin-01、kin-codex-01 已是几分钟前重启，非本次操作。

2026-10-09 [v1.3.126](https://github.com/dofastted/vm2api/releases/tag/v1.3.126)（仅发版，未部署）：review 已合入的 [#302](https://github.com/dofastted/vm2api/pull/302)（缓存命中率分母，关闭 #301）与 [#305](https://github.com/dofastted/vm2api/pull/305)（流空闲上限可配置、eager 工具流式）。#305 合入时带 2 处 Biome 格式错误，main unit job 红。发版 PR [#306](https://github.com/dofastted/vm2api/pull/306)，merge `93ddeca`：`cc8f8ce` 格式化 + 注释改为 `JOB_IDLE_SECS`；`1ea9c41` 逐行 prompt SQL 移到 `usage-log-preds.mjs`，日志汇总两条路径与统计页同口径；`85428f2` #305 的 `requestKernelReloadWhenIdle` 测试在 Node 22 上等 unref 轮询定时器时事件循环清空，连带同文件 15 个测试取消（本机 Node 24 不复现，CI 用 Node 22），改用 ref tick 等待。本地 Node 22/24 全量 unit 0 失败，#306 CI 全绿。升级需 `wrap-cli/sync`（`share/wrap-cli/kin-kernel` 启动脚本变了），二进制不变。

2026-10-09 v1.3.126 部署 Netcup：线上原来是 1.3.125。tag `v1.3.126`（`93ddeca`）干净工作树打包，overlay SHA256 `eea2b0b80de0ff9ef8b524aa350c007c2cda362a970032fc611b694e324c7e86`（105643763 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.126-20261008T181912Z`。Node 重启一次，前门未动。`share/wrap-cli/kin-kernel` 启动脚本变了，`wrap-cli/sync` 8/8；vm-13 槽内脚本与仓库一致（`b9accdf6…`），kin-13 运行中的 kernel 进程环境已有 `JOB_IDLE_SECS=180`（取自 `kernel.json` `idle_timeout_seconds`）。二进制不变。verify-live 全 PASS：版本/面板 1.3.126、虚拟机 11、9/9 容器 ID 不变、haiku 200 pong。kin-01、kin-codex-01 在部署前约 1 分钟又重启过（与 1.3.125 部署前同样现象，非本次操作，ID 不变）。

2026-10-09 [v1.3.127](https://github.com/dofastted/vm2api/releases/tag/v1.3.127)（仅发版，未部署）：PR [#308](https://github.com/dofastted/vm2api/pull/308)（merge `54d0c75`）合并仓库 `src/config/routing.json` 的两个顶层 `codex` 键；此前后者覆盖前者丢掉 `codex.quota`，首次加载会误跑 `migrateLegacyOpenAIPolicies` 并改写 `routing.json`。发版 PR [#310](https://github.com/dofastted/vm2api/pull/310)，main/tag `v1.3.127` = `514d25f`。两个 PR 的 CI 全绿；Release workflow `37835260280` 四个 job 成功，10 附件（8 amd64 + 2 arm64），kin-kernel `166b2914…`、cli-node `643f5523…`、codex-kernel `11c8ec08…`、oauth-auth `a8f9c16a…`、cc-node `be5eec49…` 与仓内一致。正文已用 `gh release edit` 补上 CHANGELOG 1.3.127 段。上机只需 Node 控制面 overlay、重启一次，不需 `wrap-cli/sync`。

2026-10-09 [v1.3.129](https://github.com/dofastted/vm2api/releases/tag/v1.3.129) 发版并部署 Netcup：合入 PR [#314](https://github.com/dofastted/vm2api/pull/314)（风险审计页，merge `9b1be8a`；该分支上另有人提交了 `release: v1.3.128` `1acda2a`，tag v1.3.128 已发布但未部署）与 [#312](https://github.com/dofastted/vm2api/pull/312)（模型页重设计 + Haiku 5.5 100K，rebase 解 CHANGELOG / web/dist 冲突后重建 dist `be5e060`，merge `f2a3a9a`）。发版 PR [#315](https://github.com/dofastted/vm2api/pull/315)，main/tag `v1.3.129` = `f8d6aad`。按用户要求不等 CI；#314 的 PR CI 曾有 `pool-scheduler` 计时测试偶发失败，重跑通过。线上原来是 1.3.126（1.3.127/128 未单独部署，本次一并带上，含迁移 `033_proxy_geo_v6.sql`）。overlay SHA256 `e8c10e35…`（105649090 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.129-20261008T214854Z`。bin/kin-* 与 share/wrap-cli ELF 与线上同名文件 SHA256 全一致，**没做 wrap-cli/sync**。Node 重启一次，前门未动；apply 时提示 `vm2api.service` 单元文件磁盘有改动需 daemon-reload（非本次改动，未执行）。verify-live 全 PASS：版本/面板 1.3.129、虚拟机 11、公网首页 bundle `index-DNct6AnB.js` 与 tag 一致、9/9 容器 ID 不变、haiku 200 pong。kin-01、kin-codex-01 部署前约 2 分钟重启过（同前，非本次操作）。Release 正文已补 CHANGELOG 1.3.129 段。

2026-10-09 [v1.3.130](https://github.com/dofastted/vm2api/releases/tag/v1.3.130) 发版并部署 Netcup：用户反馈风险审计分母不对。根因两处：`protocolEntryStats` 拦截判定 `error_code = … OR via IN … OR final_state IN …` 对 NULL 不安全，正常请求得 NULL、`NOT NULL` 也是 NULL，放行只算到 1、入站 326（实际 1178/339/839）；`RequestLogStore.finish` 从未写 `intercept`（迁移 031 的列全空）。PR [#316](https://github.com/dofastted/vm2api/pull/316)（COALESCE + 返回 `total` + 落库 intercept + 回归测试），发版 PR [#317](https://github.com/dofastted/vm2api/pull/317)，main/tag `v1.3.130` = `6dfd769`，未等 CI。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.130-20261008T220419Z`，ELF 不变、未 sync，Node 重启一次。verify-live 全 PASS（9/9 容器 ID 不变、haiku 200 pong）。部署后线上接口 total 1189 = blocked 339 + passed 850；新请求已写入关卡判定（放行原因出现 jev），升级前旧行仍归「未经关卡」。

2026-10-09 [v1.3.131](https://github.com/dofastted/vm2api/releases/tag/v1.3.131) 发版并部署 Netcup：节点本地代理走所在 VPS 出口（控制面代发请求经节点 SSH direct-tcpip 回环 SOCKS5）、创建 `proxy_id`、本地代理置顶并标 `local:<VPS IP>`。PR [#318](https://github.com/dofastted/vm2api/pull/318)（merge `3d0cc30`，PR CI 全绿后合并），发版 PR [#319](https://github.com/dofastted/vm2api/pull/319)，main/tag `v1.3.131` = `b53355e`。Release workflow `37857271139` 成功，10 附件，正文已补 CHANGELOG 段。overlay SHA256 `1c91b363f4a0c88e…`（105659980 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.131-20261008T230433Z`。ELF 与线上一致，没做 wrap-cli/sync，Node 重启一次（apply 提示 vm2api.service 单元文件磁盘有变更需 daemon-reload，未执行，非本次引入）。verify-live 全 PASS（panel 1.3.131、虚拟机 11、9/9 容器 ID 不变、haiku 200 pong）。Node 新增回环监听 `127.0.0.1:<随机端口>`，两个节点链路 ready。线上唯一节点槽 vm-14 绑的是 SOCKS5 行，不是本地代理，**新路径未在生产真实触发**；未为验证改绑生产槽位。

2026-10-09 [v1.3.134](https://github.com/dofastted/vm2api/releases/tag/v1.3.134) 发版并部署 Netcup：PR [#323](https://github.com/dofastted/vm2api/pull/323)（merge `af30a58`）。命名账号池 #320，可选 `domain_forward` #322。main/tag `v1.3.134`。先部署未合并分支并通过 verify-live，再合并、打 tag。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.134-20261009T112433Z`。`bin/kin-egress` 已替换；没做 wrap-cli/sync，没重载槽。Node 重启一次，前门未动。verify-live 全 PASS：版本/面板 1.3.134、虚拟机 11、9/9 容器 ID 不变、haiku 200 pong。第一次 apply 失败是因为 `/tmp` tmpfs 100%（旧 overlay 包），tar 在拷进 `/opt` 之前退出，线上未改；清掉旧 `/tmp/vm2api-overlay-*` 后第二次成功。域名转发默认关，已在跑的 kin-egress 仍是旧进程，打开开关时才会拉起新二进制。

2026-10-09 [v1.3.135](https://github.com/dofastted/vm2api/releases/tag/v1.3.135) 发版并部署 Netcup：#324 对话中途 `role=system` 白名单按文档补齐（Fable 5/5.1、Mythos 5/5.1、Opus 4.8 保留原位；Sonnet 5 改为挪进顶层 system）。PR [#326](https://github.com/dofastted/vm2api/pull/326)（merge `e1a91e4`，PR CI 全绿），main/tag `v1.3.135`。先部署未合并分支并通过 verify-live，再合并、打 tag。overlay SHA256 `6b9f1fccdd56330d…`（105676611 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.135-20261009T151047Z`。7 个 ELF 与备份 cmp 一致，没做 wrap-cli/sync，没重载槽；Node 重启一次（daemon-reload 提示同 1.3.131，未执行）。verify-live 全 PASS：版本/面板 1.3.135、虚拟机 11、9/9 容器 ID 不变、haiku 200 pong。

2026-10-11 [v1.3.142](https://github.com/dofastted/vm2api/releases/tag/v1.3.142) 发版并部署 Netcup：线上原来是 1.3.139。main/tag `v1.3.142` = `fc01a3d`（含 `0c716208`，默认日志静音不再藏已分类的无槽位 403）。Release workflow `38121206951` 成功。overlay SHA256 `d5744984b075cb40…`（105663955 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.142-20261011T073837Z`。部署前 7 个 payload ELF 与 `deploy/payload.json` 一致，没做 wrap-cli/sync，没重载槽。Node 重启一次，前门 `vm2api-go` 仍 active（apply 提示 vm2api.service 单元文件磁盘有变更需 daemon-reload，未执行，同 1.3.131）。`verify-live.py 1.3.142` 退出 0：版本/health/面板 1.3.142、虚拟机 11、9/9 容器 ID 不变且全部 Up、首页标题匹配、haiku 200 pong。kin-01 / kin-codex-01 的 RestartCount 已是 1322，部署前就在重启，本次没有重建。nginx 仅在 07:38 重启那一分钟有 10 个 `/api/panel` 502，之后面板 200、`POST /v1/responses` 200。`usage_logs` 在门禁前最新一行仍是 07:35:25 的 `/v1/messages`；`/v1/responses` 自 05:42 起就没再写入 `usage_logs`，早于这次部署。门禁本身的 haiku 在重启之后返回 200。

2026-10-11 [v1.3.144](https://github.com/dofastted/vm2api/releases/tag/v1.3.144) 发版并部署 Netcup：决策模型 key 上限 999，一行可写 `https://host/v1/systemone <key>`，401/429/529 退役该 key。main/tag `v1.3.144` = `984f108e`（含 `0f2df49a`）。overlay SHA256 `00fdf406c3cb8b5b…`（105713784 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.144-20261011T102043Z`。kernel / cli-node / codex-kernel 与备份一致，**没做 wrap-cli/sync**，没重载槽。overlay 曾把宿主 `bin/kin-worker`、`bin/kin-egress` 换成另一份哈希；随后从该备份 `os.replace` 拷回（`7269deb3a450…` / `bf242027167e…`，0755），没有重启槽，9/9 容器 ID 不变。Node 重启一次，前门仍 active（daemon-reload 提示同 1.3.131，未执行）。`verify-live.py 1.3.144` 退出 0：版本/health/面板 1.3.144、虚拟机 11、9/9 容器 ID 不变且全部 Up、haiku 200 pong。

2026-10-11 [v1.3.145](https://github.com/dofastted/vm2api/releases/tag/v1.3.145) 发版并部署 Netcup：5h/7d 闸三段（`critical_band` 下沿到 `gate_overshoot` 默认 0.05 上沿为临近闸线，入座会话留原 VM 一次一个请求，闸线 + 超出量才换 VM）、控制台「临近闸线」与状态优先级、席位流 inflight 与 `event: proxy`。PR [#361](https://github.com/dofastted/vm2api/pull/361)（CI 全绿），先部署未合并分支再合并，merge `f246472d`，tag `v1.3.145`（版本提交 `af330ede`，与合并后树一致）。Release workflow `38135332859` 成功，10 附件。overlay SHA256 `3ab3a19d82035a6b…`，打包时把 `bin/kin-egress`、`bin/kin-worker` 换成线上原文件（`bf242027167e…` / `7269deb3a450…`），其余 payload 与 `deploy/payload.json` 及线上一致，**没做 wrap-cli/sync**，没重载槽。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.145-20261011T112023Z`。Node 重启一次，前门未动（daemon-reload 提示同前，未执行）。`verify-live.py 1.3.145` 退出 0：版本/health/面板 1.3.145、虚拟机 11、9/9 容器 Up 且 ID 不变、haiku 200 pong。部署前 `kin-codex-01`、`kin-01` 已在循环重启（RestartCount 1376，CLI `--print` 无输入退出），与本次无关，未处理。线上面板：vm-10（7d 90%）显示「7d 临近闸线」。

2026-10-11 [v1.3.146](https://github.com/dofastted/vm2api/releases/tag/v1.3.146) 发版并部署 Netcup：GPT 槽容器主进程从 Claude `kin-kernel --gateway-worker` 改为 `sleep infinity`（标签 `kin.vm.role=codex`），修掉 `kin-01` / `kin-codex-01` 约 4 分钟一次、各 1376 次的循环重启（无 Claude 凭证 → local_cli 等不到 20 槽 → exit 0 → unless-stopped 拉起）。PR [#362](https://github.com/dofastted/vm2api/pull/362)（CI 全绿），先部署未合并分支再合并，merge `c8e0207d`，tag `v1.3.146`（版本提交 `c8dfe433`）。Release workflow `38137322388`。overlay SHA256 `a82e4c6f2ecd543d…`，kin-egress / kin-worker 用线上原文件，**没做 wrap-cli/sync**。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.146-20261011T114709Z`。Node 重启一次。部署后 verify-live exit 0（9/9 ID 不变）；随后对 vm-codex-01、vm-01 各 reload 一次，容器重建（新 ID `fdd9fad000b1` / `b05fc7bb1934`），pin `gpt-5.5` 均 200 pong，5 分半后 RestartCount 0，以新快照再跑 verify-live exit 0。

2026-10-12 [v1.3.147](https://github.com/dofastted/vm2api/releases/tag/v1.3.147) 发版并部署 Netcup：线上原来是 1.3.146。#369 cherry-pick 进 `release/v1.3.147`（作者保留），新增 `jev_intercept.openai_platform_enabled`（默认关，GPT / Codex 默认不过拦截关卡）。PR [#372](https://github.com/dofastted/vm2api/pull/372) CI 全绿后合并，merge `dc2513bf`，tag `v1.3.147` = `fd56f7a2`。Release workflow `38178224393` 四 job 成功，10 附件（8 amd64 + 2 arm64），正文已是 CHANGELOG 1.3.147 段。overlay SHA256 `9b6f4f994c51b0df…`（105671058 字节），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.147-20261011T215534Z`。kin-kernel `166b2914…`、cli-node `643f5523…`、codex-kernel `11c8ec08…`、oauth-auth `a8f9c16a…`、kin-egress `bf242027167e…`、kin-worker `7269deb3a450…` 与线上一致，**没做 wrap-cli/sync**，没重载槽。Node 重启一次，前门未动（daemon-reload 提示同 1.3.131，未执行）。`verify-live.py 1.3.147` 退出 0：版本/health/面板 1.3.147、虚拟机 11、9/9 容器 Up 且 ID 不变、haiku 200 pong。#368 由 PR 的 Closes 自动关闭，#369 已关并注明开关默认关。

2026-10-12 [v1.3.148](https://github.com/dofastted/vm2api/releases/tag/v1.3.148) 发版并部署 Netcup：线上原来是 1.3.147（另有 01:08Z 手动热修的 `kin-oauth-auth` 未压缩版 `dccca54f…` 与 `cli-node` `c1316b7d…`，备份 `/opt/vm2api/.deploy-bak-vm2api-bins-20261012T010912Z`）。内容：main 上 #374/#373/#371/#367/#366/#364，加本地 cherry-pick 的换票止于 bootstrap、显式 fallback beta、硬正则跳过工具回传，示例 `routing.json` 写明 `codex.catalog_client_version: "auto"`。payload 新发 `payload-2026.10.12`（预发布，非 latest），只换 `kin-oauth-auth`（同一次 07:44 构建按本文切点 46205192 / 垫片 13250000 压前半，UPX 5.0.1，`PAYLOAD_SIZE=1105991`、`PRELUDE_SIZE=74383`，前半 13105828 字节，产物 **14430374** 字节，SHA256 `fe64b4ea20ca694863f9041fd02fd2c0c4e6d30cce99e273ee693d7d730a8095`）和 `cli-node`（`c1316b7d…`，2.1.293 请求组装对齐）。PR [#377](https://github.com/dofastted/vm2api/pull/377)，先部署未合并分支再合并，merge `50c32123`，tag `v1.3.148`（版本提交 `5398f58e`，合并后树与验证树一致）。Release workflow `38206443886` 四 job 成功，10 附件，正文已放 CHANGELOG 1.3.148 段；附件 oauth-auth / cli-node 与 pin 一致。overlay SHA256 `1df66874c1919412…`（105682417 字节），kin-worker / kin-egress 用线上原文件（`7269deb3…` / `bf242027…`）。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.148-20261012T050300Z`。与备份相比只有 `bin/kin-oauth-auth` 变（未压缩 → 压缩），kernel / cli-node / cc-node / codex-kernel 字节相同，**没做 wrap-cli/sync**，没重载槽（cli-node `c1316b7d…` 仍只在宿主 `share/wrap-cli`，槽内是否已同步未核对）。Node 重启一次，前门未动（daemon-reload 提示同 1.3.131，未执行）。`verify-live.py 1.3.148` 退出 0：版本/面板 1.3.148、health 200、虚拟机 11、9/9 容器 Up 且 ID 不变、haiku 200 pong。全量 unit 209 文件 2439 pass / 0 fail；压缩版 oauth-auth 的二进制测试 28 pass。#366 的 kin-kvm 修复在 runner 镜像里，guest-images workflow 已在 `7c7072d0` 上重建，现有 KVM 槽未重建。

2026-10-12 [v1.3.149](https://github.com/dofastted/vm2api/releases/tag/v1.3.149) 发版并部署 Netcup：线上原来是 1.3.148。内容：公开欢迎页 `#/welcome`（仿 new-api 首页）、独立登录页 `#/login`、按角色裁剪的首配清单与 `GET/PUT /api/panel/onboarding`（SQLite `settings.onboarding_state`）。PR [#379](https://github.com/dofastted/vm2api/pull/379) CI 全绿后合并，merge `eb95de41`，tag `v1.3.149`。overlay 从 `X:\vm2api-wt-welcome` worktree 打包（bin / share/wrap-cli 复制自主工作树，与 1.3.148 相同），备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.149-20261012T075402Z`。仅控制面改动，**没做 wrap-cli/sync**，没重载槽；Node 重启一次（daemon-reload 提示未执行）。`verify-live.py 1.3.149` exit 0：version、health、panel、VM 11、web、docker 9/9 Up 且 id 不变、对话 pong。文档站 PR dofastted/vm2api-docs#1（新增 `/guide/clients`）未合并、未部署。

2026-10-12 #383 消息级 effort 修复（本地工作区，未合并、未发正式应用版本、未部署）：Node 在官方支持模型保留空 system effort 控制与原位置，kernel `Message` serde round-trip 消息扩展字段，现有 CLI 无需重编。Rust release suite 112 passed / 1 ignored，release 构建成功；Node 完整 unit suite 通过，定向 effort 18/18；Bun requestBody 7/7；实际 Node → 新 kernel ELF → 现有 CLI → 本地 SSE fixture 及相关 native e2e 11 passed / 1 skipped（旧 CLI fixture 未提供）。新 kernel **12823808** 字节，SHA256 `d27bdaba1171ed6100ac3b4f00902807ae7b3d0d31a1ea1ff55e5d667e6370ea`，已安装本机 `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`。发布 [payload-2026.10.12-effort](https://github.com/dofastted/vm2api/releases/tag/payload-2026.10.12-effort)（prerelease、非 latest）；只更新 manifest 的两处 kernel 引用，其余 9 路径使用既有已发布 asset/hash，不把本机 unrelated payload 改动带入包。隔离组装的 11 路径 manifest check 通过、10 assets 上传完成且 GitHub digest 对上。将来部署需 Node + kernel 并做 `wrap-cli/sync`；本次没有 sync、远端连接或服务重启。没有真实 Anthropic 账户/cache-hit 复验。

2026-10-12 [v1.3.151](https://github.com/dofastted/vm2api/releases/tag/v1.3.151) 正式发布（未部署）：#383 消息级 effort 修复经 PR [#387](https://github.com/dofastted/vm2api/pull/387) 五项 CI 全绿后合并，main/tag `v1.3.151` = `8b599112ee029389d349ed397df41bad237f409c`。Release workflow [38241819936](https://github.com/dofastted/vm2api/actions/runs/38241819936) 四个 job 成功，10 附件（8 amd64 + 2 arm64），双架构镜像与 manifest 发布完成，正文已补修复和升级说明，GitHub latest 为 v1.3.151。六个固定二进制的 size/digest 与 `deploy/payload.json` 一致；正式附件 `kin-kernel` 下载后的 SHA256 为 `d27bdaba1171ed6100ac3b4f00902807ae7b3d0d31a1ea1ff55e5d667e6370ea`，用该 ELF 跑实际 Node → kernel → CLI → 本地 SSE fixture effort 回归通过。#383 已关闭为 completed；#376 HA 未实现，不关闭为已修复。没有部署或远端服务重启，无部署备份，未执行 `wrap-cli/sync`；现有实例需更新 Node/kernel 并 sync 才应用修复。仍未验证真实上游 cache-hit。

2026-10-12 原 PR [#384](https://github.com/dofastted/vm2api/pull/384) / [#363](https://github.com/dofastted/vm2api/pull/363) 接管修复后合并（未另发版、未部署）：保留作者提交，在原 fork head 追加修复及 main merge，没有 force push/rebase。#384 修复 `3358645e`，merge `606a5bc82b6090d45af7e41e3bd9ed721c5f5938`：严格读取仅缺文件返回 null，坏 JSON/其他 I/O 抛错；既有 best-effort 调用者自行捕获；固定 1024 项 LRU，删除/home wipe/备份恢复清理记录和凭证缓存。#363 修复 `10c8ba40`，最终组合 head `26448cb6582c16e259b7b948d10c75e8a6d43d5d`，merge `4ac0c519af6ca3b4e3dd6e6233ffc12db70eb76c`：混合提供商按行 prompt 分母、账号窗口再汇总；空完成无 TTFT、元数据不计时、生成工具名（包括无参数 delta）计首输出，日志入口时间优先于 hop 时间。

验收：最终组合 head 定向 85 passed / 0 failed；实际文件系统缓存与 Unix HTTP SSE 烟测通过。#384 [CI 38246348143](https://github.com/dofastted/vm2api/actions/runs/38246348143) 与 #363 最终 head [CI 38247590341](https://github.com/dofastted/vm2api/actions/runs/38247590341) 的 unit/kernel/worker/web/arm64 均通过。早期 CI payload 下载 HTTP 504 只重跑失败 job；本地全量首次缺 payload/egress 的 3 个旧失败文件在隔离工作树补齐前置后各 41 passed / 6 skipped / 0 failed，不冒称首次本地全量绿。API transport 和数据库页 PromptCacheMetricsPanel 未修改；#376 HA/shutdown 未动。本机 main 已快进到上述 #363 merge，并行 #385 的 CHANGELOG 和源码、私有仓既有改动保留。本轮未改 VERSION、未打应用 tag、未发布 Release、未部署或执行 wrap-cli/sync；v1.3.151 不包含这两个新合并 PR。

2026-10-12 [v1.3.152](https://github.com/dofastted/vm2api/releases/tag/v1.3.152) 发版并部署 Netcup：线上原来是 1.3.150（1.3.151 已发布但未单独上机，本次一并带上，含 #383 kernel effort）。main/tag `v1.3.152` = `5278867c`。Release workflow `38252482875` 已成功。overlay 在换入现网 `bin/kin-worker` 后 SHA256 `eb2c89105eb1f528a7d8a2a490223ba6726bd0d7834672424912e16203efa4c0`（110451841 字节）。本机 `kin-worker` 是旧的 `8bab97e5…`，现网保持 `7e08a49f…`；egress / oauth-auth / codex-kernel / cli-node / cc-node / crag / glibc 与现网一致。只换 kernel：`bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin` 从 `166b2914…` 换成 `d27bdaba…`。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.152-20261012T132115Z`。Node 重启一次，前门仍 active（daemon-reload 提示未执行）。`wrap-cli/sync` `{"restart":true}` 7/7，7 个 Claude 槽内 `kin-kernel.bin` 已是 `d27bdaba…`。`vm-01` 与 `vm-codex-01` 不在 sync 名单，槽内 `kin-kernel.bin` 仍是 `c59a1292…`，codex-kernel 未换。`verify-live.py 1.3.152` exit 0：version/health/panel 1.3.152、虚拟机 11、9/9 容器 Up 且 ID 不变、haiku 200 pong。

2026-10-13 [v1.3.154](https://github.com/dofastted/vm2api/releases/tag/v1.3.154) 发版并部署：PR [#393](https://github.com/dofastted/vm2api/pull/393) 先在未合并树上跑 verify-live.py，8 项全 PASS（version/health/panel/vms/web/docker_up/docker_identity/conversation 200 pong），然后合并。main/tag `v1.3.154` = `8eb9ce90`。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.154-20261013T022525Z`。只换 Node 控制面与 `web/dist`，Node 重启一次，前门保持 active。未执行 `wrap-cli/sync`，9 个槽容器 ID 未变。live `routing.json` 未覆盖，已显式开启的额度探测和健康缓存保持原样。Release workflow `38336970058` 四个 job 全部成功（linux-amd64、image-amd64、image-arm64、manifest）。附件含 amd64 二进制和 `kin-worker-linux-arm64`、`kin-egress-linux-arm64`。

2026-10-13 [v1.3.155](https://github.com/dofastted/vm2api/releases/tag/v1.3.155) 发版并部署：代理页找节点（地区点阵、地区栏可收起、单行表格 + 展开详情、VM 代理 tab 出口可筛选）。PR [#401](https://github.com/dofastted/vm2api/pull/401) 在未合并树上部署后 verify-live.py 8 项全 PASS（首次跑在 Node 重启后立即执行，连接被拒，重跑通过），然后合并。main = `b57200d5`，tag `v1.3.155` 指向该提交。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.155-20261013T074214Z`。overlay 在远端解包后逐个比对：bin/*、`share/wrap-cli`、`src/`、distill 规则与线上一致，仍按现网文件换入再 apply；实际变化只有 `web/dist` 与 `VERSION`。Node 重启一次，前门 active，未 `wrap-cli/sync`，9 个槽容器 ID 未变。drvfs 构建的 dist 文件落地为 755，apply 后改回 644。PR CI `unit` 失败与 main@8eb9ce90 相同（`crs-persona` / `crs-clean`，1.3.154 起既有），本 PR 未改 src/test。Release workflow `38364717223` 四个 job 全部成功，10 附件。此前当天还用临时 `web/dist` 直替做过三次预览（备份 `.deploy-bak-vm2api-webdist-*`），均已被本次 apply 覆盖。

2026-10-13 [v1.3.158](https://github.com/dofastted/vm2api/releases/tag/v1.3.158) 发版并部署：健康探测额度窗口、风险策略账号范围、每槽 `active_hours`。PR [#404](https://github.com/dofastted/vm2api/pull/404)、[#389](https://github.com/dofastted/vm2api/pull/389)、[#395](https://github.com/dofastted/vm2api/pull/395) 已合并。main/tag `v1.3.158` = `5f8489ef`（merge `0f7008c6`）。线上从 1.3.155 升到 1.3.158。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.158-20261013T093855Z`。overlay SHA256 `87a198972740fa3f0dd9e334b46f335d554771eacc85e8937403e6f1f177c2f1`（110450165 字节）。kernel 与 `share/wrap-cli` 字节与现网一致，未执行 `wrap-cli/sync`。`kin-egress` `0f00d3a1…` → `362df598…`，`kin-worker` `8bab97e5…` → `4572d6d1…`；Node 重启一次后 egress 按新二进制重新拉起。9 个槽容器 ID 未变。verify-live.py 首次在重启后立即执行连接失败，重跑 8 项全 PASS（conversation 200 pong）。Release workflow `38376662106` 四个 job 成功。daemon-reload 提示未执行。

2026-10-13 [v1.3.159](https://github.com/dofastted/vm2api/releases/tag/v1.3.159) 发版并部署：账号范围改为平台 · 套餐。PR [#407](https://github.com/dofastted/vm2api/pull/407) 在未合并树上 verify-live.py 8 项全 PASS 后合并。main = `2360a332`，tag `v1.3.159` 指向该 merge。提交 `726ce9b1`、`dc28d28d`、`bb08cde6`。线上从 1.3.158 升到 1.3.159。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.159-20261013T104543Z`。overlay SHA256 `e77beed6d86f7e6f472f34ba774e7ec74c57107df39a9288b95c0cc786205fbf`（110452758 字节）。kernel、egress、worker、`share/wrap-cli` 与现网字节一致，未执行 `wrap-cli/sync`。Node 重启一次，9 个槽容器 ID 未变。只选 GPT 套餐时 Claude 仍全进关卡；Claude Max/Pro 跟虚拟机列表的 `inferClaudeTier`。verify-live.py 一次通过（conversation 200 pong）。Release workflow `38385690142` 四个 job 成功，10 个附件，非草稿。daemon-reload 提示未执行。

2026-10-13 [v1.3.160](https://github.com/dofastted/vm2api/releases/tag/v1.3.160) 发版并部署：系统提示词五段注入，调用方 system 进第 5 段。PR [#408](https://github.com/dofastted/vm2api/pull/408) 在未合并树上 verify-live.py 8 项全 PASS 后合并。main = `14020324`，tag `v1.3.160`。线上从 1.3.159 升到 1.3.160。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.160-20261013T153028Z`。`/tmp` 是 3.9G tmpfs，旧 overlay 解包占满导致第一次 apply 失败，清掉 `/tmp/vm2api-overlay-*`（保留 1.3.160 包）后重试成功。Node 重启一次。Anthropic 槽 `vm-03`、`vm-05`、`vm-10`、`vm-13`、`vm-15`、`loutish-arches-3gicloudcom`、`bloat-ranges-3hicloudcom` 执行 `wrap-cli/sync` `restart:true`，7/7 `started_in_vm`。cli-node SHA256 `215e899406b904f780ac2217ff00c0193022a8bad65175d3dd126faf034f2322`。Codex 槽 `vm-01`、`vm-codex-01` 未换，cli-node 仍是 `c1316b7d…`。`vm-18` 记录为 running 但没有容器，未同步。`vm-03` 探测时写过的 `persona_preset=official_full` 已删，恢复继承全局 `official`，kernel.json 为 `official` / `identity`。9 个槽容器 ID 未变。verify-live.py 一次通过（conversation 200 pong）；本机默认 curl HTTP/2 连公网首页超时，HTTP/1.1 200。Release workflow `38423364717` 四个 job 成功，10 个附件，非草稿。


2026-10-14 [v1.3.163](https://github.com/dofastted/vm2api/releases/tag/v1.3.163) 发版并部署：官方家族默认套用当前 system 档，协议页开关可恢复透传。PR [#413](https://github.com/dofastted/vm2api/pull/413) 在未合并树上 verify-live.py 8 项全 PASS 后合并。main = `64acb596`，tag `v1.3.163`。线上从 1.3.162 升到 1.3.163。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.163-20261013T183636Z`。overlay 110457708 字节。cli-node 字节未变，未执行 `wrap-cli/sync`。Node 重启一次，9 个槽容器 ID 未变。第一次 verify 撞上重启窗口连接失败，立刻重试通过（conversation 200 pong）。开关默认关。daemon-reload 提示未执行。

2026-10-14 [v1.3.164](https://github.com/dofastted/vm2api/releases/tag/v1.3.164) 发版并部署：官方提示词把调用方长提示词放回 agent 槽，计费头索引固定首轮，role=system 留在消息列表。PR [#414](https://github.com/dofastted/vm2api/pull/414) 在未合并树上 verify-live.py 8 项全 PASS 后合并。main = `bc82c90a`，tag `v1.3.164`。线上从 1.3.163 升到 1.3.164。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.164-20261013T191525Z`。overlay 110467018 字节。未执行 `wrap-cli/sync`。Node 重启一次，9 个槽容器 ID 未变。verify 在重启窗口连拒两次，Node 起来后通过（conversation 200 pong）。daemon-reload 提示未执行。

2026-10-14 [v1.3.167](https://github.com/dofastted/vm2api/releases/tag/v1.3.167) 发版并部署：官方档没有入站 system 时也出站计费头、身份句、官方 prompt、Environment。PR [#418](https://github.com/dofastted/vm2api/pull/418) 合并。main = `b93aeddf`，tag `v1.3.167`。线上从 1.3.164 升到 1.3.167（中间 1.3.165/1.3.166 未单独发版）。发布后备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.167-20261013T203229Z`。未执行 `wrap-cli/sync`。Node 重启一次，9 个槽容器 ID 未变。verify-live.py 8 项全 PASS（conversation 200 pong）。无 system 的 sonnet-5-5 调试日志 `tools_count=0`，system 四段：计费头、身份句、官方 prompt（1h global）、`# Environment`。`cache_read` 105874 是用户正文，不是 Claude Code 工具尾。`rewrite` 仍把计费头放在 cache 断点之后。daemon-reload 提示未执行。

2026-10-14 计费重构预览部署（未合并、未发版，VERSION 仍 1.3.167）：用户要求先上 Netcup 验证。部署树 = live tag `b93aeddf` + `feat/model-billing-refactor` 相对 `57c6d64a` 的 8 个提交（不含 main 上两个未发布的 persona 提交），在 `/tmp/vm2api-deploy` 构建 `web/dist`。overlay 在远端换入现网 bin / `share/wrap-cli` / crag，逐个比对一致，实际变化只有 `src/lib`、`server.mjs`、`web/dist`；未 `wrap-cli/sync`。迁移 037 前 `sqlite3 .backup` 到 `/opt/vm2api/data/backups/kin-pre-037-20261014T054425Z.db`（2.4GB，quick_check ok，19897 行），并在副本上演练：prompt 总量前后同为 2430794270，耗时 0.09s。apply 备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.167-20261014T054536Z`，Node 重启一次，前门未动，daemon-reload 提示未执行。verify-live 8 项全 PASS（9/9 容器 ID 不变，conversation 200 pong）。线上 schema 037，models.dev 同步 70 个模型，上游目录同步 Claude 新增 `claude-opus-4-5-20251101`（policy_only 下默认关闭）、Codex 无新增；vm 页「今日」token 已含缓存（例如 vm-05 108M，其中缓存读 102M）。回滚：`remote-rollback.sh` 只还原代码；037 改写过的 OpenAI 行要恢复上面的 DB 备份，旧代码配新库会把 Codex 输入当含缓存，数字偏低。

2026-10-14 VM 页用量展示预览部署（未发版，VERSION 仍 1.3.167）：提交 `68a3e09f`。只替换 `web/dist` 284 个文件，先写带哈希资源再原子替换 `index.html`；`dl` 符号链接保留。备份 `/opt/vm2api/.deploy-bak-vm2api-vm-ui-20261014T063656Z`。未重启 Node，前门未动，未执行 `wrap-cli/sync`。verify-live.py 8 项全 PASS（9/9 容器 ID 不变，conversation 200 pong）。公网首页 `no-store`，与本次构建的 `index.html` 哈希一致。回滚该备份只还原静态资源。

2026-10-14 PR #424 整树补部署（VERSION 仍 1.3.167，未合并）：先前计费预览排除 `52b9b793`、`57c6d64a`，VM 页面只换了 `web/dist`，那两次 verify 不能算整树通过。本次 overlay SHA256 `f916d3411aa265762df6ed31a7c56cb032a7e4be45b4615ed06f20f6dc7f0896`（110491018 字节）。比对后二进制、wrap-cli、crag、`server.mjs`、`web/dist` 与当时线上一致，唯一变化是 `src/lib/protocol/handle-protocol.mjs`（`52b9b793` 的 API persona 补跑）；`crs-persona.mjs` 部署前已经与 PR 相同。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.167-20261014T070808Z`。Node 重启一次，前门未动，未执行 `wrap-cli/sync`。verify-live.py 8 项全 PASS（9/9 容器 ID 不变，conversation 200 pong）。

2026-10-14 [v1.3.168](https://github.com/dofastted/vm2api/releases/tag/v1.3.168) 逐步合并后统一发版：#424、#422、#412、#421、#423、#420、#425（#411 冲突解）。main = `5ca4a22f`，tag `v1.3.168`。部署未合并的 `release/v1.3.168` 后 verify-live.py 8 项全 PASS（9/9 容器 ID 不变，conversation 200 pong），再合并 #426 并打 tag。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.168-20261014T072838Z`。未执行 `wrap-cli/sync`。Node 重启一次。迁移 037 在计费预览时已经跑过。main CI 在 #425 后 unit/web 仍红：`crs-persona-usage` 期望 4 段实际 5 段，前端 persona preview 期望只剩 identity slot。线上门禁通过，测试断言未另开修复。

2026-10-14 [v1.3.169](https://github.com/dofastted/vm2api/releases/tag/v1.3.169) 补丁：不移动 `v1.3.168`。#411 把 0 注入测试改成丢掉零宽 agent 槽，与模板契约相反。PR #427 只改回测试。先部署未合并树，verify-live.py 第一次撞上 Node 重启窗口，重试 8 项全 PASS（9/9 容器 ID 不变，conversation 200 pong）。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.169-20261014T074127Z`。未执行 `wrap-cli/sync`。PR CI 的 unit/web/worker/kernel/arm64 均通过后合并，main = `554c37f1`。release 工作流 `38530375212` 成功：linux-amd64、image-amd64、image-arm64、manifest。

2026-10-15 [v1.3.173](https://github.com/dofastted/vm2api/releases/tag/v1.3.173) 发版并部署：Sonnet 5 / Haiku 4.5 等不能保留对话中途 `role=system` 的型号，重复的 `<total_tokens>` 提醒不再拼进缓存断点后面的 system 尾块。PR [#451](https://github.com/dofastted/vm2api/pull/451) 在未合并树上 verify-live.py 8 项全 PASS 后合并。main = `02a5718a`，tag `v1.3.173`。线上从 1.3.169 升到 1.3.173。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.173-20261015T090740Z`。overlay 110493296 字节。bin / wrap-cli / crag 与部署前线上哈希一致，未执行 `wrap-cli/sync`。Node 重启一次，10/10 容器 ID 未变。随后用 `v1.3.173-amd64` 镜像里的 `web/dist`（285 个文件，`index.html` `5faecda8…`）替换控制台，保留 `dl` 符号链接，没有第二次重启 Node（pid 与 ActiveEnterTimestamp 不变）。替换后再跑 verify-live.py。release 工作流 `38710794967` 成功：linux-amd64、image-amd64、image-arm64、manifest。

## 2026-10-15 v1.3.174 会话排队修复发布与部署

- 按本次用户授权顺序：PR [#454](https://github.com/dofastted/vm2api/pull/454) 全部检查通过并合并 → [Release v1.3.174](https://github.com/dofastted/vm2api/releases/tag/v1.3.174) 完整发布 → 部署。main / tag = `38c7fb91fc40326fd194120afcf5760498dcbcd3`；release workflow `38717905666` 四个 job 成功，10 个附件、amd64 / arm64 manifest 已核验。
- 线上从 1.3.173 升至 1.3.174，实际目录 `/opt/vm2api`；本文件早期 `/opt/kin-gateway` 及旧 unit 名是历史记录，不是当前部署目标。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.174-20261015T101340Z`，额外补存旧 `VERSION` 到备份内。
- 发布工作树 `/mnt/x/vm2api-wt-session-queue`；前端使用 CI 同系列 pnpm 10 构建。overlay 110495454 字节，SHA256 `ef1680f9725212768183791c7291c63292c247e20560024c7faa7b4ac895eb41`。bin / wrap-cli / crag 与部署前线上逐项同 SHA256，未执行 `wrap-cli/sync`，未重建或重启槽位容器。
- Node 只重启一次，PID `1407780`，启动时间 `2026-10-15 10:13:45 UTC`。Go 前门 PID `1765116` 和启动时间不变。routing.json、distill-rules、package manifests、二进制哈希保持不变，保留 `/opt/vm2api/web/dist/dl -> /var/www/vm2api-dl`；overlay 无 routing.json / vms / data / .env。
- 早期只读预检有 10 个容器；部署前即时快照已有 9 个，变化发生在应用 overlay 之前。本次 verify-live.py 8 项全 PASS：version/panel 1.3.174、health 200 vm2api、10 VM、首页通过、9/9 容器 Up 且 ID 不变、Haiku 200 pong。
- 真实连续性烟测：同一随机 inbound session / device 先并发两请求，再串行一请求；3 次均 200 pong，同一 VM、3 条 usage log 共享同一 outbound_session_id，SQLite sticky session 相同、hits=3，出站 ID 不等于入站 ID。只验证 Node 日志和粘性绑定；未抓取原生 CLI 最终 TLS wire，不据此声称上游 cache hit。
- 本地主线发布树 332 项相关测试串行通过。一次本地并行运行的既有 RPM 400ms 等待用例超时，未改断言或超时；PR 的 unit / web / worker / kernel / arm64 等检查均通过。

## 2026-10-15 v1.3.175 槽位恢复服务发布与部署

- 按用户授权顺序：PR [#457](https://github.com/dofastted/vm2api/pull/457) → 合并 → [Release v1.3.175](https://github.com/dofastted/vm2api/releases/tag/v1.3.175) → 部署。PR CI unit 两次撞上无关时序抖动（`panel-users` e2e「database is locked」、`pool-scheduler` cooldown 1s 用例；本地 3/3 通过），重跑失败 job 后全绿再合并。main / tag = `743652a88fe432d95221cb4af82e4ed98042e788`；release workflow `38735893334` 四个 job 成功，10 个附件，正文已用 CHANGELOG 1.3.175 段替换。
- 偏离 commit-pr-release 顺序：用户要求合并后发版再部署，未先部署未合并分支；与 v1.3.174 同样处理。
- 发布工作树 `/mnt/x/vm2api-wt-recovery`（WSL git 创建，git.exe 读不了该 worktree，只能用 WSL git）。web/dist 本地 vite 构建。overlay 打包后在远端用 `/tmp/vm2api-swap-live-bins.sh` 换入现网 bin / share/wrap-cli / crag 并逐项比对 SHA256 一致；实际变化只有 7 个 `src/lib` 文件、`server.mjs`、`web/dist`、VERSION。未执行 `wrap-cli/sync`，未重建或重启槽位容器。
- 线上 1.3.174 → 1.3.175，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.175-20261015T124103Z`。Node 重启一次（PID 2564184，12:41:07 UTC），Go 前门 PID 1765116 / 启动时间 2026-10-06 22:20:31 UTC 未变。verify-live.py 8 项全 PASS（version/panel 1.3.175、health 200、10 VM、首页、9/9 容器 Up 且 ID 不变、Haiku 200 pong）。
- 启动补开机：部署前只读核对所有记录为 running 的槽容器都 Up（vm-17 在节点上且 stopped），补开机未动任何槽。
- 实测发现：`systemctl restart vm2api` 会按 cgroup 杀掉全部 kin-egress 与 kin-codex-kernel。重启后 17 个 kin-egress 由代理池探测和新的 bridge-heal 在 27–33 秒内拉起（每个代理一个进程、无重复；bridge-heal 记录其中 5 个）。Codex 内核按请求懒启动，重启后不在；1.3.175 的诊断把这种状态报成 `codex_kernel_down` error，属误报，后续修复。


2026-10-16 补齐 kin-computer 交付：Debian 12 / Python 3.11 / Nuitka 4.3 编译，6347536 字节，SHA256 `ed8664a1bd8f735eb1332d7d96d442622efbf64b887b4d694529bb3dd3b16df3`。已补传 `payload-2026.10.12-effort` 和 `v1.3.176` 的 `kin-computer` 附件，回下载哈希一致；未重打 tag、未更新已发布 GHCR 镜像、未部署线上。原本机构建要求 GLIBC_2.38，在 Debian 12 启动失败；新构建在 Debian 12 两种 runtime 均成功。完整 amd64 控制面镜像从 GitHub 拉取并校验 12 个 payload 后构建成功，实际入口安装二进制，`POST /api/panel/vms/create` 回 200，Docker/KVM 重读身份稳定且镜像不含私有源码；相关单测 24/24。ARM64 新烟测已加入，但本次未运行 ARM64 镜像。当前本机原有 `kin-oauth-auth` / `cli-node` 与 manifest 不符，未重置、重 pin 或上传它们。旧 kin-computer 备份 `/tmp/kin-computer-before-_wkxrat2/kin-computer-original`。

2026-10-16 [v1.3.178](https://github.com/dofastted/vm2api/releases/tag/v1.3.178) 正式发布（未部署）：用户要求 PR → 合并 → Release，本次未执行线上部署与 verify-live，无部署备份、未做 wrap-cli/sync。基于远端 v1.3.177 在独立工作树 `/mnt/x/vm2api-wt-kin-computer-release` 移植修复（`a08c5e8d`），版本提交 `5b8e56f2`；PR [#470](https://github.com/dofastted/vm2api/pull/470) 所有 CI 通过后合并，main/tag = `8c61171cba31658f8d45867bd2d70bcb3eb8da99`。PR CI `38835512110` 与 main CI `38835981247` 成功，ARM64 实际运行 Docker/KVM 新身份生成及重读稳定性烟测。Release `38836011093` 四 job 成功，11 附件齐全，非 draft/非 prerelease，正文已补升级说明；`kin-computer` 回下载 SHA256 `ed8664a1bd8f735eb1332d7d96d442622efbf64b887b4d694529bb3dd3b16df3`。GHCR v1.3.178 多架构清单 `sha256:3f82537d8f49ac85508d052d36b3b03a2e18c9ee0cedf161fcde7b5e4bbbf8cd` 包含 linux/amd64 与 linux/arm64。原工作区和私有源码原有未提交改动保留。

2026-10-16 按用户追加要求补齐历史版本附件：完整分页清点 `v1.0.0` 至 `v1.3.178` 的 199 个非 draft 版本 Release，新增上传 197 个缺失的 `kin-computer`，原有 v1.3.176/v1.3.178 同名附件不覆盖。最终重新分页核对 199/199 都有唯一同名已上传附件，大小均为 6347536、SHA256 均为 `ed8664a1bd8f735eb1332d7d96d442622efbf64b887b4d694529bb3dd3b16df3`；补传前已有附件的 ID、大小、digest、下载 URL 全部保留。实际回下载 v1.0.0、v1.3.177 两个边界样本，哈希一致。只新增缺失附件，不移动历史 tag、不修改历史源码或旧镜像；旧控制面仍按其原逻辑解析二进制路径，需要时设置 KIN_COMPUTER_BIN。

## 2026-10-16 v1.3.178 部署 Netcup

- 线上 1.3.175 → 1.3.178（1.3.176、1.3.177 未单独上机，本次一并带上）。tag `v1.3.178` = `8c61171cba31658f8d45867bd2d70bcb3eb8da99`。部署树 `/tmp/vm2api-wt-deploy-178`（detached）。前端用 pnpm 10.34.7 在该树执行 `pnpm -C web install --frozen-lockfile && pnpm -C web build`。
- overlay 116755296 字节，SHA256 `e5108a0164e4578f7f32cb7ffa8d4a1018ddc5f949b556103b926f7431916e7c`。kernel、codex-kernel、egress、worker、oauth-auth、cli-node、cc-node、kin-kernel.bin、crag、glibc239、distill-rules 与部署前线上逐项同 SHA256。新装 `bin/kin-computer`，SHA256 `ed8664a1bd8f735eb1332d7d96d442622efbf64b887b4d694529bb3dd3b16df3`。未执行 `wrap-cli/sync`，未重建槽位容器。未覆盖 `routing.json`、`vms/`、`data/`、`.env`；仓库里新增的 `queue_keepalive_delay_ms` / `session_queue_timeout_ms` 不在线上 routing.json，代码默认 60s / 900s。
- 备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.178-20261016T020300Z`，内有 `VERSION-before=1.3.175`。Node 只重启一次（PID 1123399，2026-10-16 02:03:04 UTC）。Go 前门 PID 1765116、启动时间 2026-10-06 22:20:31 UTC 未变。`web/dist/dl` 仍指向 `/var/www/vm2api-dl`。daemon-reload 提示未执行。
- verify-live.py 8 项全 PASS：version/panel 1.3.178、health 200 vm2api、11 VM、首页、9/9 容器 Up 且 ID 不变、Haiku 200 pong。

## 2026-10-16 v1.3.179 发布与 Hostdzire 部署

- Netcup 已弃用；当前生产目标为 Hostdzire，`skills/version-switch/host.env` 已改用 `hostdzire`。线上从 1.3.178 升到 1.3.179。PR [#475](https://github.com/dofastted/vm2api/pull/475) 合并，main/tag `v1.3.179` = `3752923cc4244ae6a245d89ffda7a10f20a18b33`；PR CI `38888288236` 的 unit / worker / kernel / web / arm64 全通过。Release workflow `38888988024` 四 job 成功，Release 非 draft/prerelease，11 个资产（amd64 / arm64）。
- overlay 112032967 字节，SHA256 `f33cec942fc604d046c4e557b975022f26a7df86b0def873f7840e69089de9ec`。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.179-20261016T110722Z`，补存 `VERSION-before=1.3.178`。Node 重启一次，PID `2675053`，`vm2api.service` / `vm2api-go.service` active；`web/dist/dl` symlink 保留。
- 与 Hostdzire 部署前相比，`kin-egress`、`kin-worker`、`kin-oauth-auth`、`cli-node` 哈希变化；kernel、Codex kernel、cc-node、crag 与 glibc239 不变。`wrap-cli/sync {"restart":true}` 返回 7/7，未重建 Docker 槽容器；8/8 `kin-*` 容器仍 Up 且 ID 不变。
- `verify-live.py` version / health / web / docker_up / docker_identity / conversation 通过（Haiku 200 `pong`），但总退出 1：panel login 使用 systemd `KIN_ADMIN_*` 凭证返回 401，导致脚本 panel 与 vms 两项失败。未重置或改写管理员密码。以 master API key 另行验证 `/api/panel/me` 与 `/api/panel/vms` 均 200、version 1.3.179、11 VM。需运维后续更新 verify-live 使用的面板登录凭证，或确认 DB 管理员登录凭据后重跑完整门禁。

## 2026-10-17 v1.3.180 部署尝试与回滚

- PR [#494](https://github.com/dofastted/vm2api/pull/494) 未合并树先行部署。构建版本 `1.3.180` overlay 112054439 字节；应用备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.180-20261016T183012Z`。
- Node 启动失败：线上 `/opt/vm2api/node_modules` 缺少 `croner`，新源码 `src/lib/admin/vm-test-schedule.mjs` 无法加载；未执行 `wrap-cli/sync`，9 个槽位容器未重建。
- 已用备份回滚，恢复线上 `1.3.179`，`vm2api.service` / `vm2api-go.service` active，9/9 容器 ID 未变，health/web/conversation 通过。`verify-live.py 1.3.179` 仍因既有 `KIN_ADMIN_*` 面板登录返回 401 而总退出 1；未合并、未打 tag、未发布 Release。

## 2026-10-17 v1.3.181 发布与 HostDzire 部署

- 先在线上补装 `croner@10.0.1` 并确认从 `/opt/vm2api` 可导入。远端 main 已发布 `v1.3.180`（PR #495），本次改为 `v1.3.181`，不覆盖旧 tag。
- PR [#494](https://github.com/dofastted/vm2api/pull/494) 合并，merge commit `4fe27cfa96408c0504c59830f1788f01dddccdfb`。tag `v1.3.181` = `5e7306e71ae165505a7e1622b0cb334da4483021`（`release: cut v1.3.181`）。Release：https://github.com/dofastted/vm2api/releases/tag/v1.3.181
- overlay `/tmp/vm2api-overlay-1.3.181.tgz` 112057987 字节。备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.181-20261017T015011Z`。Node 由 apply 脚本重启一次；未执行 `wrap-cli/sync`，未重建槽位容器。
- `verify-live.py 1.3.181 --before /tmp/kin-before-1.3.180.txt`：version_file / health / web / docker_up 9/9 / docker_identity 9/9 unchanged / conversation 200 pong 通过。panel 与 vms 因既有 `KIN_ADMIN_*` 登录 401 失败，脚本总退出 1。未重置管理员密码。
- 以 systemd master key 另行验证：`GET /api/panel/me` 200、version `1.3.181`；`GET /api/panel/vms` 200、10 台，样本含 `physical_features`。提供的普通 API key 访问管理接口为 403，未改其权限。

## 2026-10-17 kin-computer GLIBC 2.35 热修

- Hostdzire 是 Ubuntu 22.04 / GLIBC 2.35。Debian 12 构建的 `kin-computer`（`ed8664a1…`，6347536 字节）解压后的 `libexpat.so.1` 要求 GLIBC_2.36，扩展 AWS 集群建槽时报「计算机身份创建失败」并清掉目录。身份只在控制面生成，AWS 节点不执行该二进制。
- 构建基线改为 Ubuntu 22.04 / Python 3.10 / Nuitka 4.3。新产物 5527768 字节，SHA256 `fa431f10321e6043ee88a4012b6dd8c515acac3a63fc40645091d1edf6334c01`。旧文件备份 `/opt/vm2api/bin/kin-computer.bak-glibc235-20261017T062814Z`。未重启 Node，未执行 `wrap-cli/sync`，未重建槽位，未改 `deploy/payload.json`，未发 Release。
- Ubuntu 22.04 容器内 Docker / KVM 创建成功。Hostdzire 上 `/opt/vm2api/bin/kin-computer` 直接创建 Docker 身份成功；控制面 `ensureSlotComputer` 首次创建、第二次不重抽，hostname / machine-id / MAC 稳定。测试目录已删。已有槽位身份未改。
- 真实面板验证：`POST /api/panel/vms/create` 在 `node-6beb967a` 创建 `aws-glibc-check`，`start:false`。HTTP 200，槽位 `stopped`、无容器。身份 `macpro7-1-b6a405` / `b6a4056c550a4e12d5c109f6d0bce295` / `8C:85:90:04:90:2E`。随后 `DELETE` 返回 200，控制面 json 与目录已消失。未启动容器，未改已有槽。
- 2026-10-17 发布兼容 payload：`payload-2026.10.17-computer`，非 latest、prerelease。`kin-computer` 回下载 5527768 字节，SHA256 `fa431f10321e6043ee88a4012b6dd8c515acac3a63fc40645091d1edf6334c01`；其余 10 个附件不变。Ubuntu 22.04 / GLIBC 2.35、Debian 12 / 2.36、Ubuntu 24.04 / 2.39 均完成 Docker 与 KVM 创建。清单已改指向该 Release。未打版本 tag，未重建 GHCR 镜像。

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
- 发布前补充独立哈希核对：本机构建产物、`bin/kin-kernel`、`share/wrap-cli/kin-kernel.bin` 均为 12844112 字节 / `39996c1e…`；控制面母样本两份、本机 7 个 Anthropic 槽文件、节点 `jp-pro` 和已停止的 `aws-vm`（Docker cp 只读提取）均同哈希。先前输出 `56527336…` 是安装复制之前的旧文件快照，不是上传时的文件。只读核对未启动或重启任何槽。
## 2026-10-17 v1.3.187 HostDzire 部署

- GitHub Release `v1.3.187` 已发布，含 11 个附件。部署前线上为 `1.3.184`，9 个 `kin-*` 容器均 Up；部署包 `/tmp/vm2api-overlay-1.3.187.tgz`（111261899 字节，SHA256 `7c4f32290860c6faea6b7056feee432310a7d500ae51116908d02994647cd12a`）。
- `remote-apply.sh` 成功，备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.187-20261017T132229Z`，VERSION `1.3.187`，`vm2api.service` / `vm2api-go.service` active。Node 由 apply 重启一次。
- kernel SHA256 与线上一致：`39996c1e…`；cli-node SHA256 与线上一致：`c1316b7d…`，未执行 `wrap-cli/sync`，未重建槽位容器。
- `verify-live.py 1.3.187 --before /tmp/kin-before-1.3.187.txt`：version、health、web、9/9 容器 Up、9/9 ID 不变、真实对话 200 pong 均通过；panel / VM 列表失败（me version 为 None、VM 数 0），脚本退出 1。按此前部署记录，这是 `KIN_ADMIN_*` 登录返回 401 的既有问题；本次未改管理员凭据。需修复管理登录凭据后重新通过完整 gate。
- 后续核查确认：PR #466（commit `c797254f`）的定时模型测试后端已在 v1.3.187 与线上（`src/lib/admin/vm-test-schedule.mjs` 哈希 `151e64b9…`），但部署包使用了未重新构建的本地 `web/dist`；该 dist 的入口资产不含 `test-schedule`，因此面板缺少「定时测试」UI。`pack-overlay.sh` 只打包现有 dist，不自动执行前端构建；overlay 也不包含 `package.json`。不是 PR #466 未合入，而是前端构建产物过期。
- 版本 tag `v1.3.187` 本身没有 `web/dist`（`git ls-tree -r` 返回 0 项），这是源码仓库的既定形态，PR #466 已提交组件源码；GitHub Release 的 Dockerfile 会从 `web/` 重新构建 dist。缺陷在本次 overlay 流程没有在对应版本源码树执行前端构建，误将根工作区既有 dist 打包；不应表述为 tag 遗漏 PR 或已提交 dist。

## 2026-10-18 2.1.296 缓存 / Environment 补丁部署准备（未切换）

- 本次代码：`7ad99436`（协议页默认 TTL）、`f63bac9d`（Environment opt-out / caller 时区保留）、`9dd8fe20`（文档）；另含本会话前置身份 / cache 所有权提交 `9f46a2bb`、`f3ec4824`。应用 VERSION 仍为 `1.3.187`；未 push、未发 tag / Release、未改 payload manifest。
- 现网清点 9 个 Anthropic 槽：本机 6 个（`vm-03`、`vm-10`、`vm-13`、`vm-19`、`bloat-ranges-3hicloudcom`、`loutish-arches-3gicloudcom`），集群 3 个（`aws-vm`、`jp-pro`、`jp-pro2`）。2 个 GPT/Codex 槽不在更新范围。9 槽当前均为 `local_cli` / `2.1.293` 配置，kernel `39996c1e…`、CLI `c1316b7d…`。
- 集群 3 个容器实机 `ReadonlyRootfs=true`，kernel/CLI 位于镜像 `/opt/kin`，`wrap-cli/sync` 会跳过它们；现有受支持升级流程要求新镜像 + 容器重建。未收到明确重建许可，选择器超时采用“保留当前运行版本”的保守选项。因此**控制面和全部 9 槽均未切换**，没有 Node / Go / 槽位重启，也没有 `docker rm`、镜像重建或生产文件替换。
- 已准备本地与远端暂存包 `/tmp/vm2api-1.3.187-cc296-9dd8fe20.tgz`，39825220 字节，SHA256 `79e21e0cffd29d3fd941814e16f018ef39fc90de9f4bac71800fce699461457d`。这是**最小补丁包，不可交给现有 `remote-apply.sh` 使用**（该脚本会整体替换 `src/lib` 且要求其他 binaries）；包仅含 13 个本次 Node/Python 文件、VERSION、完整新 web/dist、Anthropic kernel/CLI/wrapper/glibc，不含运行配置、VM/DB、Go/Codex/OAuth/computer 产物。后续实际应用必须按 `DEPLOY-MANIFEST.json` 逐文件覆盖并使用正确的集群升级流程。
- 候选 kernel：12839808 字节，SHA256 `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977`。候选 CLI：UPX 5.0.2 `--best --lzma`，27172956 字节，SHA256 `244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7`；plain `847abadc…` 未覆盖，根目录原有其他本机产物亦未覆盖。
- 最终压缩 ELF 本地 Node → kernel → CLI 捕获：10 passed / 1 skipped；覆盖四档 Environment off × 无 caller / 有 caller、on 对照及 classifier/effort/thinking。远端只在 `/tmp/vm2api-cc296-preflight-f7ravm9r` 解包，308 个 payload 文件 SHA 校验、11 个 Node 文件语法、Python AST 与 CLI `2.1.296 (Claude Code)` 通过。kernel 需要 GLIBC 2.39，经打包的 loader 运行到预期 `--gateway-worker requires --config` 参数校验，未启动 listener；kernel 不支持 `--help`，首次该探针报错后已修正。此项不是新槽位实际运行验收。
- 回滚备份：`/opt/vm2api/.deploy-bak-cc296-1.3.187-20261017T191024Z-9dd8fe20`，权限 0700；含控制面原文件、web、母样本、SQLite 一致快照、受保护配置、9 槽记录/运行配置与原二进制。集群 3 槽通过只读 Docker cp 取回 `/opt/kin`（含已停止的 aws），原 image/container inspect 均已保留；未启动停止槽。恢复时不得整体覆盖可能已刷新的凭据，应按批准范围只恢复部署文件及原调度/运行字段。
- 准备后独立核对：线上 Node PID `136935`、Go PID `996741`、13 个生产源码哈希、web index、母样本、兼容配置、所有 VM 调度/状态、全部本机与集群容器 ID / StartedAt 均与基线一致。8 个运行中 Anthropic 内核均 HTTP 200 / healthy / ready_slots=20；`aws-vm` 原 paused / exited 不启动，`jp-pro2` 原调度关闭不改变。这是旧版本健康基线，不能称为新版部署成功。
- 全量更新仍需明确授权重建 `aws-vm`、`jp-pro`、`jp-pro2`，随后先刷新基线 / 备份，再排空、应用控制面与本机 payload、构建集群新镜像、逐槽更新并恢复原状态；在那之前保持现网原版本。

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

## 2026-10-18 CCH / sticky native 更新已部署（未发布版本仍为 1.3.190）

- 基于线上 `1.3.190` 候选 `f958fb39e1cf3863635f7d3481f6dd7281bcaa46`，部署包不回退线上版本；备份 `/opt/vm2api/.deploy-bak-native-fivezero-20261018T090200Z-f958fb39`，远端部署包 SHA256 `e57601411777774cc6c60fde62767282e1fdc939d03c4f40e0f27797efc40006`。
- 控制面 Node `2811678 → 3092748` 只重启 1 次；Go 前门 PID `996741` 保持不变。部署前请求连续 3 次 `inflight=0` 后才切换；未覆盖 `routing.json`、`vms/`、`data/`、`.env`，未触碰 GPT 槽。
- 10/10 Anthropic VM 已更新：本机 6 槽直接替换 `.kin` 并重启内核；集群 `vm-05`、`jp-pro`、`jp-pro2`、`aws-vm` 使用新只读镜像 `vm2api/kin-slot-ubuntu-24.04:d269fe983e86` 重建容器。`aws-vm` 保持 paused / 未启动；其余 9 个运行槽健康、`ready_slots=20`、`closed_slots=0`、`cli_restarts=0`。集群旧容器以 `rollback-native-f958fb39-*` 保留回滚。
- 10/10 kernel SHA256 `97959c164721be03478b057473d1da8206ee42ddae609dbf3a85327915a824b7`；10/10 CLI SHA256 `369889d8cc05c6084bb384e330b53541266d40b3abd2dc1042d3afe8c61aea28`；运行进程均为 CLI `2.1.296`，`CLAUDE_CODE_ENTRYPOINT=sdk-cli`、`KERNEL_CONFIG=/run/kin/kernel.json`。全部 VM `cch_enabled=true`、`session_idle_ttl_seconds=600`。
- 正式 `verify-live.py 1.3.190 --auth-mode master --container-policy baseline` 最终通过：版本、health、panel、12 VM、web、8 个本机容器身份/状态和控制面 Claude 对话均 PASS。逐槽 loopback `test-chat` 9/9 返回 HTTP 200 `pong`；协议页公网资源递归哈希与候选 manifest 一致，并包含 CCH、五零说明和 sticky 空闲控件。
- 新候选隔离传输三轮 `false → true → false` 得到 `cch=00000 → 6a50b → 00000`，提示词同名字面量保留、billing 参数和标准 UA 保留、CLI PID 不变；未用真实 Anthropic 账号验证 CCH 上游能力。生产未执行全局配置切换，默认仍为 CCH 开启 / 600 秒。

## 2026-10-18 CCH / sticky native PR 已合并，本地 main 已同步（未部署）

- PR [#566](https://github.com/dofastted/vm2api/pull/566)，分支 `feat/protocol-cch-sticky-native`，head `d2e76aa7e83bc6abf062b56a153d018cd511c2a7`。独立工作树 `/mnt/x/tmp/vm2api-pr-protocol` 基于最新主线 `06d25bd15edefdf65bcb9a14f262e8514ba1c132`，保留 4 个原子功能提交、一次普通主线合并和一个 payload 清单提交；未改写原工作树或提交混合私有源码。
- 新不可变依赖快照 `payload-2026.10.18-cch-sticky` 为非 latest prerelease，仅替换上述已部署的 Claude kernel / CLI；Codex 与其余产物不变。11 项 GitHub 服务端摘要、12 个安装路径均校验一致；新 kernel / CLI 回下载 SHA256 与上述部署相同，未公开私有源码。
- 本机 Node 定向 254 通过，前端 443 通过且 TS / Vite 构建通过，CLI 38 测试 / 152 断言通过。回下载真实 ELF 配合当前 PR 代码、隔离 HTTP 上游实跑得到 `00000 → e29a2 → 00000`，CLI PID 不变、0 重启，提示词 / billing / 标准 UA 保留。
- 主线新加的 5000 字节 UDP DNS 测试在本机超时；独立回环 UDP 烟测也仅 32 字节可达、4096 / 5000 字节不可达。未为环境限制修改生产代码或删除测试，worker 其余 `-race` 检查全通过；完整 CI 结果以 PR 检查为准。当前 PR 的完整 `1.3.191` 主线树未重新部署，不能把上述 `1.3.190` 候选验收算作本 PR 全树线上验收。
- CI [39131073323](https://github.com/dofastted/vm2api/actions/runs/39131073323) 的 `unit`、`web`、`worker`、`kernel`、`arm64` 五项全部成功，GitHub runner 的 worker race 检查通过，kernel job 的固定 payload ELF 校验通过。合并前 8 项检查均成功，含 Approval Router、Bugbot 与安全审查；未使用自动合并或管理员绕过。
- 后续用户明确选择仅同步 GitHub 与本地代码、跳过本次生产部署门禁：PR #566 已普通合并，merge commit `6a89c951255735e65e9ceb91c2a1390a168eb172`；本地 `/mnt/x/vm2api` 的 `main`、`origin/main` 与 GitHub `main` 三者一致。原本地 15 个分叉提交完整保留于 `backup/main-before-pr566-20261018T134230613Z`（旧 head `35d4dc18`）；未提交的 `sticky-pane.tsx` SHA256 前后一致，未 reset / rebase / force-push。当前源码 `VERSION=1.3.191`，本次未部署、未重启服务、未发布应用版本。

## 2026-10-18 已合并 main / 1.3.191 部署完成

- 用户随后授权生产更新。固定候选 `6a89c951255735e65e9ceb91c2a1390a168eb172`，干净工作树 `/mnt/x/tmp/vm2api-deploy-main-6a89c951`；原开发工作树的 `sticky-pane.tsx` 未进入部署。线上 `1.3.190 → 1.3.191`，未切应用 tag / Release。
- 包 `/tmp/vm2api-main-deploy-r4R9ci/overlay.tgz`，SHA256 `568c57b22594e0ef964d42589801d6d58558ddec82539203d041e94eb077e985`。最终备份 `/opt/vm2api/.deploy-bak-main-1.3.191-20261018T135233717Z-retry2`，含旧代码、网页、node_modules、VM 记录、受保护配置及 SQLite 一致备份（2433081344 字节）。`FINAL-VERIFICATION.json` 保留最终证据；此前两个事务的备份也保留。
- 发现生产 package 元数据缺少 `croner`，在隔离目录按当前锁文件执行 `npm ci --omit=dev --no-audit --no-fund`，预检运行依赖和调度函数实际导出后随源码切换。网页 TS / Vite 构建成功；`kin-worker`、`kin-egress`、`kin-api-kernel` 从固定源码静态构建。
- 两次尝试自动回滚：第一次部署脚本误从 `vm-file.mjs` 导入 `patchVmRecord`（实际导出在 `vm-registry.mjs`），在恢复调度阶段失败；第二次最终集群容器核对遇到 Node 重启后 Docker 中转连接重置。两次均恢复旧版本健康与原调度字段；修正导出并增加有界中转重连等待后第三次成功。systemd 日志记录本次共 5 次受控启动（首次新版本 + 回滚、第二次新版本 + 回滚、最终成功），不能声称全程仅重启一次。
- 最终 Node PID `620348`，Go 前门 PID `996741` 始终不变。318 个运行文件与 290 个网页文件全部摘要一致；`.env` / routing 配置保持不变。调度、手动开关、代理、指纹、机器信息保持原值；本机 8 个及集群 10 个容器的 ID、状态、启动时间保持。未重新执行 wrap-cli/sync、未重建容器；暂停的 AWS 仍未启动。
- 新 Node 实际加载 `kin-api-kernel`（SHA256 `c05abdc9a1c066ba1c959fdad6124c71ff5b6498e87a3d2bf14b1f76f831fa40`）及本机 `kin-egress`（`955ab08e4f68b667b27a136a4f52913487fffa0f0611dc44e09a827d5ecfd734`）。Claude kernel / CLI、Codex kernel 与更新前一致，不重复刷新已有槽；集群容器内的 helper 不在本次滚动重启范围。
- `verify-live.py 1.3.191 --before /tmp/vm2api-main-deploy-r4R9ci/containers-before.txt --auth-mode master --container-policy baseline` 退出 0：版本、health、管理鉴权、13 VM、公网网页、8/8 本机容器身份状态、真实 `200 pong` 全通过。10 个运行 Anthropic 槽均健康、20 ready、CLI 0 重启；CCH 开启 / 空闲 600 秒。浏览器实际协议页显示 `v1.3.191`、CCH 开启、600 秒，临时真实管理会话已撤销，浏览器已关闭。


## 2026-10-18 出站 Session 漂移根因与取消修复（未部署）

- 用户给出的 `a46d14f8-0f8a-47ed-b039-3aac66689441` / `e58b99b9-4545-4032-bceb-f25765c4b19b` 实为 request_id；同一入站 `01a14f60-fce8-73a7-b13b-281f691eecef`、VM `loutish-arches-3gicloudcom`、账号 `b5db293d-6881-4fbf-b9e0-9d9cd94eaf6a`。两条成功记录均仅执行一次，出站从 `041b50d0-35a7-4197-a2e3-74b3c1458d3b` 变为 `e899ee62-14e2-4b65-98c9-fa02fdd62ce0`，缓存 read 从 48062 降至 39012，creation 从 226 增至 9271。
- 两次成功之间的 `request_attempts.id=43402` / request `d67a5d77-c9d6-468e-86c3-7966b05f5a1a` 于 14:23:26.718–14:23:35.703 UTC 返回 499 / cancelled / downstream_committed=1；该请求在 usage_logs 与 request_log_debug 中均无行。Node `FailoverRunner` 的两个取消分支调用 `retireOutboundSession`，以 replaceSession + clearSlot 清空绑定，导致下轮同 VM 重建。第一代仅成功 11 次，第二代截至 14:48:05 已成功 56 次；本例不是 50 次硬阈值或 600 秒 idle 超时。
- 最小修复仅移除 returned-cancel / thrown-abort 两处 session 退役；空响应重试、换 VM、凭据失效、kernel cancel_ack 栅栏与请求 lease 释放保持。真实 SQLite 回归两项修前都在第 51 次取消后 session=null，修后跨 53 次通过；五文件相关回归 255/255，Biome 两文件通过，生产代码 LSP 无诊断。
- 用公开不可变 payload `payload-2026.10.18-cch-sticky` 的 kernel `97959c16…` / CLI `369889d8…`（下载后完整 SHA256 与生产已记录值一致）跑实际 HTTP gateway → protocol handler → FailoverRunner → SQLite → kernel ELF → CLI ELF → loopback HTTP。106 次真实 wire 请求，104 次 200 pong，第 51 / 101 次在上游收到请求后断开客户端，两次均观察到上游连接关闭并恢复 ready_slots。106 次 header 与 metadata、SQLite 及成功日志保持同一出站 `9867105e-0926-4847-99aa-a2f80eb95474`；CLI PID 3146 不变、重启 0、closed_slots=0。
- 本次生产仅只读取证，无部署、服务重启、slot sync/restart/recreate 或配置修改；Node 修复、回归与公开 CHANGELOG 已提交 `b6498403`，未 push、未发布。烟测为本地回环，不等于真实 Anthropic 缓存命中证明。临时脚本与隔离状态已清理；协议契约留在被忽略的 `.trellis/`，本私有记录只单独提交本节，不纳入用户其他既有改动。

## 2026-10-18 取消后保持出站 Session 热修复已上线 / PR #568

- 用户授权先更新生产、再提交 PR。原修复 `b6498403` 隔离到最新主线 `86f0c3d0` 的 `/mnt/x/tmp/vm2api-session-cancel-pr`，候选提交 `c2d05f5a877466c4eb4046a21b20e0c38fb14975`；仅解决 CHANGELOG 与 1.3.192 发布段落冲突，未带入原工作区的用户未提交改动或不相关凭据元数据修复。新分支 `fix/preserve-outbound-session-on-cancel` 已 push，PR [#568](https://github.com/dofastted/vm2api/pull/568) 已创建、未合并，未打应用 tag / Release。
- Hostdzire 原 VERSION 为 `1.3.191`，此次只热更新 `src/lib/pool/failover-runner.mjs`，版本号保持；其旧 SHA256 `268c6dbb…` 与修复父提交完全一致，新 SHA256 `f76f84f3541c0f3c25e74dcd7b093a6fcb368cef3a76745439bd773b2c2154bc` 与 PR 候选文件一致。不把 PR 基线的完整 1.3.192 树宣称为已全部上线。
- 备份 `/opt/vm2api/.deploy-bak-session-cancel-20261018T152206Z-c2d05f5a`（0700），含旧模块、VERSION、routing、状态基线与 2433081344 字节 SQLite 一致快照；证据文件为 0600。连续 3 次 inflight / queued 均为 0 后切换；Node 仅 stop/start 一次，PID `620348 → 988331`，Go 前门 PID `996741` 不变，无回滚。
- 正式 `verify-live.py 1.3.191 --before .../containers-before.txt --auth-mode master --container-policy baseline` 最终退出 0：version / health / panel master / 13 VM / public web / 8 本机容器身份状态 / 真实 200 pong 全 PASS。前两次公网 curl 在 20 秒超时；单独验证显式 SOCKS5h 代理成功后，给正式命令显式设置 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 通过。未修改服务端代码掩盖网络问题，未重试已知失败的密码登录门禁。
- 本机 8 个容器的 ID / 状态 / StartedAt / image、集群 10 个槽与出口容器的 ID / 状态 / image 均保持；13 份 VM 调度 / 手动 / 放置 / policy / 代理 / 指纹字段、routing 与 VERSION 摘要、14 份原生资产摘要均不变。未 sync、重启或重建槽位；AWS 保持 paused，未改 GPT 设置或容器。
- 真实隔离会话：入站 `ce84c1f8-7a3d-4b73-a4af-eda3ef35eb57`，VM `jp-max`，出站 `59b953d5-062e-42f5-b0b8-8d3bc56cb98c`。首轮 `483c5519…` 200 pong；`2cca9085…` 读到真实 text_delta 后断开，attempt 为 499 / cancelled；随后 `e2f0540d…`、`2e5886cb…` 均 200 pong。取消前后及后续两轮 SQLite session / VM / generation / slot_index 完全相同，三条成功日志的出站 Session 一致。
- 当前主线候选相关回归 255/255，Biome 定向格式化无改动；此前实际 ELF 106 次回环验证仍适用于相同模块字节。PR 仅含实现、回归和公开 CHANGELOG 三文件。线上证据在备份的 `apply-result.json`、`live-session-verification.json`、`FINAL-VERIFICATION.json`、`post-state.json`、`state-checks.json`、`verify-live.txt`；本机目录 `/tmp/vm2api-session-cancel-deploy-f2gc7h_g`。临时部署 / 探针脚本与远端暂存已清理，原工作树与私有源码既有改动保留。
- 仍只修复“客户端取消就重建”这一条路径；空响应恢复、sticky TTL、解绑及配置切换规则未变，不宣称完整实现“仅实际切 VM 才换 Session”，也未抓最终 TLS wire 或证明真实上游缓存命中。
- PR CI [39140646473](https://github.com/dofastted/vm2api/actions/runs/39140646473) 的 unit / worker / kernel / web / arm64 五项全部通过，Approval Router、Bugbot、安全审查也全部通过，共 8/8；PR 保持 OPEN，未合并、未开启自动合并、未发布应用版本。

## 2026-10-20 aws-east 集群 VM 迁往 aws-jp

- 按用户授权将 `aws-vm`、`jp-max`、`jp-pro`、`jp-pro2`、`vm-05`、`vm-21` 从 `node-6beb967a`（`aws-east` / `3.15.103.185`）迁到已注册的 `node-7b55028e`（`aws-jp` / `35.72.177.127`）。VM ID、凭证、代理、指纹、机器信息和原调度字段保留；未改应用代码、payload 或版本号。
- 目标 Ubuntu 24.04 / amd64；Docker `29.8.1`、containerd `2.3.6` 与源一致；补齐 2 GiB swap 并持久化。六槽停调度且连续三次 inflight / queued 为零后停止源容器和 Docker/containerd，离线复制 `/var/lib/docker`、`/var/lib/containerd`、`/home/ubuntu/.vm2api`、`/etc/containerd`。
- 冷归档 `3831441227` 字节，SHA256 `fdfc63da82eac8f2eb0f4d856c5e810670e4148ced63594950f67143021c9d39`。恢复时保留全部 xattrs（含 trusted/security）、ACL 和数值 owner；93 个持久文件摘要与 175 项扩展属性摘要完全一致，24 个容器 ID 保留（含历史停止回滚容器）。40 条自定义出口/隔离规则恢复；仅启动原来的 4 个主容器和 5 个出口容器。
- 没有现成的跨节点迁移 API；Node 全局 hold 排空后仅 stop/start 一次，定向修改六份记录的 `node_id`、`runtime.node_id` 及 kernel/worker socket 节点前缀，再恢复原状态与全部调度字段。Go 前门 PID `996741` 未变；18 个 HostDzire 本机容器的 ID、状态、StartedAt、image 均与切换前一致。14 份 VM 的放置、原状态/调度、身份/凭证/代理/policy 和容器 ID 核对全部通过。
- 日本侧 `jp-max`、`jp-pro`、`jp-pro2` 完整服务诊断通过，三次真实 Haiku 测试均 HTTP 200 / pong；另经 Go `8787` 前门固定 `jp-pro` 完成 200 / pong，TLS 公网入口域名经本机 resolve 返回 front-door health ok。`vm-05` 保持原 paused 记录但容器 Up，其 SSH、中继、出口、容器和内核检查均正常，诊断总结果因原 paused 状态返回 `vm_not_running`，不伪称完整诊断通过。`aws-vm` 主容器仍 Created，`vm-21` 仍 stopped / 无容器，未为验收启动这两个停止槽。
- 源 Docker、docker.socket、containerd 已 inactive + disabled，防止旧副本重启形成双活；源节点记录与数据保留，不销毁 AWS 实例。源/目标冷备均在 `/home/ubuntu/migration-20261020/`；控制面证据与原 VM 记录在 `/opt/vm2api/.migration-aws-east-to-jp-20261020/`（0700，证据 0600）。回滚前必须排空并停日本副本，同步迁移后可能刷新的凭证/持久状态，才能恢复原节点放置和启动源副本；不能双活。
- 数据传输曾因本机中转 600 秒超时和 SSH skill 无本地 agent 时仍转发 agent 的问题中断/阻塞；最终用源机临时受限密钥及 `IdentityAgent none` 完成服务器直传（303 秒）。临时密钥、授权行与源 SSH 临时配置已移除；原用户登录密钥保留。源冷停约 03:52 UTC，控制面切换约 04:46 UTC，完整验收与调度恢复约 04:55 UTC；未声称无停机迁移。

## 2026-10-20 vm-19 从 HostDzire 本机迁往 aws-jp

- 用户指定的 `vm-19` 账号核对一致（account UUID `0dd94d41-a7b8-4688-b602-6ea666fd8318`）。从本机 `kin-19`（`320d1a17c671…`）迁到 `node-7b55028e`，新容器 `1955ebfff974…`，镜像 `vm2api/kin-slot-ubuntu-24.04:81e9d304afdf`。VM ID、凭证、代理、机器/指纹信息、policy、seed_policy 和原 running / schedulable=true / schedule_manual=true 全部核对保留；1 GiB 内存及原 CPU/进程限制保留，执行用户按节点约定改为 `1000:1000`。
- 先不停机预传 `.kin` 与独立 guest-bin（79964488 字节，SHA256 `b02217284c9d33c7fff0d89eefee26676d1db4e351830dcc5ba511197d5c77d6`）；仅 vm-19 停调度，等待原在途请求结束并连续三次零 inflight/queued，再停止旧容器、复制最终可写数据。671 个持久文件/链接逐项校验一致；`.claude` 转到节点独立 `claude/` 嵌套挂载，机器 ID 与凭证文件未重置。原生 kernel/CLI 实际 ELF 与目标镜像字节一致。
- 标准远端容器模板不包含本机 persona。此次在标准镜像/网络/布局配置上额外保留五个 persona bind（hardware、DMI、kin-computer、kin-persona、hostname）、独立 guest-bin 及源端点 MAC；先创建停止的目标容器，再定向切换节点/socket 路径并用现有 reload 原地启动。源容器改名 `rollback-vm19-to-jp-20261020`，保持 exited 且 restart=no，没有删除源目录或容器；本次未修改应用源码或主动重启 Node/Go。
- 目标完整 diagnose 通过，内核 20 ready；面板 Haiku 与 Go 8787 前门固定 vm-19 均真实 200 / pong，调度按原值恢复。12 个其他 VM 的放置/状态/调度/身份/代理/policy，以及 17 个其他本机容器的 ID/状态/StartedAt/image 均与冷切换前一致；既有日本主槽 ID/StartedAt 也未变。Go PID `996741` 不变。准备及验收期间另观测到 Node 于 06:35、06:55 UTC 重启（非本次迁移脚本发起），不宣称 Node PID 不变；06:55 重启后重新通过真实请求与最终状态核验。
- 备份和完整证据位于 `/opt/vm2api/.migration-vm19-to-jp-20261020/`（0700），包括原记录、冷文件清单、原容器定义、带 persona 的 destination-body、provision-result、diagnose/test-chat/Go smoke 与 final-verification。目标归档/校验记录在 `/home/ubuntu/migration-20261020/vm19-*`。后续镜像/布局重建必须保留这次 persona binds 和 MAC，不能用缺少这些挂载的标准模板直接覆盖；回滚需先排空停止日本副本并同步最新凭证/持久状态，禁止双活。
- 冷停时间约 06:44:48 UTC，目标容器于 06:52:59 UTC 启动。SFTP 程序层同步较慢使调用方 240 秒与 reload 客户端 150 秒等待超时，服务端仍继续完成；按进程、文件时间和运行状态核实后仅补恢复状态/调度，没有盲目重复创建或重建。
