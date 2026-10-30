# cli-node auto 分类器

## 2026-10-31 — auto mode 提醒对齐 2.1.310

- `getAutoModeFullInstructions` 改成 2.1.310 的一次提醒（Bias toward working…，含丢弃未提交改动前先 `git status`）。删掉 `Auto mode still active (see full instructions…)`。
- 已经发过 `auto_mode` 且还没退出时不再追加。短提醒重复进上下文后，模型会把 `<system-reminder>Auto mode still active…</system-reminder>` 刷回对话。


## 2026-10-26 — 对齐 2.1.310
- 请求、判定、模型优先级和白名单见仓库根 `CHANGELOG.md` 同日记录。源码在 `src/utils/permissions/yoloClassifier.ts` 与 `classifierDecision.ts`。
- stage 2 refusal 的回归测试是 `src/utils/permissions/yoloClassifier.test.ts`。构建和部署边界以根记录为准：本机文件已换，运行态和 payload pin 没有更新。

# cli-node 2.1.296

本目录是 vm2api 使用的 Claude Code 源码树和构建入口。后续 cli-node 改动只在这里进行；`dist/`、`node_modules/`、`target/` 为本地构建产物，不作为源码基线提交。

## 版本基线

- 源码版本：Claude Code `2.1.296`。
- Native Kin preserves caller wire system/messages/tools and their cache markers; only CLI-owned markers may be normalized or capped. `wireMessages` skips CLI message-breakpoint insertion, and the kernel forwards explicit caller TTLs unchanged.
- Default TTL applies only to Kin-owned markers; caller-owned TTL-less markers keep the official implicit 5m semantics.

- Kin caller tools are now preserved with caller system/messages; TTL-less caller markers are no longer rewritten to panel `1h` or trimmed to the CLI's four-marker budget.
- CCH is sealed on the SDK's final JSON body only when the panel switch is enabled. Disabled requests keep exactly `cch=00000;` (five zeroes); billing always carries the parameter. Enabled JSON is compacted before scanning, without stale `Content-Length`, and only billing's CCH is projected/replaced.

## 2026-10-18 — 关闭 CCH 固定五零（未发布）

- 最新要求取代下方旧的“关闭时剥除”行为：关闭固定 `cch=00000;`，不计算摘要；开启仍在最终 SDK fetch 计算真实五位摘要。fetch 显式读取开关，不能以是否出现五零来推断开启。
- 移除正文构造阶段旧 CCH 门控，统一补齐五零；保留版本、entrypoint、prompt ID / index 与 caller system。密封只处理 billing 参数，提示词中的 `cch=00000;` 不变。
- 实际 kernel / CLI ELF 捕获 false → true → false 为 `00000` / `52572` / `00000`，同一 CLI PID、0 重启；五文件 38 passed，0 missing modules。候选 `/tmp/vm2api-cch-off-zero-cli` SHA256 `574d822cd2d18cfa5a73310bfac37460688becf2ae94eccc7a9b0dedf64ab400`，未替换交付副本或部署。

## 2026-10-18 — 统一 CCH 与动态面板策略（未发布）

- `kernel.json.cch_enabled` 默认开启，每个请求热读；开启时 billed wire system 缺少 CCH 也补占位，关闭时剥除旧值。试用 / 非订阅凭据不再阻止固定 billing 字段生成，最终紧凑 SDK JSON 密封逻辑保持。
- 自产 billing 使用稳定会话 prompt ID 与固定 `0/1` 索引，不再按消息轮次移动；保留已有 billing 的版本与其他参数。标准出站版本仍为 `2.1.296`，Go 的 `2.1.293` 不在此处变更。
- billed 官方 / 子代理 wire system 不要求 SDK identity 才保留；非 billing 正文与 caller cache marker 不改写。
- 定向五文件 39 passed；已编译 `/tmp/vm2api-dynamic-config-cli`，0 missing modules。实际 Node → kernel → CLI → 回环上游捕获验证 CCH 开关、缺失补写、非订阅 billing、内置模板无 scope 与固定 UA；未用真实 Anthropic 账号，未替换交付副本、未发布或部署。

# cli-node 2.1.293

本目录是 vm2api 使用的 Claude Code 源码树和构建入口。后续 cli-node 改动只在这里进行；`dist/`、`node_modules/`、`target/` 为本地构建产物，不作为源码基线提交。

## 版本基线

- 源码版本：Claude Code `2.1.293`。最小可出站版本是 `2.1.293`。
- 一等 Haiku 是 `claude-haiku-5-5`。原生 1M，不走 `context-1m` beta，没有 gateway id。`max_tokens` 默认和上限都是 128000，默认 effort `medium`，知识截止 June 2026。三方回退 `claude-haiku-4-5`。
- `thinking.budget_tokens` 改成 adaptive。`thinking.type=disabled` 只在 effort 为 high 及以下保留。
- 价格 haiku_55：$0.10 / $0.50，缓存写 5m $0.125、1h $0.20，缓存读 $0.01。prompt 超过 10 万 token：输入 $0.50、输出 $2.50、缓存读 $0.05。
- CCH 种子仍是 `0x4D659218E32A3268`。13 个主 Messages beta 没变。默认 Sonnet 仍是 `claude-sonnet-5-5`。
- 出站标识为 `claude-cli/2.1.293 (external, sdk-cli)`。运行时 billing 版本来自 `CLAUDE_CODE_VERSION`，缺省用本树常量。

## 2026-10-12 — 离线兼容性补齐

- 普通请求与 native `wireBody` 共用 `assembleMessageRequest()`。thread continuation 的字段省略、显式空值、0、null、扩展 thinking 字段和 caller cache marker 保持原值。
- 公共 5.5 不再被 canonicalization 折叠；effort 支持 `xhigh`、`med`、`ultracode`。未知 `--effort` 只警告并忽略。
- `--fallback-model` 按顺序去重、过滤 allowlist、最多 3 个；每个 user turn 从 primary 重试，不持久化 fallback。
- `--safe-mode` 按官方逐功能表禁用用户自定义内容。显式 `--mcp-config`、managed policy 和 hooks 保留；`--bare --add-dir` / `--plugin-dir` 的原有显式入口保留。
- `--restricted` 拒绝 remote/ssh 和 bypass；文件工具拒绝工作目录外路径，包括解析后的 symlink。
- `--proactivity` 映射权限模式：`ask`、`default`、`proactive`。显式 permission/inherit/skip/agent mode 优先；restricted 或策略禁用时不能启用 bypass。KAIROS 模块仍不存在，默认编译不再引用它。
- 非 billing 身份补齐 request class、background `x-app`、metadata sanitizer 和 512 字符上限。自定义 billing、CCH、prompt UUID/index 和 parent/root session 归属未改，不自动生成官方 prompt-id。

离线验证：

- CLI 定向测试 48 pass / 0 fail；共享 beta 测试 11 pass / 0 fail。
- 编译后的 CLI：help、未知 effort、非法 JSON schema、restricted bypass、相同 fallback 和非法 autocompact 均按预期退出。无凭据时请求在 `/login` 前停止。
- 已安装 SDK 的 fetch override 截获 10 个 stream/nonstream 请求，0 个网络请求。beta 进入 `anthropic-beta`，自定义 billing、identity、thread、credit、xhigh 和 thinking 扩展字段按预期保留。
- restricted 权限函数：目录内 allow；父目录和 symlink 逃逸 deny。

本机产物，未执行 `wrap-cli/sync`，未重启槽：

- plain `dist/cli-node`：111204480 字节，SHA256 `6fe648bf1b4969a4f5ada1760d502a77af8bc6f9922d14c368d68739cf60d164`。
- UPX 5.0.1 `--best --lzma` 的 `dist/cli-node.upx` 与 `share/wrap-cli/cli-node`：27172732 字节，SHA256 `c1316b7dd68490f56dde84ed1c7591591899cded321174a45f7cf954ea48465b`。`--version` 为 `2.1.293`。
- 覆盖前的 `share/wrap-cli/cli-node` 是 payload pin `643f55232ec1950275daaa40adefd46f5d695eba613c622d66e0e8c1968a402c`。

## 2026-09-26 — client cancel ACK

`src/kin/nativeMessagesRunner.ts`：

- `cancel` 触发 AbortSignal 后，显式关闭 `queryKinMessagesWithStreaming()` 的 async iterator。
- 等 provider stream 完成后再发送 `cancel_ack`。
- 目的：避免 Rust 已发出 `cancel`，但 CLI 仍等待当前异步读取，导致 native slot 被错误隔离为 wedged。

配套 vm2api 控制面修复：

- `src/lib/transport/go-worker-client.mjs` 不再在 `message_stop` 后提前关闭 worker response。
- 继续读取到 `job_done` / EOF / trailers，避免正常完成被 Rust 误判为客户端断开并再次触发 cancel。
- `test/unit/go-worker-client.test.mjs` 覆盖 `message_stop` 后延迟 EOF。

## 构建

```bash
bun install --frozen-lockfile
bun run scripts/compile-cli-node.ts /tmp/cli-node-2.1.281-cancel-ack
```

编译脚本固定：

- Bun Linux x64 baseline，避免 AVX2/BMI2 CPU 差异。
- `autoloadDotenv=false`。
- `autoloadBunfig=false`。
- `autoloadTsconfig=false`。
- `MACRO.VERSION=2.1.281`。
- production define 与仓内 `DEFAULT_BUILD_FEATURES`。

## 验证记录

- cli-node 定向测试：23 pass。
- vm2api worker 定向测试：21 pass。
- vm2api 2.1.280 exact baseline + iterator patch + EOF drain 的 vm-13 定向验证：
  - Haiku/Sonnet `pong`：HTTP 200。
  - 母子并行：`ready_slots` 20 → 18。
  - 子请求主动断开后，母请求正常收到 `message_stop`。
  - 最终 `ready_slots=20`、`wedged_slots=0`。
- 线上当前仍是 2.1.280 protocol baseline 的 patched ELF；2.1.281 identity build 需使用本目录重新构建后再单独灰度。

## 回滚

每次单槽发布前备份 `.kin/cli-node`。当前已知备份：

- `/opt/vm2api/.deploy-bak-cli-vm13-2.1.280-patched-20260925T190347Z`
- `/opt/vm2api/.deploy-bak-cli-vm13-2.1.281-20260925T181202Z`

禁止通过全池同步或删除槽容器验证 cli-node 变更；优先只替换目标槽并重启该槽。

## 2026-09-26 — 2.1.281 本地源码树与构建

- 源码树迁入 `X:\vm2api\patches\claude-code`，版本固定为 `2.1.281`。
- 后续 cli-node 修改只改本目录 `src/kin/`，使用本目录 `scripts/compile-cli-node.ts` 构建。
- 当前构建使用匹配源码依赖树、Bun 1.3.14、Linux x64 baseline，产物为 2.1.281 identity build。
- 取消 ACK 补丁仍为 `queryKinMessagesWithStreaming()` async iterator 的显式关闭，正常完成由 vm2api worker drain 到 EOF/`job_done`。
- 本地 focused tests：35 pass；`cli-node --version` 输出 `2.1.281 (Claude Code)`。
- 尚未将 2.1.281 identity ELF 作为全池版本发布；先单槽 vm-13 灰度。

## 2026-09-26 — 2.1.281 单槽灰度结果

- 使用本目录源码和 `scripts/compile-cli-node.ts` 生成 2.1.281 identity ELF，hash `dd5f5aca...`，BuildID 与 2.1.x baseline 相同。
- vm-13 替换后 kernel ready/wedged 初始为 `20/0`，但 Haiku/Sonnet 普通 pong 均返回 `502 incomplete_response`，三次同号 attempt 后仍无可见输出。
- 该产物已回滚；当前 vm-13 恢复为 2.1.280 protocol baseline + cancel patch，hash `283e0555...`，状态 `ready_slots=20/wedged_slots=0`。
- 失败尚不能归因于 2.1.281 的 CCH 或出站协议；请求仍需继续对比 2.1.281 实际 CLI pipeline、feature 定义和依赖构建输入。
