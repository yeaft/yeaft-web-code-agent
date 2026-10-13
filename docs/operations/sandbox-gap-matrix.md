# Sandbox Agent 差距矩阵

本文记录当时以 `docs/notes/2026-07-17-sandbox-agent-design.md` 第 19、20、21 节为基线的历史验收证据。2026-10-13 测试精简后，下表所列的部分专项测试已不再保留，旧 Docker 开发验收脚本及 `test:sandbox:docker` 命令也不在当前仓库中；不能把历史通过记录当作当前版本已复验。当前仍保留 `test/server/sandbox-routes.test.js` 的权限与删除 fence 验证，其他边界修改时需重新补测。真实 Host 项在 qualification 报告落档前一律保持未关闭，且 `SANDBOX_ENABLED` 必须保持默认 `false`。

## 第 19 节验收组

| 验收组 | 现状证据 | 缺口 | 责任代码 / 测试 | 关闭证据 |
| --- | --- | --- | --- | --- |
| 19.1 Ownership 与容量 | 按 `user_id` 查询；容量和 reservation 在 SQLite 事务内结算；稳定错误码 | 真实并发压力需在集成动作复验 | `server/db/sandbox-db.js`；`test/server/sandbox-db.test.js` | 专项测试覆盖 owner、单实例、两 slot、不同规格、Stop/失败保留及 Remove 后释放 |
| 19.2 生命周期 | 持久 operation、generation fence、Agent Ready、reconciler、Remove recovery | Host 重启及持久目录恢复必须实测 | `server/sandbox-reconciler.js`；`test/server/sandbox-reconciler.test.js` | 自动化覆盖刷新恢复、超时、迟到 result、credential 吊销；Host qualification 待补 |
| 19.3 资源隔离 | 固定 Podman/gVisor 参数；Ready 前 inspect 固定镜像、非 root、只读 rootfs、cap-drop、userns、network、mount、CPU/内存/PID/IO 和 XFS quota；bootstrap 仅写入经验证的独立 tmpfs secret root，失败路径清理；持久路径逐级拒绝 symlink | Node 层校验不能替代 Helper 内核侧 `openat2`、真实 enforce、EDQUOT 和跨 Sandbox 隔离 | `agent/managed-sandbox/runtime-executor.js`；`test/agent/managed-sandbox-runtime-executor.test.js`；Host qualification | 自动化 fail-closed inspect/secret/path 已覆盖；专用 Host 报告仍未关闭 |
| 19.4 网络 | nftables 默认拒绝入站、IPv4/IPv6 私网/metadata/同桥访问，允许公开 egress | DNS rebinding、工具链公网访问、带宽/连接限制需实测 | `agent/managed-sandbox/runtime-executor.js`；Host qualification | IPv4/IPv6 规则自动化覆盖；专用 Host 网络测试仍未关闭 |
| 19.5 Credential | 单次 bootstrap、scope 绑定、长期 credential 与 Remove 吊销；兑换后删除 bootstrap，长期 credential 不写 process env | argv/image/log secret redaction 需真实进程与日志扫描 | `server/db/sandbox-db.js`；`test/server/sandbox-agent-auth.test.js`；`test/agent/managed-sandbox-agent-runtime.test.js`；Host qualification | 自动化协议和 env/bootstrap 生命周期已覆盖；真实 redaction 报告待补 |
| --- | --- | --- |
| 1. Host qualification 与 capability | capability fail closed 已实现；qualification 入口为签名 attestation | 自动化校验签名、freshness、image 和健康项；真实 Host 未关闭 |
| 2. 数据模型、状态机与容量 | SQLite schema、事务 reservation、operation 状态机 | `test/server/sandbox-db.test.js` |
| 3. Credential 与 managed runtime | bootstrap exchange、credential scope、Agent Ready | `test/server/sandbox-agent-auth.test.js` |
| 4. Controller、Helper、signed protocol | mTLS、Ed25519、签名 `ACTIVATE_EPOCH`、durable journal、完整 request/result binding 已实现 | Controller/Helper 专项测试；独立 systemd service/socket、`SO_PEERCRED` 与 cgroup caller fence 仍须在专用 Host 部署关闭 |
| 5. 镜像、存储、网络与 lifecycle | 固定 digest runtime executor、XFS、nftables、reconcile | mock 自动化已完成；内核 E2E 未关闭 |
| 6. Settings Sandbox 页面 | capability/snapshot/operation 驱动；loading/empty/error/disabled/长文本和 i18n | `test/web/sandbox-settings.test.js`；视觉证据由 UX 审查动作采集 |
| 7. 故障、安全、容量 | 自动化入口存在 | 专用 Host fault injection、容量与安全报告未关闭 |

## 第 21 节上线门禁

| 门禁 | 状态 | 证据 / 关闭条件 |
| --- | --- | --- |
| 专用 Host qualification | 未关闭（当前环境已可靠拒绝） | `docs/operations/sandbox-host-gate-evidence.md` 记录 2026-07-27 脱敏失败报告；关闭仍需获批专用 Host 生成带时间、Host epoch、镜像 digest 的通过报告 |
| 两个 reservation 与并发不超卖 | Docker 开发验收已通过，生产未关闭 | `npm run test:sandbox:docker` 以受控低可用内存和并发竞争证明拒绝结果稳定、`docker create` 调用数为零；Server 事务 reservation/启动 lease 另由 `test/server/sandbox-db.test.js` 覆盖 |
| Normal 资源限制实测 | Docker memory/PID hard limit 与内存压力已通过，生产未关闭 | `npm run test:sandbox:docker` inspect 真实 Docker hard limit 并触发内存压力；专用 Host 仍须验证 `1 vCPU / 2 GiB / 20 GB`、PID、IO、XFS EDQUOT 和 gVisor |
| Stop/Start 数据恢复 | Docker 开发验收已通过，生产未关闭 | `npm run test:sandbox:docker` 对 home/workspace 写入哨兵并在 Stop/Start 后核验；专用 Host 重启恢复仍待 qualification |
| Remove/账户删除 crash recovery | 未关闭 | 关键 commit 前后 kill -9 与主机重启故障注入 |
| 公网可用、禁止网段阻断 | 未关闭 | 公开 HTTPS/npm/pip/git/gh/Web/Search/LLM 与私网矩阵 |
| Credential 与 redaction | 部分关闭 | 协议、bootstrap 删除和长期 credential 不入 env 的自动化通过；真实 argv/image/log 扫描待完成 |

当前实现仍是生产门禁前的垂直切片。不得把本矩阵中的“代码关闭”解释为专用 Host 已通过验收。在第 21 节所有门禁有独立证据前，保持 `SANDBOX_ENABLED=false`，不得宣称生产可用。
