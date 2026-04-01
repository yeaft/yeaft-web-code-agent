import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Claude Web Chat',
  description: 'A web interface for remotely accessing Claude Code CLI',
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
          { text: 'Guide', link: '/guide/getting-started' },
          { text: 'User Guide', link: '/USER_GUIDE' },
          { text: 'GitHub', link: 'https://github.com/yeaft/claude-web-chat' },
        ],
        sidebar: [
          {
            text: 'Introduction',
            items: [
              { text: 'What is Claude Web Chat?', link: '/guide/introduction' },
              { text: 'Getting Started', link: '/guide/getting-started' },
            ],
          },
          {
            text: 'Deployment',
            items: [
              { text: 'Server (Docker)', link: '/guide/deploy-server' },
              { text: 'Agent Setup', link: '/guide/deploy-agent' },
            ],
          },
          {
            text: 'Features',
            items: [
              { text: 'Chat', link: '/guide/features-chat' },
              { text: 'Split Screen', link: '/guide/features-split-screen' },
              { text: 'Expert Panel', link: '/guide/features-expert-panel' },
              { text: 'Crew', link: '/guide/features-crew' },
              { text: 'Dashboard', link: '/guide/features-dashboard' },
              { text: 'Workbench', link: '/guide/features-workbench' },
              { text: 'User Guide', link: '/USER_GUIDE' },
            ],
          },
          {
            text: 'Reference',
            items: [
              { text: 'Security', link: '/guide/security' },
              { text: 'Agent CLI', link: '/guide/agent-cli' },
              { text: 'Architecture', link: '/guide/architecture' },
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
          { text: '指南', link: '/zh-CN/guide/getting-started' },
          { text: '用户手册', link: '/zh-CN/USER_GUIDE' },
          { text: 'GitHub', link: 'https://github.com/yeaft/claude-web-chat' },
        ],
        sidebar: [
          {
            text: '介绍',
            items: [
              { text: '什么是 Claude Web Chat？', link: '/zh-CN/guide/introduction' },
              { text: '快速开始', link: '/zh-CN/guide/getting-started' },
            ],
          },
          {
            text: '部署',
            items: [
              { text: '服务器 (Docker)', link: '/zh-CN/guide/deploy-server' },
              { text: 'Agent 安装', link: '/zh-CN/guide/deploy-agent' },
            ],
          },
          {
            text: '功能',
            items: [
              { text: 'Chat 聊天', link: '/zh-CN/guide/features-chat' },
              { text: '分屏模式', link: '/zh-CN/guide/features-split-screen' },
              { text: '帮帮团', link: '/zh-CN/guide/features-expert-panel' },
              { text: 'Crew 多角色协作', link: '/zh-CN/guide/features-crew' },
              { text: '仪表板', link: '/zh-CN/guide/features-dashboard' },
              { text: 'Workbench 工作台', link: '/zh-CN/guide/features-workbench' },
              { text: '用户手册', link: '/zh-CN/USER_GUIDE' },
            ],
          },
          {
            text: '参考',
            items: [
              { text: '安全', link: '/zh-CN/guide/security' },
              { text: 'Agent CLI', link: '/zh-CN/guide/agent-cli' },
              { text: '架构', link: '/zh-CN/guide/architecture' },
              { text: '常见问题', link: '/zh-CN/guide/faq' },
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
