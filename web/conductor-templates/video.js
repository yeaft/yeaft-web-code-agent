/**
 * Video scenario persona pool for Conductor V2.
 * Each persona defines: id, name, displayName (for zh-CN UI), specialties, tags, and a short description.
 */
export default {
  id: 'video',
  name: 'Video',
  displayName: '视频创作',
  icon: '🎬',
  description: 'AI 短片创作团队：导演把控、脚本构思、分镜设计、Prompt 生成',
  color: '#f59e0b',
  specialties: [
    { id: 'planning', name: '导演', mode: 'divergent', description: '整体把控、叙事节奏、风格确定' },
    { id: 'scripting', name: '编剧', mode: 'divergent', description: '脚本构思、叙事结构、台词文案' },
    { id: 'discussion', name: '讨论', mode: 'divergent', description: '叙事/节奏分歧、视觉方向讨论' },
    { id: 'storyboarding', name: '分镜', mode: 'convergent', description: '分镜设计、视觉语言、镜头规划' },
    { id: 'prompt-assembly', name: 'Prompt', mode: 'convergent', description: '最终 AI 视频 prompt 组装' },
    { id: 'continuity-check', name: '一致性', mode: 'convergent', description: '跨片段一致性审查' },
    { id: 'review', name: '审核', mode: 'convergent', description: '脚本/分镜/prompt 及整体方案审核' },
  ],
  personas: [
    {
      id: 'jia',
      name: '贾樟柯',
      displayName: '贾樟柯',
      specialties: ['planning', 'discussion', 'review'],
      tags: ['narrative', 'realism', 'pacing'],
      description: '真实至上，克制表达，在平凡中发现史诗',
    },
    {
      id: 'shi',
      name: '史铁生',
      displayName: '史铁生',
      specialties: ['scripting', 'discussion'],
      tags: ['inner-voice', 'metaphor', 'restraint'],
      description: '内省深沉，朴素有力，善于留白',
    },
    {
      id: 'tsui',
      name: '徐克',
      displayName: '徐克',
      specialties: ['storyboarding'],
      tags: ['camera-language', 'visual-impact', 'transition'],
      description: '视觉想象力爆棚，镜头语言精准，追求视觉冲击',
    },
    {
      id: 'gu',
      name: '顾长卫',
      displayName: '顾长卫',
      specialties: ['prompt-assembly', 'continuity-check'],
      tags: ['color-grading', 'rhythm', 'consistency'],
      description: '技术与艺术兼备，节奏感极强，一致性偏执',
    },
  ],
};
