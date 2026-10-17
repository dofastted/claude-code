# local-src 变更记录

记录本地源码、构建和明确标注的部署结果；未标注上线的记录不代表已发布、已部署或已同步到运行中的槽位。

## 2026-10-18 — 获准后完成九槽 2.1.296 补丁部署

- 用户随后明确授权重建 `aws-vm`、`jp-pro`、`jp-pro2`，本条取代下方“未部署”的授权阻塞结论。应用 VERSION 保持 `1.3.187`，部署源码 revision `9dd8fe20`；未 push、未发布 tag / Release、未改 payload manifest。
- 新鲜备份 `/opt/vm2api/.deploy-bak-cc296-authorized-20261017T193611Z-9dd8fe20`，权限 0700；旧备份与旧镜像继续保留。只覆盖 manifest 中 13 个 Node/Python 文件、完整新前端与 Anthropic 母本，不整体替换 `src/lib`，不覆盖生产配置、凭据、VM/DB 或其他二进制。
- Node 单次切换：PID `136935 → 1723282`；Go 前门 PID `996741` 不变。6 个本机 Anthropic 槽定向 sync/restart 全部成功，容器 ID 保留。集群镜像 `vm2api/kin-slot-ubuntu-24.04:d4c829ff783a`；仅获准的 3 个容器按原 Config/HostConfig 重建，保留卷、hostname、用户、环境、网络/IP/MAC 与安全设置。AWS 新容器保持未启动（created）、业务 paused / oauth_revoked；JP-pro2 保持调度关闭。
- 9/9 实际槽内 kernel SHA256 `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977`、CLI SHA256 `244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7`；9/9 配置 `cli_version=2.1.296`。8/8 运行内核 healthy / ready_slots=20，实际 CLI 进程版本环境 `2.1.296`、native slots `20`、entrypoint `sdk-cli`、host refresh `1`；父进程映射新 kernel，无 deleted 旧映射。停止 AWS 采用只读文件/镜像证明，不启动验收。
- 原可调度的 7 槽各执行默认 `1h` 与 caller 显式 `5m` 两例：共 14 次真实上游 HTTP 200 / pong，14 个单次 attempt。Environment 关闭时，Node 出站体没有生成环境块，caller Environment（含空白、续行及 Pacific/Auckland）逐字保留；显式 5m 未被默认 1h 覆盖。设置 5m/1h 保存与回读均 200。恢复后再做 1 次不指定槽的真实请求，自动调度 200 pong，Environment 开启、默认 1h。
- 选择性停调度及恢复均只匹配本次唯一 reason；11 个 VM 的原 status / schedulable / schedule_manual（含字段存在性）与 reason 已核对。身份/代理绑定摘要一致；2 个 GPT 容器 ID / StartedAt 不变，8 个非目标母本二进制哈希不变，其他本机/集群容器 ID 均未改变。
- 生产 308 个 manifest 文件哈希一致；操作机浏览器实际渲染公网控制台，入口 5 个脚本/样式均 200 且与构建包 SHA256 一致。HTML 有边缘 beacon 注入，普通 urllib 资源请求曾被 403；浏览器正常加载，唯一网络错误为第三方 beacon，未当作应用失败或修改站点策略。
- 验证脚本最初以原始 JSON 形状判定恢复，命中 API 补齐的两个 usage_probe 零默认字段及 null Environment map；已通过受支持 API 恢复原有效配置，并核对持久化 `official_full` / 默认 1h。保留真实成功请求日志取证，没有重复发送请求来重跑断言。管理员用户名密码登录门禁未重跑，未改凭据；管理 me / VM API 采用 master 鉴权验证 200。原 `verify-live.py` 的“全部容器 Up / ID 不变”不适用于这次获准的 3 容器重建及原停止 AWS，不宣称完整旧门禁通过。
- 恢复设置的缓存影响已按用户指定日志追溯：19:54:40 UTC 通过 API 恢复 `official_full` 后，19:55:20 的 `8eb2b7d6-574a-48f0-b07f-7f643562bf65` 出站第 4 个 system 块由 43 字符短 Environment 变为 16893 字符完整续文/Environment，并增加该块 1h marker；同账号、VM、session、TTL、入站 system 与 tools 均未变。缓存 read `107869 → 14611 → 114710`，中间 creation `100099`，恰有 `14611 + 100099 = 114710`，下一条 `eb0bd1f1-f7e7-4388-8d4e-ac8e6fb5b742` 已复用重建前缀。这是本次在线配置验证/恢复产生的瞬时缓存干扰，不归因于随机丢缓存；后续避免在真实流量下切换全局 persona 做验证。
- 验证边界：线上观测覆盖 Node 出站对象、实际 ELF/进程、内核健康与真实上游响应；未抓取最终 Anthropic TLS wire，也不据响应层 cache_read=0 推断上游缓存状态或宣称缓存命中。完整私有证据在新鲜备份的 `deployed-runtime-verification.json`、`live-behavior-verification.json`、`post-resume-verification.json` 与操作状态中；回滚只恢复部署文件及必要调度/runtime 字段，不回滚自然刷新的凭据或整份 VM JSON。

## 2026-10-18 — 九槽部署准备与备份（未部署）

- TTL 设置 / Environment 关闭修复代码已原子化提交（`7ad99436`、`f63bac9d`、`9dd8fe20`）；本地 Node 全量 2922 passed / 8 skipped，前端契约 11 passed，新版 CLI/kernel 最终压缩 ELF 捕获 10 passed / 1 skipped。
- 新 CLI 使用 UPX 5.0.2 压缩，27172956 字节，SHA256 `244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7`；kernel 12839808 字节，SHA256 `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977`。仅暂存，不覆盖本地交付副本或生产二进制。
- 准备了 39825220 字节最小补丁包，SHA256 `79e21e0cffd29d3fd941814e16f018ef39fc90de9f4bac71800fce699461457d`；远端 `/tmp` 的 checksum / Node syntax / CLI version / bundled loader 参数校验通过。此包不能直接给整体替换 `src/lib` 的 `remote-apply.sh` 使用。
- 现网 9 个 Anthropic 槽（6 本机 + 3 集群）已完整备份；3 个集群槽为只读镜像二进制，更新需要容器重建。未收到明确授权，按保守选项保留运行版本，**未执行控制面或任一槽位切换**，未重启 Node/Go/槽，未重建容器，未 push / Release / 同步。
- 备份 `/opt/vm2api/.deploy-bak-cc296-1.3.187-20261017T191024Z-9dd8fe20`，权限 0700；原 kernel/CLI、配置、SQLite、容器和调度状态已记录。8 个运行中 Anthropic 内核 healthy / 20 ready slots；原暂停的 aws 保持停止。全部原进程、二进制、源码、web 和状态保持不变；这不是新版上线验收。具体清单和授权阻塞见 `README.md` 最新记录。

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
