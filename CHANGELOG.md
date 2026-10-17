# local-src 变更记录

仅记录本地源码与构建改动，不代表已发布、已部署或已同步到运行中的槽位。

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
