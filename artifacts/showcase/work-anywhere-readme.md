# Work from anywhere · 8 页演示稿

本版保留原稿暖白 / 棕色强调的英文极简风格，将 phone-first 叙事改为随处工作。原有演示文件不覆盖。

## 结构

1. Work from anywhere. — 产品定位。
2. Different devices. The same working context. — 随处接入相同 Agent + Session。
3. The right role. The next step. — 多角色职责与显式转发。
4. Define the roles. Set the working rules. — System Prompts 与共享规则。
5. Beyond chat. A real workbench. — Files / Terminal。
6. From a development goal to execution. — 自动化开发场景。
7. Keep the task moving. Keep control. — Work Center 持久目标、执行与验收。
8. Your AI team. Real work. From anywhere. — 收束和仓库入口。

## 文件

- `yeaft-work-anywhere.pptx`：8 页可编辑演示稿，英文正文，每页英文配音稿与中文备注。
- `yeaft-work-anywhere.pdf`：最终 PPTX 的实际渲染。
- `work-anywhere-preview.png`：8 页总览。
- `work-anywhere-talk-track.md`：215 词英文讲稿，目标时长 110 秒，非已测量视频时长。
- `work-anywhere-render-report.json`：渲染页数、字体、尺寸与输入 SHA-256。
- `work-anywhere-assets/`：复用截图与原始 capture manifest。截图未重新采集，来源 commit 见 manifest。

## 事实边界

- 任何地点接入，仍需 Server 可达、所选 Agent 在线；不声称项目 / Session 在不同 Agent 间自动迁移。
- 截图来自真实 UI 的隔离 staged 数据，不是跨设备端到端实测。素材沿用此前稿件，manifest 中脚本路径与 source commit 是原始采集来源，不是本版执行记录。
- 多角色交接序列与 bug 修复任务是示例，不暗示截图已完成该工作或存在固定流水线。
- Terminal 展示的是既有 `node --check` 输出，不是完整测试。
- Work Center 保留 Preview；执行取决于工具、权限、凭据和验收。它与 Session 是不同对象，成员配置也独立。
- System Prompt 是行为指导，不是安全沙箱。未授权的部署不属于示例任务。

## 复现与验证

先按仓库现有依赖安装流程准备依赖，再运行：

```bash
node artifacts/showcase/generate-work-anywhere.cjs
sh artifacts/showcase/render-showcase.sh
```

渲染需要已存在的 `yeaft-showcase-renderer:bookworm` Docker image；可按脚本的 `--build-image` 显式构建，不修改在线 Agent / Server。每次运行产生独立 `tmpclaude-showcase-preview/render-*`。

生成器只更新 PPTX 和讲稿。渲染后将该次 `deck.pdf`、`contact-sheet.png` 和 `render-report.json` 分别复制为上文成品名，再运行：

```bash
npm run test:focus -- test/showcase-work-anywhere.test.js
npm test
git diff --check
```

字体为 Liberation Sans；PowerPoint 查看端缺失该字体时可能替换，最终演讲设备上建议复查。
