# Cosmos Creations & File Canvas（统一创作与画布系统）设计文档

## 1. 背景与架构演进

早期的 Cosmos Creations 仅存在于 `galaxy` 尺度（`10²¹`）的独立模态框（`CreationInteriorModal` / `DirectorChatPane`）中，与普通 Yeaft Session、Project 及 Workbench 割裂，既无法在 Classic UI 中使用，也无法直接操作真实磁盘目录。

重构后的统一 **Creation & Canvas** 架构将**文件级画布（Canvas）**与**文件夹级创作工作区（Creation）**严格解耦，并通过真实的 Yeaft Session、Server 权威 Project 以及 Per-Agent 工作区持久化，在 **Classic UI** 与 **Cosmos Galaxy** 两种界面模式间提供一致的共创与阅读体验。

## 2. 严格粒度分离：文件级 Canvas 与文件夹级 Creation

### 2.1 文件级 Canvas（`FileCanvasView`）

- **归属入口**：集成在 `Workbench -> Files`（`web/components/FilesTab.js`）内，按文件扩展名（`isCanvasSupportedFile`）自动识别并允许切换进入画布视图（`web/components/workbench/FileCanvasView.js`、`web/styles/canvas.css`）。
- **支持的文件类型与能力**：
  - **文档**（`.md` / `.markdown` / `.mdx` / `.txt`）：Apple Pages 风格阅读/编辑双态切换、Markdown 标题目录（H1–H4 Heading TOC）、字数统计、字号缩放，以及阅读态/编辑态划词选区引用（自动匹配 `lineStart`–`lineEnd` 行号范围）。
  - **图片**（`.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.svg` / `.bmp` / `.avif`）：自适应/百分比缩放、全屏灯箱预览（`openImagePreview`）、SVG 预览（`SvgPreview`）及一键引用图片到对话。
  - **视频**（`.mp4` / `.webm` / `.mov` / `.m4v` / `.ogg` / `.ogv`）：基于 HTTP `Range` 的流式播放、倍速控制（`0.75x / 1x / 1.25x / 1.5x / 2x`）、时间戳书签标记（`videoMarkers`）及当前时间点/书签引用。
- **Canvas → Session Composer 引用链路**（`web/utils/canvas-context.js` → `web/components/ChatInput.js`）：
  - 引用条目按 `routeKey` 暂存并通过 `canvas-context-added` 事件投递到当前活跃 Session 的 `ChatInput` 顶部 **Context Chips** 栏（支持单条移除；发送时经 `formatCanvasContextPrefix` 拼装为结构化上下文前缀并在发送后自动清空）。
  - **输入区克制原则**：Session Composer 内不设任何 Creation 模式开关按钮，仅在存在引用项时渲染轻量 Context Chips。

### 2.2 文件夹级 Creation（`CreationTab`）

- **归属入口**：作为 `WorkbenchPanel`（`web/components/WorkbenchPanel.js`、`web/components/WorkbenchCapabilityHost.js`）的一等能力（capability `'creation'`，与 `terminal` / `git` / `files` 并列），由 `web/components/workbench/CreationTab.js`（样式 `web/styles/creation-workbench.css`）承载。
- **文件夹组织与画布复用**：
  - 递归扫描绑定的真实工作区文件夹（跳过 `.git`、`node_modules`、`.yeaft`、`dist`、`__pycache__`、`.DS_Store`，深度上限 4、条目上限 600），按 **Documents（多级目录树 `buildDocTree`）**、**Images**、**Videos** 三个视图组织文件。
  - 直接复用 `FileCanvasView` 完成文档读写、图片预览、视频播放及向当前 Session 的上下文引用。
  - 所有 Workbench WS 文件请求（`list_directory`、`read_file`、`write_file`、`create_file`、`video_metadata`、`upload_to_dir`）均经由 `createRouteBoundWorkbenchStore` 绑定路由并按唯一 `requestId` 关联，不与 `FilesTab` 互相干扰。
- **三选一文件夹引导（Onboarding）**：当当前 Session 尚未绑定 Creation 或用户切换工作区时，提供三种入口：
  1. **新建 Creation（New Creation）**：唤起 `CreationCreateModal` 创建并初始化目录；
  2. **将当前目录作为 Creation 打开（Open Current Folder as Creation）**：经 `find_by_folder` 查找已有绑定或新建绑定；
  3. **打开当前 Agent 已有 Creation（Existing Creations）**：选中后若为旧版纯 DB 记录，自动幂等调用 `ensure_workspace` 落盘后再打开。
- **回合完成自动刷新**：监听当前 Session 的执行状态变化，在 Agent 完成一轮回复（turn completion）后防抖自动重扫文件夹，实时呈现新产出或修改的文档与媒体文件。

## 3. 真实 Session / Project 联动与 Per-Agent 工作区持久化

### 3.1 Per-Agent 命名空间与磁盘布局

所有 Creation 元数据与受管工作区均持久化在目标 Agent 的 `<yeaftDir>/creations/` 命名空间内（由 `agent/yeaft/creations/bridge.js` 按 `sha256(serverUrl + "\0" + agentId + "\0" + ownerId)` 前 24 位派生 `namespaceKey`，并写入 `.namespace.json` 校验绑定）：

```text
<yeaftDir>/
  creations/
    ns-<namespaceKey>/
      .namespace.json                     # (serverUrl, agentId, ownerId) 归属校验标记
      creations.db                        # node:sqlite (WAL, foreign_keys=ON, FTS5)
      workspaces/
        <creationId>/                     # 受管工作区（ownsWorkspace = true）
          README.md                       # 初始标题与 mission 概览
          docs/                           # 文档与（迁移后的）canon/
          images/                         # 图片资产
          videos/                         # 视频资产
          sources/                        # 上传原料副本
      <creationId>/                       # 兼容保留的原始原料、修订快照与内部资产存储
        sources/<sourceId>/original
        sources/<sourceId>/parsed.json
        artifacts/<nodeId>/...
        assets/<assetId>.<ext>
```

### 3.2 关键数据字段与工作区操作

在 `agent/yeaft/creations/store.js` 与 `agent/yeaft/creations/service.js` 中：

- **关联字段**：Creation 记录新增并持久化可选的 `sessionId`、`projectId`、`rootDir`（路径经 `realpathSync` 校验为已存在目录）以及内部标记 `ownsWorkspace`。
- **`initializeFolder`**：`create_creation` 传入 `initializeFolder: true` 且未指定外部 `rootDir` 时，在 `<namespaceRoot>/workspaces/<creationId>/` 自动创建 `{docs, images, videos, sources}` 子目录与 `README.md`，将随建上传的原料拷贝至 `sources/`，并记录 `ownsWorkspace: true`。
- **`ensure_workspace`**：幂等地将尚未落盘的旧版纯 DB Creation 记录物化到工作区目录（将 `nodes` 导出到 `docs/`、`canon` 导出到 `docs/canon/`、`sources` 导出到 `sources/`、`assets` 按 MIME/扩展名分流到 `images/` / `videos/` / `assets/`）。若 `rootDir` 已指向有效目录则直接返回 `materialized: false`。
- **`find_by_folder`**：对传入 `rootDir` 做路径规范化（含 `realpathSync`），按 `json_extract(data, '$.rootDir')` 检索同命名空间下已绑定的 Creation。
- **删除保护**：`delete_creation` 仅在 `record.ownsWorkspace === true && record.rootDir === <namespaceRoot>/workspaces/<creationId>` 时删除受管工作区目录；**用户绑定的外部文件夹永远不会被删除**。

### 3.3 真实 Session 与 Server 权威 Project 联动

前端 `web/stores/creations.js`（`createWorkspaceCreation` / `resolveCreationSession`）取代已下线的孤立组件 `CreationInteriorModal`、`DirectorChatPane` 及旧 `readers/*`、`studio/*`：

1. 若用户选择新建 Project，先调用 Server 权威 `yeaft_project_mutation`（`create`）创建 Project。
2. 调用 `create_creation`（`initializeFolder: true`、`autoPlan: false`）在目标 Agent 上落盘工作区。
3. 创建真实 Yeaft Session（`createYeaftSession`，默认 `workDir = rootDir`）或复用已有 Session（若其尚无 `workDir` 则补充绑定）。
4. 若指定了 Project，通过 `yeaft_project_mutation`（`move_session`）将 Session 归入对应 Project。
5. 调用 `update_creation` 将最终的 `sessionId` 与 `projectId` 回写至 Creation 记录；后续打开旧 Creation 时若缺少 Session，由 `resolveCreationSession` 自动补建并关联。

## 4. 跨模式统一体验（Classic UI 与 Cosmos Galaxy）

### 4.1 Classic UI

- **侧栏入口**（`web/components/YeaftSidebar.js`）：新增可折叠 **Creations** 分区，汇总当前在线且具备 `'creations'` 能力的 Agent 下的 Creation 列表，支持一键新建与点击直达。
- **快速创建弹窗**（`web/components/workbench/CreationCreateModal.js`）：统一配置项涵盖 **Agent**、**Project**（已有或内联新建）、**Session**（新建或绑定已有）、**Kind**（`book` / `deck` / `gallery` / `video`）、**Folder Path**（可选）、**Initial Prompt** 与 **Sources** 原料文件。
- **打开与阅读**（`web/components/YeaftPage.js`、`web/components/WorkbenchPanel.js`）：通过 `openCreationInClassic` 切换到关联的真实 Session，经 `pendingWorkbenchTarget` 自动激活 `Workbench -> Creation` 标签页；使用 Workbench 原生 **Maximize**（`workbenchMaximized`）即可进入纯粹的全屏阅读/编辑态。

### 4.2 Cosmos Galaxy UI

- **L1 银河全景与星表**（`web/components/cosmos/creations/CosmosGalaxyOverlay.js`、`web/components/cosmos/CosmosPage.js`）：
  - 保留按 Agent 隔离的旋臂星图与四类天体原型（`book` 主序恒星、`deck` 秩序星环星、`gallery` 发光星云、`video` 律动脉冲星），支持全屏拖拽投料、形态筛选、搜索与「星图 / 星表」切换。
  - 底部 **Omni-Ignite Dock** 升级为支持内联 **Agent / Project（含新建）/ Session（新建或复用已有）** 选择器，点火后直接走统一 `createWorkspaceCreation` 流程。
- **L2 轨道聚焦卡（Orbital Inspector）**：展示天体归属 Agent、关联 Project、关联 Session、单元/字数/原料统计，点击「着陆阅读（`read`）」或「进入工坊（`studio`）」（或双击星体）直接调用 `openGalaxyCreation`，路由进入真实的 `CosmosConversationDrawer` + `WorkbenchPanel` 的 `Creation` 标签页。
- **分屏、阅读态与一键返回银河**（`web/components/cosmos/CosmosConversationDrawer.js`）：
  - **桌面并排分屏**：当 `viewportWidth >= 1024` 且 Workbench 展开、未最大化时，自动启用 `is-workbench-split` 并排分屏布局，同时展示真实 Session 对话与 `CreationTab` 画布。
  - **全抽屉阅读模式**：以 `mode: 'read'` 着陆或在抽屉内点击最大化时，设置 `workbenchMaximized = true` 隐藏对话栏，提供纯粹的全抽屉阅读与编辑体验。
  - **一键返回银河**：从银河打开抽屉时（`openedFromGalaxy`），顶部提供「返回银河（`return-galaxy`）」按钮，收起抽屉与 Workbench 并平滑回到星图视角。

## 5. 通信与安全边界

- **Capability**：Agent 注册 `'creations'` 能力。
- **WebSocket 协议**（`server/handlers/client-creation.js`）：
  - Client → Server → Agent：`creation_request` 共 **27 个白名单 `op`**：
    - 生命周期与工作区：`list_creations`、`create_creation`、`get_creation`、`update_creation`、`delete_creation`、`ensure_workspace`、`find_by_folder`
    - 原料与星核：`add_sources`、`get_source`、`delete_source`、`upsert_canon`、`get_canon`、`delete_canon`
    - 产物节点与修订：`create_node`、`get_node`、`update_node`、`reorder_nodes`、`delete_node`、`restore_revision`
    - 提案、线程与批处理导出：`list_proposals`、`get_proposal`、`resolve_proposal`、`get_thread`、`send_message`、`start_batch_run`、`control_run`、`export_creation`
  - Server 强校验活跃账号、Agent 归属权（`resolveAgentAccessError`）与能力；对上传附件执行同用户归属与 TTL 校验，拒绝客户端伪造 `payload.files`。
  - Agent → Server → Client：`creation_response` 仅投递给原请求连接（使用服务端派生的 `agentId` 与原 `requestId`）；`creation_event` 按 owner 作用域广播并支持 Agent 断线缓冲。
- **文件系统与命名空间隔离**：
  - Agent 侧校验 `namespaceKey` 与 `.namespace.json` 一致性，所有工作区及资产读写均在 `realpathSync` 边界内执行并采用原子写入（`writeAtomic` + 硬链接发布），杜绝路径穿越与符号链接逃逸。
  - 外部目录仅记录引用，不赋予 `ownsWorkspace`，删除 Creation 时永不触碰外部目录文件。
- **媒体流 HTTP 通道**：
  - `GET / HEAD /api/yeaft/creations/:agentId/:creationId/media/:mediaKind/:mediaId`（`requireSessionAuth`），经 `creation_media_read` / `creation_media_chunk` 拉取 1 MiB 有界分块，支持 HTTP `Range`（`200` / `206` / `416`）与背压取消；Server 侧强制 `X-Content-Type-Options: nosniff` 并对 SVG 施加 CSP `sandbox`。
  - Workbench 文件画布内的图片/视频预览复用 `/api/preview/:fileId` 受权预览通道，同样支持 HTTP `Range` 视频拖动播放。

## 6. 验证与回归覆盖

- **Agent 存储与服务**：`test/agent/yeaft/creations/store-and-service.test.js`（覆盖命名空间隔离、`sessionId` / `projectId` / `rootDir` 字段、`initializeFolder`、`ensure_workspace` 幂等落盘、`find_by_folder` 与外部目录删除保护）
- **Agent 运行器与工具兼容**：`test/agent/yeaft/creations/runner-and-tools.test.js`
- **Server 中继与媒体流**：`test/server/creation-relay.test.js`（覆盖 27 个白名单 `op`、鉴权归属、附件策略与 HTTP Range 媒体流）
- **Web 前端与跨模式联动**：`test/web/cosmos-creations.test.js`（覆盖 `FileCanvasView`、`canvas-context`、`CreationTab`、`CreationCreateModal`、`creations` store、Classic/Cosmos 路由与 i18n 回归）
