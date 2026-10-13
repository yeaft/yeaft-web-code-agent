# 测试精简基线与后续增长

本轮按风险和产品链路实际删除低优先级用例，将仓库保留的逻辑测试精简到 **500**：Vitest 单元／集成 450、Playwright 浏览器 50。不是只减少 `npm test` 清单，也不通过 skip、隐藏目录、条件注册或把无关场景塞进一个测试降低计数。删除的历史仍可从 Git 查阅，但不另存归档测试集。

## 保留优先级

1. **安全和数据所有权**：认证、token/session、Agent access、用户隔离、请求关联与过期连接 fence、文件路径及符号链接安全、HTML/外链/XSS 隔离。
2. **持久化和恢复**：SQLite 事务与不可变结果、会话 transcript、重启恢复、历史分页及版本重置、数字人输出快照和记忆归属。
3. **执行生命周期**：provider 部分失败与 continuation、terminal boundary、取消、任务 orphan/recovery、子 Agent 状态、Work Center 写冲突与资源控制。
4. **核心用户链路**：登录与重连、发送和 streaming、附件、Session 切换、数字人配置/后台执行/交付阅读器、Work Center 对话和完成证据。
5. **代表性浏览器验证**：实际 wire 和 DOM 行为优先；保留桌面/light 与 320px/dark 等代表点，不为每个组件重复完整主题×尺寸矩阵。

## 分布

| 范围 | 逻辑用例 |
| --- | ---: |
| Agent / 原生引擎 / providers / 安装及会话基础 | 115 |
| 数字人及本地记忆 | 100 |
| Work Center | 70 |
| Server | 65 |
| Web 状态与组件 | 95 |
| 测试计数门禁 | 5 |
| 浏览器 | 50 |
| **合计** | **500** |

## 删除方向与接受的取舍

- 删除大量仅断言源码片段、重复常量/文案/布局和单一路径细分的测试；保留可执行行为与真实持久化证据。
- 缩减格式、参数、主题和 viewport 的组合枚举，而不是取消参数化测试的计数。
- 将相同链路在单元与浏览器中的重复覆盖降低到必要层次；未增加“一个测试跑数十个无关回归”的测试套娃。
- 去掉本轮未保留的环境专属测试文件，不能把 Docker、真实模型/下载或其他外部依赖 suite 留在门禁之外冒充精简。
- 不改变业务代码来让测试通过；保留的 smoke/probe 命令是运行验证工具，不构成隐藏的退役测试集。
- 清理已删测试的孤立 helper、截图和 CI job；移除指向已不存在脚本的 `test:sandbox:docker` 命令，以及基线中已没有测试文件的 Playwright `smoke` project/命令。旧 Sandbox 验收文档明确标记历史证据，不冒充当前覆盖。
- 删除的跨平台 CI 包含 Work Item attachment 的 Linux/macOS/Windows 矩阵和 Windows Browser Runtime 专项；本轮保留套件以 Linux 为验证基线，不再宣称具备这两项平台专项验证。发布的 package-bin/import/startup guards 继续保留。

这是明确接受覆盖广度下降的精简，不宣称与原测试集等价。罕见平台、细分错误文案、次要布局与部分非核心功能更可能缺少自动回归；以后修改这些行为时应按实际风险重新添加用例。

## 数量口径与门禁

`scripts/test-suite-manifest.mjs` 登记所有保留的 Vitest 和 Playwright 文件。`npm run test:budget` 同时检查文件集合和实际运行时收集数量：

- Vitest 用 focused config 收集整个 `test/`，不是只数默认 manifest；`each` 展开、skip/todo 均计入。
- Playwright `--list --reporter=json` 收集整个浏览器目录；每个 spec 计一个逻辑用例，多个 project 重复执行不乘数量。
- 收集失败、文件缺失、未登记文件和总量超预算都失败；门禁不执行测试主体。
- `npm test` 执行门禁和全部保留的 Vitest 文件；`npm run test:e2e` 独立执行浏览器测试。预算检查不等于浏览器用例已通过。

## 以后如何加测试

500 是本轮基线，不是永远禁止增加测试。先判断新增行为的风险及已有覆盖：重复测试优先替换；必要的安全、恢复或核心产品回归，应独立补测并在同一 PR 中说明理由，小幅上调 `TEST_CASE_LIMIT`。不得删除更重要的覆盖为低风险测试腾位，也不得以 skip/exclude 或无关断言合并绕过数量。

验证记录以 PR 中实际执行的结果为准；本文不将计数成功当作测试成功。
