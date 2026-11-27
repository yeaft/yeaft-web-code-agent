# Cosmos Creations（银河创作与阅读系统）设计文档

## 1. 背景与目标

Yeaft Cosmos UI 的 `galaxy` 尺度（`10²¹`）原先仅包含基于 `localStorage` 的演示书签占位，不支持真实素材上传、AI 生成、多形态阅读或跨设备/Per-Agent 持久化。

本设计将银河尺度升级为完整的 **Per-Agent 多模态学习/阅读资料创作与消费系统（Creations）**，打通：

- **选定 Agent → 投喂资料 + Prompt 点亮星体 → 长程共创/后台批量生产 → 沉浸阅读与原地改稿**
- **形态可扩展**：统一抽象支持 `book`（书/小说/深度文档）、`deck`（PPT 演示稿）、`gallery`（图片/图集）、`video`（视频/分镜课程），并允许同一 Creation 内挂载多文档、多形态单元。
- **轻重场景通吃**：既支持拖入 PDF 快速出片，也支持 500 章网络小说 / 系列课程级的分卷大纲、星核设定防遗忘、分焦点编导对话与断点续跑批量生产。

## 2. 空间隐喻与层级

- **Per-Agent 隔离**：银河视图顶部提供显式 Agent 切换栏，所有 Creation 列表、素材、星核、产物与运行状态均严格按 `(agentId, creationId)` 隔离，不跨 Agent 混看或串写。
- **四类发光天体原型**（渲染于银河旋臂 `particle-hud.js` + `stage-loop.js`）：
  - `book` → **主序恒星**（暖金恒星核心 + 柔光日冕）
  - `deck` → **秩序星环星**（冰青核心 + 同心光环）
  - `gallery` → **发光星云 / 星团**（极光紫星云 + 多亮核）
  - `video` → **律动脉冲星**（电光蓝脉冲核心 + 旋转双光束）
- **三层空间交互**：
  - **L1 银河全景 / 星表视图**：支持全屏拖拽投料、底部悬浮星核槽（Omni-Ignite Dock）、双击深空种星、按形态筛选、搜索与「星图 / 星表」一键切换。
  - **L2 轨道聚焦卡**：单击星体展开玻璃轨道卡，预览摘要、单元数、字数、原料卫星数与运行进度，提供「着陆阅读 / 进入工坊」入口；双击直接着陆。
  - **L3 星体内部双态**：
    - **阅读态（Read Mode）**：有可读内容时默认进入；退隐星空干扰，呈现形态专属沉浸阅读/播放画布 + 不破坏阅读感的轻量直改 + 划词/定点唤起 380px 锚点 AI 改稿抽屉。
    - **工坊态（Studio Mode）**：三栏（移动端底部三切页）长程共创工作台：`产物树 / 星核档案 / 原料仓` + `大纲看板 / 编辑器 / Diff 提案 / 星核同步条` + `焦点编导对话台`。

## 3. Creation 四舱领域模型

每个 Creation 由四个正交舱室构成，全部持久化在目标 Agent 的 `<yeaftDir>/creations/` 下（不写入 `workDir`，不污染普通 Session transcript 或记忆）：

```text
<yeaftDir>/
  creations/
    creations.db                       # node:sqlite (WAL, foreign_keys=ON, FTS5)
    <creationId>/
      sources/<sourceId>/raw.<ext>     # 不可变原始上传文件
      sources/<sourceId>/parsed.json   # 提取文本分块与摘要边车
      artifacts/<nodeId>/current.*     # 当前正文或结构化 JSON
      artifacts/<nodeId>/revisions/    # 不可变历史快照
      assets/<assetId>.<ext>           # 生成的图像/SVG/音视频资产
```

1. **Sources（原料仓）**：支持多文件上传与文字粘贴；入仓后自动解析文本分块并支持全周期随时追加。
2. **Canon（星核档案）**：保存绝不能忘的重要设定，分为 `world`（世界观/总纲）、`entity`（人物/实体卡含动态状态 JSON）、`ledger`（伏笔/时间线台账）、`rule`（文风与禁令）。支持 `pinned`（必挂）、FTS5 按需召回与 `lockedByUser` 锁定防 AI 静默覆盖。
3. **Artifacts（产物星图）**：任意层级 `folder`（卷/模块）与 `unit`（`markdown_doc` / `slide_deck` / `image_gallery` / `video_episode`）树。带不可变 `creation_revisions` 历史快照、基于 `baseRevId` 的乐观并发保护，以及 AI 修改提案 `creation_proposals`（需用户确认采纳）。
4. **Co-Creation（编导台与批量运行）**：
   - **焦点分流线程**：`global`（统筹规划）与 `node:<nodeId>`（单章/单单元精修）。
   - **5 层确定性上下文装配**：总览 → 必挂星核 → FTS5 相关星核 → 前序完整单元 + 近 4 单元摘要连续性窗口 → 当前焦点/锚点/相关原料/近期对话，并向 UI 返回透明 `contextMeta`。
   - **隔离引擎执行**：复用 Agent LLM 配置与 `Engine.query()`，显式清空 `yeaftDir`、`conversationStore`、`memoryIndex`、`amsRegistry`、`taskManager`、`toolStats`，仅挂载 Creation 作用域受限工具集。
   - **持久化批量推进与重启恢复**：支持多选章节连续生成与每 N 章检查点暂停；进程重启时 `recoverInterruptedRuns()` 将陈旧 `running` 任务收敛为 `paused`，绝不盲目重跑。

## 4. 通信与安全边界

- **Capability**：Agent 注册 `'creations'` 能力。
- **WebSocket 协议**：
  - Client → Server → Agent：`creation_request`（23 个白名单 `op`），Server 强校验活跃账号、Agent 归属权（`resolveAgentAccessError`）及能力，并对上传附件执行同用户归属与 TTL 校验，拒绝客户端伪造 `payload.files`。
  - Agent → Server → Client：`creation_response`（仅投递给原请求连接，使用服务端派生的 `agentId` 与原 `requestId`）与 `creation_event`（owner-scoped 广播，允许 Agent 断线缓冲）。
- **媒体流 HTTP 通道**：
  - `GET / HEAD /api/yeaft/creations/:agentId/:creationId/media/:mediaKind/:mediaId`（`requireSessionAuth`）。
  - 经由 `creation_media_read` / `creation_media_chunk` 与 Agent 关联拉取 1 MiB 有界分块，完整支持 HTTP `Range`（`200` / `206` / `416`）与背压/断流取消。
  - Agent 侧严格校验 ID 并在 `realpathSync` 边界内读取文件，杜绝路径穿越与符号链接逃逸；Server 侧强制 `X-Content-Type-Options: nosniff` 并对 SVG 资产施加 CSP `sandbox`。

## 5. 验证与回归覆盖

- Agent 存储/服务与工具/运行器测试：`test/agent/yeaft/creations/store-and-service.test.js`、`test/agent/yeaft/creations/runner-and-tools.test.js`
- Server 中继/鉴权/附件策略/Range 媒体流测试：`test/server/creation-relay.test.js`
- Web Store/多形态阅读器/星图投影/i18n 回归测试：`test/web/cosmos-creations.test.js`
