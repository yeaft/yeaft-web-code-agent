import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Yeaft',
  description: 'Multi-provider AI collaboration platform — Claude Code, GitHub Copilot, and the Yeaft engine',
  base: '/claude-web-chat/',

  rewrites: {
    'USER_GUIDE.zh-CN.md': 'zh-CN/USER_GUIDE.md',
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/claude-web-chat/logo.svg' }],
  ],

  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/introduction' },
          { text: 'User Guide', link: '/guide/user/choose-backend' },
          { text: 'Tech', link: '/guide/tech/architecture' },
          { text: 'GitHub', link: 'https://github.com/yeaft/claude-web-chat' },
        ],
        sidebar: [
          {
            text: 'Introduction',
            items: [
              { text: 'What is Yeaft?', link: '/guide/introduction' },
              { text: 'Getting Started', link: '/guide/getting-started' },
            ],
          },
          {
            text: 'Deployment',
            items: [
              { text: 'Server (Docker)', link: '/guide/deploy-server' },
              { text: 'Agent Setup', link: '/guide/deploy-agent' },
              { text: 'Yeaft Engine Config', link: '/guide/yeaft-config' },
            ],
          },
          {
            text: 'User Guide',
            items: [
              { text: 'Login & Register', link: '/guide/user/login' },
              { text: 'Choose a Backend', link: '/guide/user/choose-backend' },
              { text: 'Claude Code Chat', link: '/guide/user/chat-mode' },
              { text: 'Copilot Mode', link: '/guide/user/copilot-mode' },
              { text: 'Yeaft Group Mode', link: '/guide/user/yeaft-group' },
              { text: 'Crew Collaboration', link: '/guide/user/crew' },
              { text: 'Expert Panel', link: '/guide/user/expert-panel' },
              { text: 'Split Screen', link: '/guide/user/split-screen' },
              { text: 'Workbench', link: '/guide/user/workbench' },
              { text: 'Admin Dashboard', link: '/guide/features-dashboard' },
              { text: 'Settings', link: '/guide/user/settings' },
              { text: 'Keyboard Shortcuts', link: '/guide/user/shortcuts' },
            ],
          },
          {
            text: 'Technical',
            items: [
              { text: 'Architecture', link: '/guide/tech/architecture' },
              { text: 'Provider System', link: '/guide/tech/providers' },
              { text: 'Yeaft Engine', link: '/guide/tech/yeaft-engine' },
              { text: 'Yeaft Memory (H2-AMS)', link: '/guide/tech/yeaft-memory' },
              { text: 'Yeaft LLM Layer', link: '/guide/tech/yeaft-llm' },
              { text: 'WebSocket Protocol', link: '/guide/tech/wire-protocol' },
              { text: 'Security', link: '/guide/security' },
              { text: 'Agent CLI', link: '/guide/agent-cli' },
            ],
          },
          {
            text: 'Reference',
            items: [
              { text: 'FAQ', link: '/guide/faq' },
              { text: 'Config Reference', link: '/guide/reference/config-reference' },
              { text: 'Full User Guide (single page)', link: '/USER_GUIDE' },
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
          { text: '用户指南', link: '/zh-CN/guide/user/choose-backend' },
          { text: '技术实现', link: '/zh-CN/guide/tech/architecture' },
          { text: 'GitHub', link: 'https://github.com/yeaft/claude-web-chat' },
        ],
        sidebar: [
          {
            text: '介绍',
            items: [
              { text: '什么是 Yeaft？', link: '/zh-CN/guide/introduction' },
              { text: '快速开始', link: '/zh-CN/guide/getting-started' },
            ],
          },
          {
            text: '部署',
            items: [
              { text: '服务器 (Docker)', link: '/zh-CN/guide/deploy-server' },
              { text: 'Agent 安装', link: '/zh-CN/guide/deploy-agent' },
              { text: 'Yeaft 引擎配置', link: '/zh-CN/guide/yeaft-config' },
            ],
          },
          {
            text: '用户指南',
            items: [
              { text: '登录与注册', link: '/zh-CN/guide/user/login' },
              { text: '选择会话后端', link: '/zh-CN/guide/user/choose-backend' },
              { text: 'Claude Code Chat', link: '/zh-CN/guide/user/chat-mode' },
              { text: 'Copilot 模式', link: '/zh-CN/guide/user/copilot-mode' },
              { text: 'Yeaft Group Mode', link: '/zh-CN/guide/user/yeaft-group' },
              { text: 'Crew 团队协作', link: '/zh-CN/guide/user/crew' },
              { text: '帮帮团', link: '/zh-CN/guide/user/expert-panel' },
              { text: '分屏模式', link: '/zh-CN/guide/user/split-screen' },
              { text: 'Workbench 工作台', link: '/zh-CN/guide/user/workbench' },
              { text: '仪表板（管理员）', link: '/zh-CN/guide/features-dashboard' },
              { text: '设置', link: '/zh-CN/guide/user/settings' },
              { text: '快捷键', link: '/zh-CN/guide/user/shortcuts' },
            ],
          },
          {
            text: '技术实现',
            items: [
              { text: '架构总览', link: '/zh-CN/guide/tech/architecture' },
              { text: 'Provider 系统', link: '/zh-CN/guide/tech/providers' },
              { text: 'Yeaft 引擎', link: '/zh-CN/guide/tech/yeaft-engine' },
              { text: 'Yeaft 记忆系统（H2-AMS）', link: '/zh-CN/guide/tech/yeaft-memory' },
              { text: 'Yeaft LLM 层', link: '/zh-CN/guide/tech/yeaft-llm' },
              { text: 'WebSocket 协议', link: '/zh-CN/guide/tech/wire-protocol' },
              { text: '安全', link: '/zh-CN/guide/security' },
              { text: 'Agent CLI', link: '/zh-CN/guide/agent-cli' },
            ],
          },
          {
            text: '参考',
            items: [
              { text: '常见问题', link: '/zh-CN/guide/faq' },
              { text: '配置文件参考', link: '/zh-CN/guide/reference/config-reference' },
              { text: '完整用户手册（单页）', link: '/zh-CN/USER_GUIDE' },
            ],
          },
        ],
      },
    },
  },

  themeConfig: {
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/yeaft/claude-web-chat' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright 2024-present Yeaft',
    },
  },
})
