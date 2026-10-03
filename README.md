# 本地二进制与部署

只留在本机。不要在父仓库 `git add local-src/`，不要打进 release，不要放进 HostDzire overlay 以外的源码包。

`AGENTS.md` 只指向本文件。

## 产物根目录

仓库根 `/mnt/x/vm2api`（Windows `X:\vm2api`）。

| 产物 | 路径 | 是否入库 |
|---|---|---|
| 换票 | `bin/kin-oauth-auth` | 是，只提交 ELF |
| Rust kernel | `bin/kin-kernel` | 是，只提交 ELF |
| 槽内 kernel 副本 | `share/wrap-cli/kin-kernel.bin` | 是 |
| crag kernel | `share/crag/kin-kernel` | 是。单独源码树不在下面三处 |
| cli-node | `share/wrap-cli/cli-node` | 是，只提交 ELF |
| cc-node | `share/wrap-cli/cc-node` | 是 |
| Codex kernel | `bin/kin-codex-kernel` | 是。源码不在本目录 |
| Go worker / egress | `bin/kin-worker`、`bin/kin-egress` | 是。源码在已入库的 `worker/`，release workflow 现编 |

`bin/*` 默认忽略，上面这几个 ELF 由 `.gitignore` 的 `!` 放行。

## 源码目录

都在 `local-src/`，整目录被父仓库 `.gitignore` 的 `/local-src/` 忽略。这里有独立的本地 Git 仓库，当前初始分支为 `cleanup/local-src`；未配置远程、未创建提交。仅在本目录管理源码，不在父仓库暂存本目录。依赖、`target/`、`dist/`、临时文件和凭证由本目录 `.gitignore` 忽略，换行统一为 LF。

| 二进制 | 源码 | 说明 |
|---|---|---|
| `bin/kin-oauth-auth` | `local-src/oauth-auth/` | 编译输入是 `service-entry.cjs`。`service-entry.mjs` 是入口草稿。`src/lib/oauth/auth.js` 仍单独忽略，当前工作区没有这份文件 |
| `bin/kin-kernel` | `local-src/kin-kernel/` | Rust 2024 / 1.98。`cargo build --release` 的缓存位于本树 `target/`；旧 `crates/kin-kernel/target` 已于 2026-10-03 清理 |
| `share/wrap-cli/cli-node` | `local-src/cli-node/` | 唯一工作树，版本 2.1.284。`X:\project\kin-kernel-20slot\claude-code` 是旧来源，不要改那份 |

旧路径 `crates/kin-kernel`、`patches/claude-code`、`.local/oauth-auth-build` 的源码已迁走。`.local/cookie-auth-build` 是旧的 cookie 工具，不是现在的换票；2026-10-03 清理了二进制、`build/`、`dist/` 和 Python 缓存，保留源码与 `.spec` 构建说明。

## 临时文件与测试

2026-10-03 清理了根目录 `.tmp/`（含 1.3.2–1.3.4 部署包及旧解包目录）、7 个 `.tmp-*` 调试脚本、`.tmp-replay/hostdzire-2026-09-22/` 一次性回放数据，以及旧 Rust / cookie 工具构建产物。`docs/benchmarks.zip` 与 `docs/benchmarks/` 逐文件字节相同，仅删除 zip 副本。

正式测试保留：Node `test/unit/`、`test/e2e/`、`test/fixtures/`，前端 `web/src/**/*.test.ts`，Go `worker/` 与 `api-kernel/`，以及本地 CLI / Rust 源码内的测试。Node fixtures 仍被 `acceptance.test.mjs` 引用；`docs/benchmarks/` 是文档引用的题库与结果归档。文件日期、旧版本号和 `test` 命名不作为删除依据。

清理后 `npm run test:unit` 通过：178 个文件，2057 passed / 9 skipped / 0 failed。2328 个保留文件（测试、题库、本地源码、预编译二进制与父仓库 `.gitignore`）的 SHA256 与清理前一致。

## 编译和压缩

### 换票

```sh
sh local-src/oauth-auth/build.sh
```

`npx pkg service-entry.cjs --targets node18-linux-x64`，输出 `bin/kin-oauth-auth`。

整文件 UPX 会坏：pkg 按绝对 `PAYLOAD_POSITION` 读尾部，压缩后偏移对不上，运行是 `Pkg: Error reading from file.`

可用的压法：

1. 留下未压缩 ELF。当前 plain 备份如果还在，是 `/tmp/kin-oauth-auth.plain`。
2. 在 section table 结束处切开（等于 `PAYLOAD_POSITION`）。node18 底包不变时切点是 **46205192**。
3. 把 ELF 里 22 字符的 `PAYLOAD_POSITION` / `PRELUDE_POSITION` 改到固定垫片 **13250000**，以及 `13250000 + PAYLOAD_SIZE`。`PAYLOAD_SIZE` / `PRELUDE_SIZE` 每次构建都会差几个字节（pkg 产物不可复现），以本次 plain 为准。
4. 只压前半：`upx --best --lzma`。
5. NUL 垫到 13250000，再接上原来的尾部。

1.3.78 结果 **14432142** 字节，SHA256 `0c25576b00ac05809f7977a9a1caa7d07fe023b4e3b950e02b0d98ecbe267e5f`。

2026-10-01 #198：`service-entry.cjs` 里打包的 `parseSocksURL` 去掉 IPv6 方括号（socks-proxy-agent 10.1.0 把 `[::1]` 当主机名解析）。本次 `PAYLOAD_SIZE=1107783`、`PRELUDE_SIZE=74383`，结果 **14432166** 字节，SHA256 `123b2e33f4eaa3a6749fd939c756d8bc60bc93e16e0f55fa703756f7c49eb6bd`。`::1` SOCKS5 回环可完成握手，IPv4 对照不变。

2026-10-03 本地出口换票：`normalizeSocks("")` 返回空串（直连），`execute` 改 `input.proxy_url ?? null`，`null` 仍报 `proxy_required`；`service-entry.mjs` 草稿同步。本次 `PAYLOAD_SIZE=1107807`、`PRELUDE_SIZE=74383`，UPX 前半 13105756 字节，结果 **14432190** 字节，SHA256 `ddb668f5ce2e9695d500f442f7c6e15c736bdea34abc518224f1c640b650751c`。`proxy_url:""` 直连到上游（假 code 回 400），`null` 回 `proxy_required`，`[::1]` 死 SOCKS 回 `ECONNREFUSED ::1:1`，坏操作仍退出 1。

2026-10-03 sessionKey 换票 `CLAUDE_WEB is not defined`：`service-entry.cjs` 内联的 oauth-contract 段缺 `var CLAUDE_WEB = "https://claude.ai";`（自 a5ef473 起所有已提交二进制都坏），`resolveOrganizationUuid` 在发请求前抛 ReferenceError。已补回。改 bundle 后先跑 Biome `correctness/noUndeclaredVariables`（独立 biome.json，`files.maxSize` 调大），只允许 `arguments` 误报。本次 `PAYLOAD_SIZE=1107879`、`PRELUDE_SIZE=74383`，UPX 前半 13105068 字节，结果 **14432262** 字节，SHA256 `f24e99feb393b77e32a73a1f0aab5330fdb3b1d5975acec97756245d5b65895c`。死 SOCKS 回 `get_organizations_transport`，`proxy_url:""` 直连到 `claude.ai/api/organizations`（假 sessionKey 回 403 `account_session_invalid`），`null` 回 `proxy_required`，坏操作仍退出 1。回归测试：`test/unit/session-oauth-seam.test.mjs` 的 `binary dials the claude.ai organizations hop`。

拆分提交：main `1bc508d` 只带 `CLAUDE_WEB` 修复。构建时临时去掉 bundle 里 px-local 的 `if (proxyUrl === "") return "";`，在 `/tmp` 下用 pkg 构建。`PAYLOAD_SIZE=1107860`、`PRELUDE_SIZE=74374`，UPX 前半 13104916 字节，结果 **14432234** 字节，SHA256 `2167d3b1964c7d1f29075941563b7febd343109d01cfe105020291d4a3a93aa8`。这个构建里 `""` 仍回 `proxy_required`。PR #216（`fix/px-local-oauth-direct`）用的是上面 **14432262** 那份（px-local + `CLAUDE_WEB`）。当前 `service-entry.cjs` 两处改动都在。

坏操作必须退出 1，正文是 `invalid_operation`。不要用 `subprocess.check_output` 去探它。

```sh
printf '%s' '{"operation":"nope"}' | bin/kin-oauth-auth; echo exit:$?
```

### kernel

源码树里没有 UPX 步骤。现网 `bin/kin-kernel` 是普通动态 ELF，未 strip，也不是 UPX。

```sh
cd local-src/kin-kernel
cargo build --release
install -m 755 target/release/kin-kernel ../../bin/kin-kernel
install -m 755 target/release/kin-kernel ../../share/wrap-cli/kin-kernel.bin
```

Rust 1.98。不要把 `target/` 或 `src/` 提交。

### cli-node

`scripts/compile-cli-node.ts` 只编译，不压缩。目标是 `bun-linux-x64-baseline`，入口 `src/entrypoints/cli.tsx`，版本宏目前是 `2.1.284`。

```sh
cd local-src/cli-node
bun run scripts/compile-cli-node.ts dist/cli-node
```

现网 `share/wrap-cli/cli-node` 是已打包 ELF（没有 section header）。编译脚本没有记录 UPX 参数。换字节之前先对现网文件做 `sha256`，不要凭记忆重压后直接覆盖。

2026-10-01 未发布的 #191 修复在 `services/api/claude.ts` 的 `message_delta` 分支：`isKinQuerySource(options.querySource)` 时不生成交互式 `max_output_tokens` 错误，正常转发上游终结帧。重编后用 `/tmp/upx-5.0.2-amd64_linux/upx --best --lzma <新 ELF>` 压缩，再 `install -m 755 <新 ELF> share/wrap-cli/cli-node`。本次产物 27162364 字节，SHA256 `75a1a7b939553a5deeea98075359a87a2d4132535f71e29ef88df291e79ea55d`。真实 kernel + 此 CLI 的流式 / 非流式本地 SSE fixture 均保留 `max_tokens`、内容和 usage；不等于真实 Anthropic 账号或线上验证。

2026-10-02 取消 / 恢复修复，已发布为 1.3.91（`6a32923` / tag `v1.3.91`）并部署 HostDzire：native cancel 不阻塞共享 reader，匹配 ack 前不复用 slot；早到取消与完整 JSONL 提交有竞态保护；真实错误跨层保留；CLI / 容器分别限次恢复，预算耗尽停调度并通知。native 一 job 一上游执行，不进入交互式 retry / non-streaming fallback；SDK 0.39 SSE 错误从其 decoder cause 恢复原始字段，本地异常与真正断流分开。

- `bin/kin-kernel` 与 `share/wrap-cli/kin-kernel.bin`：SHA256 `7916d51e121b07553fd858f92151912ca9878f6ef25aa776f7fd60d7132704df`。
- `share/wrap-cli/cli-node`：UPX `--best --lzma`，27164016 字节，SHA256 `a32241fb000f9696f846efcc32ab72d07714465edbc16fe914b33f62d65c83cc`。
- `cargo test --release` 108 passed / 1 ignored；CLI classifier / stale-connection 7 passed / 32 assertions；Node 全量 unit 完成且无失败。真实 ELF + 本地 SSE fixture 验证取消关闭上游 / 恢复 slots、真实 400 与 retry-after、断流、CLI kill 后自动 respawn 与后续 pong。2026-10-02 上线后 `POST /v1/messages` haiku 返回 `pong`。备份 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.91-20261001T195651Z`。


1.3.78 没有重编 kernel 和 cli-node。两边 SHA256：

- kernel `3751e35dd7e037b20a0969e1d9bd457ff041817b8b9b20d262d695aa3abefdc7`（12539904）
- cli-node `3202378ad990d0ba098d813e7a2a4b488ba9d0930fa96b5ddbbd16cc144d709a`（28575504）

2026-10-03 auto 权限分类适配的**离线阶段**：Node 识别分类用途并经内部 request_context 传 kernel/native CLI；分类 system/cache、disabled 和原预算保留。已知必须 adaptive 的 XML 加2048且幂等，旧强制工具冲突明确拒绝并保留原模型。kernel JSON 保留上游 id/stop_sequence，错误保留 upstream_code/request-id/retry-after；CLI 握手声明 classifier_request_context。后续用户授权的热更新见下方记录。

| 当前本机产物 | 字节 | SHA256 |
|---|---:|---|
| share/wrap-cli/cli-node | 27164424 | c711a9660d59fd1833e207a34782331f3b65d5d7a0f644880bb26e77e15d7ff1 |
| bin/kin-kernel、share/wrap-cli/kin-kernel.bin | 各12848504 | fccd1a3564c9d24175aeaff1d12ccf3aca31e64cf45d954804df2ced4c45f610 |

CLI 编译 stubbed 0 missing modules，plain 111151232 字节，使用 UPX 5.0.2 `--best --lzma` 压缩。Rust `cargo test --release` 110 passed/1 ignored，release 构建成功（既有 continuation_ttl_secs warning）；Bun native 6文件36 passed/105 assertions；Node unit 181文件2092 passed/9 skipped/0 failed。暂存plain/compressed分别验证，最终交付ELF分类+max_tokens e2e 11 passed，包含真实旧CLI组合。

CLI 全量 typecheck 改前/最终各7287个错误，去掉行号后按错误multiset比较零新增；**全量类型检查仍未通过**。本机fixture不等于真实模型/账户验证；真实“分类器不可用”未闭环。详细记录在 `.trellis/tasks/10-03-auto-mode-adaptation/research/verification.md`，A06 wire-only、A18 PENDING。

构建前备份 `/tmp/vm2api-automode-original-20261003/{cli-node,kin-kernel}`（临时目录可能被清理）。旧CLI hash `78eba26cfc8997a034fa7461b8769b9d110ebb03b343dc176f5a677a6c15daca`，旧kernel hash `7916d51e121b07553fd858f92151912ca9878f6ef25aa776f7fd60d7132704df`。确认备份hash后，在根目录恢复本机ELF：

```sh
install -m 755 /tmp/vm2api-automode-original-20261003/cli-node share/wrap-cli/cli-node
install -m 755 /tmp/vm2api-automode-original-20261003/kin-kernel bin/kin-kernel
install -m 755 /tmp/vm2api-automode-original-20261003/kin-kernel share/wrap-cli/kin-kernel.bin
```

完整回滚还须只撤回本任务Node变更；不能整体恢复共享脏工作区。单独回退ELF时新Node会明确拒绝分类用途。私有源码/target/dist仍不入库。

2026-10-03 后续用户授权 **HostDzire 最小包热更新**：只应用本任务10个Node文件和3份ELF，版本保留远端1.3.92；Node重启一次，6个Claude wrap槽位最终健康、classifier_request_context=true、payload hash与上表一致，容器ID不变，Codex槽位未处理。备份 `/opt/kin-gateway/.deploy-bak-auto-mode-20261002T195539Z`，是最小补丁布局，不直接用于完整overlay的remote-rollback.sh；回滚按manifest只恢复本任务文件，再同步6槽位旧payload。

Windows Claude2.1.285、opus-5-5、auto的单次真实-p对话，通过临时SSH隧道连接HostDzire8787入口（公网预检Cloudflare403）。auto模式可进入，但主会话遭503 pool_unavailable；SDK3次自动重试的网关日志均attempt_count=0，没有工具/分类请求。5个账户额度安全线，vm-05会话并发上限；未放宽这些限制。临时配置/原始日志和隧道已清理，未修改用户持久endpoint；未提交发布。记录在 `.trellis/tasks/10-03-auto-mode-adaptation/research/hostdzire.md`，A18仍PENDING。

## GitHub Release

仓库 `dofastted/vm2api`。tag 必须等于 `v` + `VERSION` 文件，workflow `.github/workflows/release.yml` 会核对。

1. 改 `VERSION`、`CHANGELOG.md`，以及这次要发的已入库代码和 ELF。
2. 源码目录不进暂存区。`git add` 之后再看 `git status -sb`，确认没有 `local-src/`、`AGENTS.md`、`src/lib/oauth/auth.js`、`crates/`、`patches/`。
3. 提交。`git.exe tag vX.Y.Z`，推 main 和 tag。
4. `gh release create`。推 tag 会跑 workflow：核对版本，编 `kin-worker` / `kin-egress`，把仓内 ELF 拷到 release asset，并推 ghcr 镜像。
5. asset：`kin-kernel`、`kin-kernel-crag`、`kin-codex-kernel`、`kin-worker`、`kin-egress`、`kin-oauth-auth`、`cli-node`、`cc-node`。
6. 补发说明用 `gh release edit`，不要为了改正文重新打 tag。同一 tag 换二进制用 `--clobber`。

`gh` 走 `ALL_PROXY=socks5h://127.0.0.1:10808`，先去掉别的 HTTP(S)/ALL_PROXY。Git 用 Windows `git.exe`。

## HostDzire

只走本机 `skills/hostdzire-version-switch` 和 `~/.codex/skills/ssh-skill`。`skills/` 不入库。SSH 是：

```sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire "<cmd>"
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire "<local>" "<remote>"
```

别名 `hostdzire`，`23.80.83.15`，树在 `/opt/kin-gateway`，页面 `https://kin.fkcodex.com`。不要改成 `/opt/vm2api`。

```sh
sh skills/hostdzire-version-switch/scripts/pack-overlay.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire /tmp/vm2api-hostdzire-<VERSION>.tgz /tmp/vm2api-hostdzire-<VERSION>.tgz
python3 ~/.codex/skills/ssh-skill/scripts/ssh_upload.py hostdzire skills/hostdzire-version-switch/scripts/remote-apply.sh /tmp/vm2api-remote-apply.sh
python3 ~/.codex/skills/ssh-skill/scripts/ssh_execute.py hostdzire --timeout 240 "sh /tmp/vm2api-remote-apply.sh <VERSION>"
```

`remote-apply.sh` 会重启 `kin-gateway` 一次。不要再重启。不要动 `kin-gateway-go`。不要 `docker rm` `kin-*`。不要覆盖 `routing.json`、`vms/`、`data/`、`.env`。

`wrap-cli/sync` 只在 `bin/kin-kernel` 或 `share/wrap-cli/cli-node` 的字节和线上不一致时做。版本号相同不算一致，要比 SHA256。

回滚：`sh skills/hostdzire-version-switch/scripts/remote-rollback.sh <BAK>`。1.3.78 的备份是 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.78-20260928T193705Z`；1.3.90 的是 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.90-20261001T124304Z`；1.3.91 的是 `/opt/kin-gateway/.deploy-bak-vm2api-1.3.91-20261001T195651Z`。回滚会再重启一次 Node。

`remote-apply.sh` 不处理 `package*.json` / `node_modules`。新增依赖时（如 1.3.90 的 `https-proxy-agent`）要在 apply 之前先装好，否则重启后 Node 起不来：把新 `package*.json` 传到 `/opt/kin-gateway/.npm-stage-<VERSION>/`，在里面 `npm ci --omit=dev`，再把旧 `node_modules` 和 `package*.json` 挪进 `.deps-bak-vm2api-<旧版本>-<UTC>/`、换上新的，然后跑 `remote-apply.sh`（只重启这一次）。1.3.90 的依赖备份是 `/opt/kin-gateway/.deps-bak-vm2api-1.3.89-20261001T124303Z`；回滚代码不必还原依赖（新依赖是超集）。

上线后核对：`/health` 的 `service` 是 `vm2api`；首页有 `<title>vm2api</title>` 和 `id="root"`；面板登录后 `GET /api/panel/vms`；`POST /v1/messages` 用 `claude-haiku-4-5`、`max_tokens` 32，正文 `Reply with the single word pong.`；`kin-*` 容器 ID 不变且仍是 Up。密钥从 systemd `Environment=` 读，不要打印。

## 本机一键脚本

`deploy/install.sh` 按 GitHub Release 装到 `/opt/vm2api`，不是 HostDzire 的 `/opt/kin-gateway`。控制台用仓内预编译 `web/dist`，镜像和一键脚本都不在目标机跑 `pnpm build`。

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

2026-10-03发布完成：[v1.3.94](https://github.com/dofastted/vm2api/releases/tag/v1.3.94)，包含PR208原生重置、PR209auto适配及PR210版本/web重编；main 5e6df3f541e8aa3cc3db3e48d7a55f0cadaeb78e。两项PR的登录页格式CI已修复，最终main CI/Release工作流全绿。HostDzire完整gate退出0，6运行Claude槽worker更新、配套kernel/CLI hash和能力一致，8容器ID不变，真实对话pong、重置只读查询200。详情research/release-1.3.94.md；真实分类trace限制和A18 USER_REPORTED保留。
