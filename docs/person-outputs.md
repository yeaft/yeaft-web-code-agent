# 数字人的输出预览

数字人的「输出」是面向用户的交付内容，不是完整 Workbench。对话解释结果，右侧查看文档、图片或网页；不提供目录树、编辑器、Terminal 或 Git。

## 查看与布局

- 点击回复下的输出条目，打开对应的右侧预览。顶部「输出」入口可重新查看已交付内容和加载更早的输出。新输出不会自动打开或抢走当前阅读位置。
- 右侧复用思考、任务、搜索所在的同一面板区域，不叠加多个侧栏。切换面板不会删除输出或停止任务。
- 桌面可拖动分隔线调宽，也可聚焦分隔线用方向键调整；宽度记在当前浏览器。全屏按钮展开到应用内容区域，再次点击恢复分栏；关闭后回到对话。
- 窄屏使用全屏预览，支持键盘 focus、Escape 关闭及返回原入口。输出较长时在预览内部滚动，不挤压输入框。

## 支持的内容

| 类型 | 行为 |
| --- | --- |
| Markdown | 安全渲染；原始 HTML 作为文字，不自动加载图片或外部资源。 |
| PNG / JPEG / GIF / WebP | 图片预览、缩放和适应窗口。 |
| PDF | 明确显示下载阅读提示。原生 PDF 查看器与隔离 iframe 不兼容，首版不做内嵌预览。 |
| UTF-8 文本、代码、JSON | 只读显示，长内容滚动。 |
| HTML | 隔离的静态预览；禁用脚本、网络资源、表单和弹窗，不是运行网站。 |
| 其他二进制格式 | 明确提示不可预览，提供下载。 |
| HTTP / HTTPS 网页 | 受限 iframe 尝试内嵌，始终提供新窗口打开及来源地址。 |

部分网站通过 CSP 或 X-Frame-Options 禁止内嵌，浏览器无法可靠检测所有拒绝情形；可使用「新窗口打开」。外链预览在用户选择打开后才发起浏览器请求，不由 Server/Agent 抓取、代理或自动启动远程 Chromium。外部内容不可信，不获得应用身份、工具或本机文件权限。

## 明确交付与快照

数字人通过自己的能力目录发现并准备 `Output.publish`，再发布文件或网页：

```json
{ "id": "Output.publish", "args": { "file_path": "reports/analysis.md", "title": "分析报告" } }
```

```json
{ "id": "Output.publish", "args": { "url": "https://example.com/report", "title": "参考网页" } }
```

`file_path` 与 `url` 必须二选一。只交付真正要用户查看的结果，不把临时脚本、日志和工具原始输出混进输出列表。后台任务产生的文件可由数字人收集后显式发布，任务完成不会自动发起模型调用或自动扫描文件。

文件发布时校验 canonical `workDir` 边界、文件类型、字节上限和符号链接；浏览器不能提交路径读取本机任意文件。原件字节作为不可变快照保存到当前实例 `<yeaftDir>/person/person.db` 的 SQLite，按 namespace、authenticated owner、Person 隔离。源文件后来被覆盖或删除，不会改变已交付版本；备份仍需包含 SQLite WAL 的一致性状态。

发布是有持久副作用的操作。已经成功发布的输出不会因后续取消或失败消失；输出存在只证明内容已交付，不代表整个任务成功。过期 worker 不能继续发布。

## 读取协议与兼容

`status.outputsSupported:true` 表示当前 Agent 支持输出协议和历史读取。`outputsFileSupported` / `outputsFileReason` 单独报告文件发布能力：目前只支持 Linux、可访问的 procfs 和 no-follow 目录描述符；Windows、macOS 或缺少这些条件时明确返回 `output_platform`，不降级到存在路径竞态的读取方式。链接发布和已有文件快照读取不受此限制。旧 Agent 只显示升级提示，不发送它不支持的操作。存储可读但模型暂不可用时仍可查看历史输出。

- `snapshot.outputs` 带最近输出页 `{items,nextCursor}`，不会夹带文件内容或本机路径。
- `outputs` 接受 `{cursor?,limit?}`，返回有界历史页。
- `output_read` 接受 `{outputId,offset?,maxBytes?}`，仅按已授权的不透明 ID 分块读取快照，单次最多 64 KiB。
- 公开条目包含 `id`、`title`、`kind`、`mimeType`、`size`、`episodeId`、`createdAt`；网页条目另含已校验的 `url`。

Server 只做 owner/Agent access 校验和有 correlation fence 的请求中继；文件仍属于 Agent。切换用户、Agent 或连接 generation 后迟到的数据不会进入新身份的预览。加载、失败、离线和不支持格式均有可见状态，不无限转圈；关闭或切换目标会隔离进行中的读取并释放临时 Blob URL。
