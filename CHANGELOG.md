# local-src 变更记录

仅记录本地源码与构建改动，不代表已发布、已部署或已同步到运行中的槽位。

## 2026-10-18 — 面板前置契约本地对齐（未发布）

### 实现边界

- 面板 Node 的 `OFFICIAL_CLI_VERSION`、persona 缺省值、OAuth UA 与 PTY fallback 对齐 `2.1.296`；kernel/bootstrap/面板终端环境从该版本源生成。已有显式运行时覆盖机制保留，新进程才读取版本环境。
- 保留现有模式开关：官方家族开启 `official_cc_passthrough` 时，system/tools/messages 的 caller marker、显式 TTL、缺失 TTL 与顺序保留；非透传仍由 Node 清洗并按 last + 倒数第二 user 重写。
- 透传 caller 超四点、thinking / redacted_thinking marker、非法 TTL、5m（含缺失）之后出现 1h，在调度前返回 `400 invalid_cache_control`。不依赖 kernel 降级，不裁剪调用方内容。
- Node 应用重写模板后，仅补自产 marker 的缺失 TTL、按四点预算裁剪自产点；模板显式 TTL 不变。非法最终模板 request-scoped 400，零上游执行、不换号、不冷却账号。
- CLI `wireSystemBlocks` 保留带 billing 的官方 / 子代理 system，不再要求 SDK identity；避免面板已透传的 system 再落入 CLI 自产布局。kernel 继续透明转发，本阶段没有新增 Rust 逻辑修改。
- CLI 使用 `preserveToolCount` 只保护 native 调用方工具前缀，不再把整个 `allTools` 当作 caller-owned。native 调用将 caller tools 放在 `extraToolSchemas` 头部，执行工具数组为空；后续 advisor / CLI 附加工具仍补自有缺失 TTL、参与预算裁剪。caller tool 的缺失 TTL 原样保留。
- native 不再按菜单 TTL 重分类 usage；日志 / 计费保留上游真实 5m/1h 分桶。面板前端组件、配置存量值与运行中槽位均未修改。

### 本地验证与产物

- 改前透传回归两项均失败（tools marker 被删、非法 caller marker 未报错），改后通过。
- Node 最终全量单测：`node --test --test-concurrency=4 --test-reporter=spec test/unit/*.test.mjs`，2917 passed / 8 skipped / 0 failed。先补齐本地缺失的已声明依赖 `croner`（未改 package / lockfile）。
- CLI 定向四文件最终：40 passed / 0 failed（含 caller prefix + owned extra tools 的 TTL 补齐及超额裁剪回归）；kernel `gateway_worker::cli_hop`：10 passed / 0 failed。格式化后 Node 定向回归 358 passed / 6 skipped / 0 failed。
- 最终实际 Node handler → 新构建 kernel ELF → 新构建 CLI ELF → 本地 capture upstream：五项烟测通过，覆盖四个 caller 点混合 / 缺失 TTL、调度前拒绝、透传无点不加点、重写混合 TTL、caller tool 缺失 TTL 原样保留，并核对出站 UA 为 `2.1.296`。连同 classifier / effort / thinking 实际 ELF 回归共 10 passed / 1 skipped（旧 CLI 对照未提供）；自产超额模板另已在前一阶段烟测通过。
- 混合 TTL 日志与计费回归通过：5m 100 token + 1h 300 token 按 Haiku 4.5 缓存写费用 `$0.000725`，不按菜单 1h 合并计费。
- CLI 格式化及调用方工具前缀修正后编译成功，0 missing modules，输出 `/tmp/vm2api-cache-align-cli`，`--version` 为 `2.1.296 (Claude Code)`，最终 SHA256 `847abadc69a4a315840113a7e79efb40657584f06d466b785331865f1e6182a6`。
- kernel release 构建成功，`kin-kernel/target/release/kernel` SHA256 `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977`；仍有既有 `continuation_ttl_secs` 未读 warning。
- 本阶段未覆盖 `bin/cli-node`、`bin/kin-kernel` 或 `share/wrap-cli/` 交付副本；未发布、未部署、未执行 wrap-cli 同步或重启线上进程。本地 fixture 不证明真实账号缓存命中；实际生产版本、槽内 ELF 与端到端账号验证仍待发布部署授权后单独核验。

以下是本阶段之前的 kernel / CLI 初始变更记录，其中“面板尚未实施”描述的是当时状态。

## 2026-10-18 — Claude Code 2.1.296 cache breakpoint 对齐

### 主要改动

- `cli-node` 的版本常量、构建宏及出站身份 / billing 缺省版本更新为 `2.1.296`；运行时 `CLAUDE_CODE_VERSION` 覆盖机制保持不变。
- 不再自动给最后一个 eligible tool schema 添加 cache breakpoint。已有显式 TTL 保持原值，只为自有 ephemeral marker 补齐缺失 TTL。
- 修复 native 请求的 marker 所有权：`preserveSystem` 保留 wire system，`preserveMessages` 保留 wire messages；这两类保留内容不补 TTL、不删除 thinking marker，也不因超过四个 breakpoint 而被裁剪。
- 保留内容中的 marker 先占用四个 breakpoint 的预算，仅对 CLI 自有部分执行剩余预算裁剪与 thinking marker 清理。调用方自身已超过限制时保持原样，不在此层静默修复。
- `kin-kernel` 移除“前面出现 5m，后续 1h 自动降为 5m”的重写逻辑，保留请求中的显式 TTL 与 breakpoint 顺序。

### 验证与产物

- 来源与目标 CLI 源码树的定向测试各为 **38 passed / 0 failed**；目标 kernel 定向测试为 **10 passed / 0 failed**。
- 回归覆盖保留 system/messages 超过四个 marker、缺失 TTL、thinking marker，以及保留内容占用预算后自有 marker 的处理。
- 冻结的六个调用方 marker 烟测通过；已构建 `bin/cli-node` 与 `bin/kin-kernel`，所有权修复后再次重编了 `bin/cli-node`，其 `--version` 输出为 `2.1.296 (Claude Code)`。
- 上述为本地验证，不代表真实上游账号、面板前置契约或线上槽位已完成端到端验证；未执行发布、部署或 wrap-cli 同步。

### 后续：面板前置契约对齐（尚未实施）

- 明确面板传入 system、tools、messages 时的所有权与透传边界，并与 CLI 的 `preserveSystem` / `preserveMessages` 约定衔接，避免前置层再次补写或裁剪调用方 marker。
- 明确显式 TTL、`default_cache_ttl` 与缺省值的优先级，以及四个 breakpoint 预算由哪一层校验；调用方自身超限或 TTL 顺序不合法时，应明确校验 / 报错责任，不依赖 kernel 静默改写。
- 核对面板设置的 `CLAUDE_CODE_VERSION` 是否与本次基线一致，避免运行时覆盖掉源码中的 `2.1.296` 缺省值。
- 补充面板 → kernel → cli-node 的请求体对照验证，确认显式 TTL、缺失 TTL 与 breakpoint 顺序在整条链路上的行为。
