# 设置

从 sidebar 底部的 **⚙ 齿轮**进入设置面板。设置是一个**固定外壳**的弹窗：tab 切换时内容滚动，外壳尺寸不变。

## 通用

- **主题** — 亮色 / 暗色
- **语言** — 中文 / English（切换后界面立即重渲染）
- **Office 预览模式** — Office 文档（doc/docx/xls/xlsx/ppt/pptx）预览方式：
  - **本地渲染** — 内置查看器，不联网
  - **Office Online** — 通过 Microsoft Office 在线查看器；需要 Agent 端的文件 URL 公网可达

## 账户

- **用户名** — 登录名（只读）
- **角色** — `Pro` 或 `Admin`（只读）
- **邮箱** — 若注册时填了
- **退出登录** — 清 token 回登录页

## 安全

### Agent Key
- 用于鉴权 Agent ↔ Server 的 WebSocket 连接
- **👁 眼睛**显示 / 隐藏 key
- **📋 复制**到剪贴板
- **重置 key** — 生成新 key（**会导致所有现有 Agent 断线**，需要用新 key 重新连）

### 安装命令（Agent 端）
显示完整的两行命令：
```bash
npm install -g @yeaft/webchat-agent
yeaft-agent install --server <你的服务器URL> --secret <你的 Agent Key>
```
点 **复制** 复制完整命令到剪贴板，可直接粘贴到 Agent 机器跑。

### 修改密码
- 输入当前密码 + 新密码（≥6 字符）+ 确认新密码
- 点 **修改密码**

## 邀请码管理（仅 Admin）

管理员可以为新用户生成邀请码：

- **创建** — 选角色（`Pro`）+ 选有效期 + 点 **+** 生成
- **列表** — 每条邀请码显示：
  - 邀请码字符串
  - 角色 tag
  - 状态：**可用** / **已使用** / **已过期**
  - 使用者用户名（已使用时显示）
  - 过期时间
  - 📋 复制（未使用的）
  - 🗑 删除（未使用的）

新用户在登录页用邀请码注册账号。

## 端口代理（Port Proxy）

把 Agent 机器上跑的本地服务（如 `localhost:3000` 的 dev server）通过浏览器访问：

- **+ 添加端口** — 填 Agent、host、port、可选标签
- **开关** — 启用 / 禁用单条规则
- **🌐 在浏览器打开** — 新 tab 打开代理 URL
- **📋 复制 URL** — 复制代理 URL

> Workbench 工作台也有同名 tab，两边数据一致。

## LLM 设置（Yeaft 模式相关）

如果你的 Agent 启用了 Yeaft 引擎，设置里会多一个 **Yeaft / LLM** tab：

- **配置文件路径** — 显示 `~/.yeaft/config.json` 位置
- **Providers 列表** — 当前配的 provider / 模型 / 协议
- **测试连接** — 选一个 model 发 ping，确认 endpoint + 鉴权 OK
- **重新加载** — 让 Agent 重读 config 文件（改完 config 不用重启 Agent）

详细字段参考 [Yeaft 引擎配置](../yeaft-config.md)。

## 调试 / 实验功能

> 仅 Admin / 调试模式可见

- **Debug 模式** — 打开后 console 多打很多日志
- **Experimental flag** — 一些还在迭代中的功能开关

## 保存

设置面板**自动保存** — 改完 tab 切走 / 关闭就生效，不用点 "Save"。

> 例外：**重置 Agent Key**、**修改密码** 这类敏感操作需要在 tab 内点对应按钮触发，不是自动保存。
