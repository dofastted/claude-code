# local-src 变更记录

记录本地源码、构建和明确标注的部署结果；未标注上线的记录不代表已发布、已部署或已同步到运行中的槽位。

## 2026-10-25 — cli-node 2.1.303 隔离构建（未发布、未部署）

- 源码基线 `ed9fd21`。缺省 thinking 补 `adaptive/omitted`，缺省 effort 补 `medium`；`agent:kin` 不写 `cc_is_subagent`。空 system 补官方 harness 与 guidance，断点分别为 `1h+global` 和 `1h`。beta 按官方 14 项顺序补齐；setup-token 不注入 `claude-code` session beta。版本与出站 UA 缺省为 `2.1.303`。
- 构建从 `ed9fd21` 干净导出，不使用脏工作树。外部依赖固定为 `src/lib/protocol/claude-code-betas.mjs`，SHA256 `0dd4d8d920968596db62d6a7edfbb5a9cbc505d38269f727389f812e98588da4`。快照缺少已提交代码所需的 `SYSTEM_PROMPT_REPORTING_OUTCOMES` 导出，构建只补这一项。
- plain 111237248 字节，SHA256 `d6fd3a919bf3016756a1120f072ccc987235c5bb244dd2000d461b08a3d5ed9d`。UPX 5.0.2 `--best --lzma` 后 27177428 字节，SHA256 `2c1b271df033e23830cc8cdc0181fab60d4de96ff8cf4cd406651aecd9b5ae9f`。`upx -t` 通过，`--version` 为 `2.1.303 (Claude Code)`。
- 产物已替换 `vm2api/share/wrap-cli/cli-node`。二进制仍由 gitignore 排除，payload 未更新，线上槽位未部署。

## 2026-10-24 — CLI 最终出站请求头回传（未发布、未部署）

- 原生 job 通过 AsyncLocalStorage 隔离请求头观察者；SDK 最终 fetch 前、CCH 与 Content-Length 处理后采集，不重新组装请求或修改正文。凭证及未知自定义头值在 CLI 内先脱敏，再通过已有 `stream_event` 任务通道回传。Rust 不改动、不重编。
- Node 消费内部事件、写 debug 的 `outbound_headers` 与 `outbound_headers_source=cli_final`，不转发客户端、不触发提交/TTFT/上游 idle 计时；每跳清空旧快照，旧 CLI 未回传则 unavailable。worker envelope 头另存，正文仍是 envelope；面板区分最终头、中间头及旧日志。不是 TLS 抓包，不含 HTTP 实现后加的 Host / HTTP/2 伪头。
- 为避免携带主源码树其他 WIP，在 `.local/outbound-headers-build.q1VRY4/cli-node` 从 `feat/outbound-303@f996e88` 隔离导出，仅追加观察者；该基线已含尚未上线的 `84e6c16` 请求头补齐修复。新 ELF `/tmp/vm2api-final-outbound-headers-cli` SHA256 `2f65c444d651b0572baf5f72e81e6253720be0fe6e9f7313bbf38261a7f03425`，bun-linux-x64-baseline，0 missing modules。
- CLI 观察者单测 2/2；Node 定向 96/96；面板来源显示测试 3/3；真实 Node → 现有 kernel ELF → 新 CLI ELF → 本地上游 5/5，通过日志值与上游实收头逐项比对，以及 296 三档对 `84e6c16` 的 body 字节回归。未与真实 Anthropic 账号联调，未替换交付模板、发布 payload、推送或修改线上槽位；收尾按两个仓库分别提交本次源码，不包含其他 WIP。

## 2026-10-23 — cli-node 请求头与交互 CLI 对齐（未部署）

- `getUserAgent` 与 `officialCliUserAgent` 的出站入口固定为 `cli`；不改 `CLAUDE_CODE_ENTRYPOINT`，避免影响工具/运行模式开关，保留 agent-sdk、client-app 与 workload 后缀。
- SDK fetch 统一发送 `Accept: application/json, text/event-stream`、`Accept-Encoding: gzip, br`；客户端的毫秒 timeout 转成秒头，保留自定义头覆盖。最终字符串 / 字节请求体在 CCH 完成后计算 `Content-Length`，不提前计算 envelope 长度，不向 SSE 响应填假长度。
- 真实本地 HTTP + SDK 回归覆盖多字节正文、最终 CCH/长度与 gzip JSON / Brotli SSE 解压；不根据 API-key 样本删减 OAuth/能力 beta。当前生产不自动切换，需后续部署新 CLI 才会生效。
- 本地编译压缩完成：源码提交 `30b1f60`，生产兼容构建固定在同仓工作树 `feat/outbound-303@84e6c16`，未带入主工作树的其他 WIP。目标 `bun-linux-x64-baseline`，0 missing modules；UPX 5.0.2 `--best --lzma` 后为 27175592 字节（plain 111220864 字节），`upx -t` 与压缩 ELF 的真实链路 e2e 6/6 均通过。
- 构建产物在 `~/.vm2api-private/replay-303/bin/`：`cli-node.headers-84e6c16.plain` SHA256 `91402b18768a6c1ce4f78d9dbd779cd5e519906f952f1781213a8649ee31a84a`；`cli-node.headers-84e6c16.upx` SHA256 `4fb46a0c28bae1675923c0d88ba6a98495e4b1a427a4e1bd260cb80ed2e18e90`。未提交二进制、未覆盖交付模板、未 push、未部署。

## 2026-10-18 — 协议页集中设置与 CCH 关闭固定五零（未发布）

- 按用户最新要求，原生 sticky 空闲超时从账号池移到设置 → 协议，与 CCH 开关集中；保存 / 放弃 / 刷新与 kernel.json 热投影保持。关闭 CCH 不再移除参数，固定发送 `cch=00000;`（5 个 0），仅开启时计算真实摘要。
- CLI 正文统一生成五零占位，最终 SDK fetch 显式读取面板开关决定是否 seal；移除旧的“正文是否包含 CCH”订阅门控。密封与 hash 投影只定位 billing 的 CCH，不替换出现在提示词里的相同字面量。
- 真实 Node finalized envelope → kernel ELF → 新 CLI ELF → 回环上游三轮捕获：关闭 `00000`、开启 `52572`、再关闭 `00000`；CLI PID `66467` 不变、重启 0，UA / 其它 billing 参数及提示词字面量保留。隔离浏览器确认协议页双控件保存 / 放弃 / 刷新，账号池无重复控件，390px 无横向溢出；保存值 false / 300 已投影到 kernel.json。
- Node 定向 48 passed，billing 定向回归修正后 9 passed；CLI 五文件 38 passed / 152 assertions，编译 0 missing modules；web 41 文件 / 370 passed，TypeScript + Vite build 成功。
- 候选 CLI `/tmp/vm2api-cch-off-zero-cli`，SHA256 `574d822cd2d18cfa5a73310bfac37460688becf2ae94eccc7a9b0dedf64ab400`。本轮未修改 Rust 行为、未替换交付副本、未发布部署或同步 / 重启现有槽；回环 fixture 不等于真实 Anthropic 账号验收。

## 2026-10-18 — 动态 CCH / sticky slot 设置与 #536（未发布）

- 阅读本地 2.1.296 changelog 后补齐控制面与私有 CLI/kernel：`compatibility.cch_enabled` 默认 true；`inference.session_idle_ttl_seconds` 默认 600，范围 1–86400。保存投影 `kernel.json`，设置变更无需重启。Go 不承载 panel routing schema，OAuth / 遥测的 2.1.293 与 Messages 的 2.1.296 标准 UA 各自保留。
- CCH 在 billing 中统一补写 / 移除，不按订阅状态分流；native 只在最终紧凑 SDK JSON seal。自产 billing 使用稳定会话 prompt ID 与固定 0/1 索引；billed 官方 / 子代理 system 保留。修复 #536 的内置 official / official_full 默认 scope 与旧模板 agent 回填，caller / custom 显式 scope 不全局删除。
- kernel 通过显式 `KERNEL_CONFIG` 把同一配置路径交给 CLI；sticky idle 按文件变化热读，保留上次有效值，活动任务不回收，修改期限不重置最后完成时间。真实 ELF 的 JSONL 分配捕获确认同会话先复用 `s03`，600 → 1 秒后换为 `s04`；默认巡检约 2.5 秒，CLI PID 不变、重启 0、关闭槽 0。
- Node 定向 254 passed；CLI 五文件 39 passed / 152 assertions / 0 missing modules；Rust release tests 118 passed / 1 ignored，release build 成功（既有 continuation_ttl_secs warning）；web 41 文件 / 370 passed，最终 TypeScript + Vite build 成功，界面机械检查无发现。Go worker `go test -race ./...` 与 api-kernel `go test ./...` 均通过。
- Node 全量并行回归有 1 项时序失败：`pool-scheduler` 的 40ms 冷却 / 200ms 等待用例在并行编译下失败，单独执行 42.9ms 通过。没有修改该调度器、放宽时限或把隔离通过说成全量通过。
- 隔离真实 panel API 验证新键缺省值、15 个非法输入、86400 边界、kernel.json 投影与混合非法 patch 零部分保存；真实浏览器验证 CCH 保存 / 刷新、空闲秒数放弃回到 600、保存 300 后刷新及投影一致，桌面 / 390px 页面无横向溢出。真实 Node handler → kernel → CLI → 回环上游完成 6 次捕获，覆盖最短 official_full 无 scope、非订阅 billing、CCH 开关 / 缺失补写、固定 UA 与原生空闲热回收。
- 已验证候选 CLI：`/tmp/vm2api-dynamic-config-cli`，SHA256 `afc21db970642ef73999b66c3e09795c79bded6f365223c3cd7f0b74bf533fef`；kernel：`kin-kernel/target/release/kernel`，SHA256 `97959c164721be03478b057473d1da8206ee42ddae609dbf3a85327915a824b7`。未覆盖交付副本、未修改 payload manifest、未发布、未部署或同步 / 重启现有槽；未用真实 Anthropic 账号。

## 2026-10-18 — v1.3.188 已部署、合并并正式发布

- 用户本轮明确选择“批准替代门禁并继续发布”，允许本次以真实 master 管理鉴权 + 原状态保留验收替代陈旧用户名密码检查；没有重置或修改管理员凭据，不声称密码登录通过。`verify-live.py` 新增显式 `--auth-mode master --container-policy baseline`，默认仍为 password / up；授权模式在最终 1.3.188 候选上真实退出 0。
- 旧 CI 失败 run `39067288984` 属于 PR #512：`crs-persona.mjs` 被写成字面量 `@file:/workspace/...`，Node 语法错误；ARM64 镜像构建完成但控制面启动失败。该内容不在本次候选。验收期间 main 又合入 Desktop 修复 PR #518（`c0a30e14`），通过普通 merge 纳入候选，没有重写既有历史；组合定向回归 152/152，最终 CI `39088593405` 的 unit / worker / kernel / web / arm64 全成功。
- PR [#517](https://github.com/dofastted/vm2api/pull/517) 已于 02:08:24 UTC 合并。合并提交 / tag `v1.3.188` = `0629424e63cdcf26301b155f609defc7ba63d878`；已验收候选 `f7e224e3f4672cc1e9dc74ba66eee676b565adcf` 与合并提交 tree 完全一致。仅在核对 VERSION、tree、精确 PR head 和 main 基线后创建新 tag，未 retag / force push。
- 发布 [v1.3.188](https://github.com/dofastted/vm2api/releases/tag/v1.3.188) 已公开，非 draft / prerelease，且为 latest；工作流 [39089080369](https://github.com/dofastted/vm2api/actions/runs/39089080369) 的 linux-amd64 / image-amd64 / image-arm64 / manifest 四 job 全成功。正式说明来自该版本 CHANGELOG，包含 #511 与升级范围；剩余注释仅有 runner 迁移提示和 `KIN_OAUTH_AUTH_BIN` 路径名称触发的静态告警，不含密钥值，未为消除告警改行为。
- Native 资产快照 [payload-2026.10.18-cc296](https://github.com/dofastted/vm2api/releases/tag/payload-2026.10.18-cc296) 已发布为非 latest prerelease，tag 指向此前已合并的 main。11 个资产的服务端摘要 / 大小均与本地已验证文件匹配；只更新 kernel `983575591514f771fdef6a2445bdb76db390b177874c533b0eb7562cd04f7977` 和 CLI `244ef884ce427feba8f0eec6ce7957045c2226e103fb0bec2d7df2949f5bc6c7`，其他 9 项不变。清单提交 `9cb5058c` 已纳入 PR，真实 fetch-payload 下载并校验 12 个安装路径通过；旧资产未覆盖。
- 正式 Release 的 11 份附件已全部实际回下载：服务端摘要 = 本地 SHA256、大小一致，ELF 9 份 amd64 / 2 份 arm64；7 个 opaque 附件均匹配 manifest。双架构 OCI index `sha256:b36b42e75e0e5a5c4a9098fc56acdebf99b010f60dbd50243945d6965c4242a3`；amd64 `sha256:9b20f4dafd586553091a119de86022d90838d310ef464188de16c28ef710e3b2`，arm64 `sha256:dc0d9ac222f2eaa256f069af7883ecff83d6225e4f7bab4216a4136a26398068`。直接 Registry 验证两个单架构 tag 与 index 对应且 latest = v1.3.188。
- 完整候选按 310 个运行文件 + 286 个前端文件安装并逐项校验，不覆盖 `src/config`、VM、DB、.env。初次 1.3.188 备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.188-20261018T014826Z`，Node `3790730 → 4076645`；纳入并发 main 后只改变两份身份识别模块，最终备份 `/opt/vm2api/.deploy-bak-vm2api-1.3.188-20261018T020306Z`，Node `4076645 → 4178362`。两次候选切换各仅一次受控 stop/start，Go PID `996741` 始终不变。
- 全部本机/集群容器 ID、状态、StartedAt、VM 调度与 manual 字段、routing 哈希与二进制哈希均保持各自基线；未 wrap-cli sync、未重启或重建槽、未修改代理/身份/凭据，AWS 继续停止、JP-pro2 继续调度关闭。原生文件在切换前已与新 manifest 完全相同，所以不重复更新。
- 最终真实三回合均 200 pong，同一个出站 session，attempt `[400,200] / [200] / [200]`；请求 `faaf2933-aa82-4fb5-af10-91b54a4ca9b7`、`90c0be02-db6c-4fc3-9985-762827412db0`、`c653a2b3-eea3-471b-9b8a-e651b31be07b`。8 个运行内核 healthy、无关闭/恢复中的槽；配置为 20 native slots / CLI 2.1.296。
- 附加验收最初错误要求 `ready_slots=20`（全部空闲），与 vm-10 正常在途请求 `b4fd2fe5-e3aa-47e7-bfc3-a2c80e17cdf2` 重叠；该请求随后 200，内核无 CLI 重启。源码/既有测试确认 ready_slots 是空闲容量，已改用真实 healthy / closed / recovering 与配置容量检查，不重启健康槽来跑绿。该轮已完成请求从日志恢复，不重复发送；对最终并行合入的新候选另做独立新会话验收。
- 操作机真实浏览器登录界面渲染正常，无横向溢出；5 个入口脚本/样式 200 且 SHA256 等于候选。完整 Source/health/gate/asset/registry/UI 证据已保存到最终备份，含 `apply-result.json`、`real-search-and-health-verification.json`、`live-gate-approved-mode.txt`、`release-assets-verified.json`、`registry-verified.json`、`public-ui-verified.json`、`final-state.json`。未抓最终 TLS wire，不把 Node 对象当作最终 wire。
- 原工作区 main 未被强制 reset/rebase，保留原有无关提交和私有源码脏基线；当前发布源树位于 `/mnt/x/vm2api-wt-search-repair-188`，GitHub tag 指向已合并的提交。独立私有记录只提交本条和 README 新增段，不提交密钥或构建产物。

## 2026-10-18 — 搜索历史重复 400 热修复已上线，PR 待门禁

- 用户明确要求先部署，再 PR / 合并 / Release。已将修复 `8594008d` 的两份 Node 模块上线，应用 VERSION 仍为 `1.3.187`；此次没有替换 web、kernel/CLI 或其他二进制，没有同步/重启/重建槽容器，没有修改生产配置、凭据或调度。
- 新鲜备份 `/opt/vm2api/.deploy-bak-search-repair-20261018T010742Z-8594008d`（0700）；包含原模块、VERSION、SQLite 一致快照及完整容器/调度/配置/二进制哈希基线。Node 此次单次切换 PID `1723282 → 3790730`，Go PID `996741` 不变；全部本机/集群容器 ID、状态、StartedAt 与 VM 手动/调度字段一致，routing 与母本二进制哈希一致。
- 线上隔离真实会话三轮均 200 pong，attempt 状态依次 `[400,200] / [200] / [200]`，均为 VM-13、同一个出站 session。请求 ID：`f4f3bcfe-8a6a-4b3a-9b3e-2985f318920e`、`8da810fa-97bb-43ee-a732-edfaab32cb8a`、`d8ead314-2d47-4cfa-a6f6-69efba11566f`；未修改全局 persona/TTL 验证。首轮完成后的异步日志暂未可见，随后从已有记录恢复并继续后两轮，没有重发首轮。
- 修复模块 SHA256：`failover-runner.mjs` = `268c6dbb3eb62f3d6b184e546978fd14145c52b8bcccb3598eae88c1bb26f5e5`，`request-rectifier.mjs` = `17bafbcd3d607f50104b54e6853078b3ad48b66939dc202fd6babe2a3ce12265`。本地完整 Node 回归 2933 passed / 8 skipped；原生 CLI 三轮 2/1/1 及有界记录的失效/淘汰烟测通过。
- 发布分支 `fix/search-history-repair-188` 从当前 origin/main 创建，只 cherry-pick 本会话六个相关提交，保留远端已合入的 GPT credits / KVM 修复，排除无关 MobaXterm 忽略提交；原工作区与已有历史不重置。候选版本 `1.3.188` 独立提交 `2c49f139`，PR [#517](https://github.com/dofastted/vm2api/pull/517) 为草稿。
- 当前严格 `verify-live.py` 旧管理员用户名密码登录门禁有既有失败，未重置凭据、未重跑已知失败；master 管理 API 200 与上述真实上游验证不冒充该脚本退出 0。替代门禁的授权选择超时后保守暂停合并/发布。该旧脚本只列宿主机 Docker，原停止 AWS 由额外集群基线检查保留，并非其本次新增失败项。
- 发布前还必须将 native payload 的公开资产/manifest 对齐已验证的 2.1.296 kernel/CLI，不引用不存在的资产 Release、不覆盖旧不可变资产。当前只推送 PR 分支，未合并、未创建应用 tag / Release；生产不宣称已为 `1.3.188`。完整私有证据见新鲜备份中的 `apply-result.json` 与 `live-search-repair-verification.json`。
- 候选发布分支前端 `tsc -b && vite build` 成功（4237 modules）。Native payload 11 个资产已在本地 `/tmp/vm2api-payload-cc296-foiyqzyw` 备齐：先下载并逐项核对原不可变 payload，再仅替换已验证的 kernel / CLI，其余 9 项哈希不变；尚未创建资产 tag/Release，也未将 manifest 指向不存在的资产。
- PR CI run `39085806102` 的 unit / worker / kernel / web / arm64 全部成功；仍不将 CI 成功等同于旧管理员登录 live gate 通过，合并和应用发布继续保持暂停。

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
