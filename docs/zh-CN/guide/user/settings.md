# 设置

从 sidebar 底部的 **⚙ 齿轮**进入设置面板。设置是一个**固定外壳**的弹窗：tab 切换时内容滚动，外壳尺寸不变。

## 通用

- **主题** — 亮色 / 暗色
- **语言** — 中文 / English（切换后界面立即重渲染）
- **Office 预览模式** — Office 文档（doc/docx/xls/xlsx/ppt/pptx）预览方式：
  - **本地渲染** — 内置查看器，不联网
  - **Office Online** — 通过 Microsoft Office 在线查看器；需要 Agent 端的文件 URL 公网可达

### 自定义快捷键与快捷发送

**通用 → 自定义快捷键**管理个人按键绑定和“显示快捷发送”开关。快捷发送按钮默认隐藏；新用户提供简单的 `Alt + 单键` 默认绑定，也可以替换或清除任意按键。偏好按登录用户隔离保存在当前浏览器，不跨设备同步。

发送预设位于 **Agent 设置 → 快捷发送**，保存到所选实例的 `config.json`。默认没有预设，可逐个添加最多 5 个，分别设置名称、模型、effort 和最大输出 token；effort 留空使用运行时默认值；最大输出 token 留空使用所选模型解析出的输出上限，不继承 Session 之前模型的预算，也可填写正整数设置更小的预算。每次请求（含重试切换模型）都不会超过实际模型的输出上限。模型列表属于当前 Agent，切换 Agent 不会复用另一台的预设。

开启显示后，原生 Yeaft Session 的 Composer 会在普通发送按钮旁显示一个轻量的发送模式入口。打开后可选择预设发送当前草稿、附件与引用，也可以直接使用对应快捷键；这些参数只覆盖本次消息，不修改 Session 默认值。普通 Enter 发送保持原有行为；CLI Chat 和 Work Center 不显示这个入口。

默认按键：

| 操作 | Windows / Linux | macOS |
| --- | --- | --- |
| 打开终端 | `Alt+T` | `Option+T` |
| 打开文件 | `Alt+O` | `Option+O` |
| 打开 Git 工作台 | `Alt+G` | `Option+G` |
| 新建 Session | `Alt+N` | `Option+N` |
| 快捷发送 1–5 | `Alt+1…5` | `Option+1…5` |

配置会拦截已知浏览器和应用快捷键冲突，例如 `Ctrl+T`（新标签页）和 `Ctrl+F`（搜索）。操作系统或浏览器扩展仍可能保留某些组合键，请按实际环境调整。工作台快捷键不会抢占输入框、编辑器、终端或弹窗焦点；快捷发送按键仅在 Composer 输入时生效，输入法组合输入及按住重复不会触发。

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


## LLM 设置（Yeaft 模式相关）

如果你的 Agent 启用了 Yeaft 引擎，设置里会多一个 **Yeaft / LLM** tab：

- **配置文件路径** —— 显示所选 Agent instance 解析出的 `config.json` 位置
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
