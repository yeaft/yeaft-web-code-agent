import { defineConfig } from 'vitepress'

const repo = 'https://github.com/yeaft/yeaft-web-code-agent'

export default defineConfig({
  title: 'Yeaft',
  description: 'Web control plane for native multi-provider Sessions, Work Center, Claude Code CLI, and GitHub Copilot CLI',
  base: '/yeaft-web-code-agent/',

  rewrites: {
    'USER_GUIDE.zh-CN.md': 'zh-CN/USER_GUIDE.md',
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/yeaft-web-code-agent/logo.svg' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/introduction' },
          { text: 'Sessions', link: '/guide/user/yeaft-session' },
          { text: 'Work Center', link: '/guide/user/work-center' },
          { text: 'Architecture', link: '/guide/tech/architecture' },
          { text: 'GitHub', link: repo },
        ],
        sidebar: [
          {
            text: 'Start here',
            items: [
              { text: 'What is Yeaft?', link: '/guide/introduction' },
              { text: 'Getting started', link: '/guide/getting-started' },
              { text: 'Choose a code agent path', link: '/guide/user/choose-backend' },
            ],
          },
          {
            text: 'Native Yeaft',
            items: [
              { text: 'Sessions and Projects', link: '/guide/user/yeaft-session' },
              { text: 'Work Center', link: '/guide/user/work-center' },
              { text: 'Provider and model config', link: '/guide/yeaft-config' },
              { text: 'Settings', link: '/guide/user/settings' },
            ],
          },
          {
            text: 'CLI backends and workspace',
            items: [
              { text: 'Claude Code conversations', link: '/guide/user/chat-mode' },
              { text: 'GitHub Copilot conversations', link: '/guide/user/copilot-mode' },
              { text: 'Expert Panel', link: '/guide/user/expert-panel' },
              { text: 'Split screen', link: '/guide/user/split-screen' },
              { text: 'Workbench', link: '/guide/user/workbench' },
              { text: 'Keyboard shortcuts', link: '/guide/user/shortcuts' },
            ],
          },
          {
            text: 'Install and operate',
            items: [
              { text: 'Server deployment', link: '/guide/deploy-server' },
              { text: 'Agent installation', link: '/guide/deploy-agent' },
              { text: 'Agent and native CLI', link: '/guide/agent-cli' },
              { text: 'Login and registration', link: '/guide/user/login' },
              { text: 'Admin dashboard', link: '/guide/features-dashboard' },
              { text: 'Security', link: '/guide/security' },
            ],
          },
          {
            text: 'Technical reference',
            items: [
              { text: 'Architecture', link: '/guide/tech/architecture' },
              { text: 'CLI provider system', link: '/guide/tech/providers' },
              { text: 'Native engine', link: '/guide/tech/yeaft-engine' },
              { text: 'H2-AMS memory', link: '/guide/tech/yeaft-memory' },
              { text: 'Native LLM layer', link: '/guide/tech/yeaft-llm' },
              { text: 'WebSocket protocol', link: '/guide/tech/wire-protocol' },
              { text: 'Digital person design (proposal, 中文)', link: '/notes/2026-09-24-digital-person-design' },
              { text: 'WebRTC Browser Runtime design', link: '/notes/2026-08-07-webrtc-browser-runtime-design' },
              { text: 'Browser Runtime Phase 0 results', link: '/notes/2026-08-08-browser-runtime-phase-0-results' },
              { text: 'Configuration reference', link: '/guide/reference/config-reference' },
              { text: 'FAQ', link: '/guide/faq' },
            ],
          },
        ],
      },
    },
    'zh-CN': {
      label: '中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/zh-CN/guide/introduction' },
          { text: 'Session', link: '/zh-CN/guide/user/yeaft-session' },
          { text: 'Work Center', link: '/zh-CN/guide/user/work-center' },
          { text: '架构', link: '/zh-CN/guide/tech/architecture' },
          { text: 'GitHub', link: repo },
        ],
        sidebar: [
          {
            text: '从这里开始',
            items: [
              { text: '什么是 Yeaft？', link: '/zh-CN/guide/introduction' },
              { text: '快速开始', link: '/zh-CN/guide/getting-started' },
              { text: '选择代码 Agent 路径', link: '/zh-CN/guide/user/choose-backend' },
            ],
          },
          {
            text: '原生 Yeaft',
            items: [
              { text: 'Session 与 Project', link: '/zh-CN/guide/user/yeaft-session' },
              { text: 'Work Center', link: '/zh-CN/guide/user/work-center' },
              { text: 'Provider 与 model 配置', link: '/zh-CN/guide/yeaft-config' },
              { text: '设置', link: '/zh-CN/guide/user/settings' },
            ],
          },
          {
            text: 'CLI 后端与工作区',
            items: [
              { text: 'Claude Code conversation', link: '/zh-CN/guide/user/chat-mode' },
              { text: 'GitHub Copilot conversation', link: '/zh-CN/guide/user/copilot-mode' },
              { text: 'Expert Panel', link: '/zh-CN/guide/user/expert-panel' },
              { text: '分屏', link: '/zh-CN/guide/user/split-screen' },
              { text: 'Workbench', link: '/zh-CN/guide/user/workbench' },
              { text: '快捷键', link: '/zh-CN/guide/user/shortcuts' },
            ],
          },
          {
            text: '安装与运维',
            items: [
              { text: '部署 Server', link: '/zh-CN/guide/deploy-server' },
              { text: '安装 Agent', link: '/zh-CN/guide/deploy-agent' },
              { text: 'Agent 与原生 CLI', link: '/zh-CN/guide/agent-cli' },
              { text: '登录与注册', link: '/zh-CN/guide/user/login' },
              { text: '管理员仪表板', link: '/zh-CN/guide/features-dashboard' },
              { text: '安全', link: '/zh-CN/guide/security' },
            ],
          },
          {
            text: '技术参考',
            items: [
              { text: '架构', link: '/zh-CN/guide/tech/architecture' },
              { text: 'CLI provider 系统', link: '/zh-CN/guide/tech/providers' },
              { text: '原生 engine', link: '/zh-CN/guide/tech/yeaft-engine' },
              { text: 'H2-AMS memory', link: '/zh-CN/guide/tech/yeaft-memory' },
              { text: '原生 LLM 层', link: '/zh-CN/guide/tech/yeaft-llm' },
              { text: 'WebSocket 协议', link: '/zh-CN/guide/tech/wire-protocol' },
              { text: '数字人设计（提案）', link: '/notes/2026-09-24-digital-person-design' },
              { text: 'WebRTC Browser Runtime 设计', link: '/notes/2026-08-07-webrtc-browser-runtime-design' },
              { text: 'Browser Runtime Phase 0 结果', link: '/notes/2026-08-08-browser-runtime-phase-0-results' },
              { text: '配置参考', link: '/zh-CN/guide/reference/config-reference' },
              { text: '常见问题', link: '/zh-CN/guide/faq' },
            ],
          },
        ],
      },
    },
  },

  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2024-present Yeaft',
    },
  },
})
