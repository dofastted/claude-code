# cli-node 2.1.284 patch history

本目录是 vm2api 使用的 Claude Code 源码树和构建入口。后续 cli-node 改动只在这里进行；`dist/`、`node_modules/`、`target/` 为本地构建产物，不作为源码基线提交。

## 版本与协议基线

- 源码版本：Claude Code `2.1.284`（`2026-09-28T02:26:10Z`，`2b8ce618c24d`）。最小可出站版本是 `2.1.284`。
- 默认一等 Sonnet 是 `claude-sonnet-5-5`。`max_tokens` 默认和上限都是 128000，`output_config.effort` 默认 `medium`，知识截止 June 2026。三方回退 `claude-sonnet-5`。
- CCH 算法没变：种子 `0x4D659218E32A3268`，低 20 bit，`cch=00000` 条件仍是 first-party 订阅或 Vertex。`cc_prompt_index` / `cc_turn_index` 进入 body 后摘要会变，公式不变。
- 13 个 `anthropic-beta` 没变。stainless 仍是 `0.112.1`。`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` 时出站带 `x-claude-code-prompt-id`，种子默认打开。
- 出站标识为 `claude-cli/2.1.284 (external, sdk-cli)`。运行时 billing 版本来自 `CLAUDE_CODE_VERSION`，缺省用本树常量。

## 2026-09-26 — client cancel ACK

`src/kin/nativeMessagesRunner.ts`：

- `kin_cancel` 触发 AbortSignal 后，显式关闭 `queryKinMessagesWithStreaming()` 的 async iterator。
- 等 provider stream 完成后再发送 `kin_cancel_ack`。
- 目的：避免 Rust 已发出 `kin_cancel`，但 CLI 仍等待当前异步读取，导致 native slot 被错误隔离为 wedged。

配套 vm2api 控制面修复：

- `src/lib/transport/go-worker-client.mjs` 不再在 `message_stop` 后提前关闭 worker response。
- 继续读取到 `kin_job_done` / EOF / trailers，避免正常完成被 Rust 误判为客户端断开并再次触发 cancel。
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

- `/opt/kin-gateway/.deploy-bak-cli-vm13-2.1.280-patched-20260925T190347Z`
- `/opt/kin-gateway/.deploy-bak-cli-vm13-2.1.281-20260925T181202Z`

禁止通过全池同步或删除槽容器验证 cli-node 变更；优先只替换目标槽并重启该槽。

## 2026-09-26 — 2.1.281 本地源码树与构建

- 源码树迁入 `X:\vm2api\patches\claude-code`，版本固定为 `2.1.281`。
- 后续 cli-node 修改只改本目录 `src/kin/`，使用本目录 `scripts/compile-cli-node.ts` 构建。
- 当前构建使用匹配源码依赖树、Bun 1.3.14、Linux x64 baseline，产物为 2.1.281 identity build。
- 取消 ACK 补丁仍为 `queryKinMessagesWithStreaming()` async iterator 的显式关闭，正常完成由 vm2api worker drain 到 EOF/`kin_job_done`。
- 本地 focused tests：35 pass；`cli-node --version` 输出 `2.1.281 (Claude Code)`。
- 尚未将 2.1.281 identity ELF 作为全池版本发布；先单槽 vm-13 灰度。

## 2026-09-26 — 2.1.281 单槽灰度结果

- 使用本目录源码和 `scripts/compile-cli-node.ts` 生成 2.1.281 identity ELF，hash `dd5f5aca...`，BuildID 与 2.1.x baseline 相同。
- vm-13 替换后 kernel ready/wedged 初始为 `20/0`，但 Haiku/Sonnet 普通 pong 均返回 `502 incomplete_response`，三次同号 attempt 后仍无可见输出。
- 该产物已回滚；当前 vm-13 恢复为 2.1.280 protocol baseline + cancel patch，hash `283e0555...`，状态 `ready_slots=20/wedged_slots=0`。
- 失败尚不能归因于 2.1.281 的 CCH 或出站协议；请求仍需继续对比 2.1.281 实际 CLI pipeline、feature 定义和依赖构建输入。
