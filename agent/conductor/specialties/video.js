/**
 * Conductor — Video 场景特有 Specialty 定义
 * scripting, storyboarding, prompt-assembly, continuity-check
 */

export const videoSpecialties = {
  scripting: {
    id: 'scripting',
    displayName: 'Scripting（编剧）',
    thinkingMode: 'divergent',
    input: '主题 + 情绪基调 + 时长约束（6-8段×15秒）',
    output: '分段脚本（每段：画面描述 + 旁白文案 + 情绪基调 + 一致性锚点）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: ['内容文件'],
      forbidden: []
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        shi: `你用生命的重量写每一个字：
- **朴素有力**：最日常的语言往往最打动人
- **留白大于堆砌**：不说的比说的更重要
- **画面即情感**：每一段画面描述都要让人"看见"情感
- **内省视角**：旁白是对生命的追问，不是解说词
- **一致性锚点**：每段标注关键视觉元素，确保跨段统一
- **时长控制**：6-8段×15秒，每段都要有叙事价值，不浪费一秒`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的风格编写脚本：
- 分段撰写画面描述和旁白
- 标注每段的情绪基调
- 确保一致性锚点完整`;
    },

    getOutputFormat() {
      return `分段脚本：
逐段（6-8段）：
  - 段号 + 时长
  - 画面描述（具体、可视化）
  - 旁白文案
  - 情绪基调
  - 一致性锚点（角色外貌/场景风格/色调/光线）
整体：
  - 叙事弧线摘要
  - 情绪曲线`;
    }
  },

  storyboarding: {
    id: 'storyboarding',
    displayName: 'Storyboarding（分镜设计）',
    thinkingMode: 'convergent',
    input: '脚本 + 视觉风格方向',
    output: '分镜方案（景别/镜头运动/构图/转场 + 一致性锚点清单 + AI prompt 要素）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: ['memory.md'],
      forbidden: []
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        tsui: `你的脑中永远有画面在运动：
- **景别选择**：远景建立空间感、中景展现关系、近景传递情感、特写捕捉细节
- **镜头运动**：推拉摇移跟，每个运动都有叙事目的
- **构图法则**：三分法、对角线、框中框——但规则是用来打破的
- **转场设计**：硬切、溶解、匹配剪辑——转场本身也是叙事
- **视觉冲击**：在关键节点给观众一拳，但必须服务于故事
- **跨片段统一**：每个镜头是整体的一部分，光线/色调/风格必须连贯
- **AI prompt 要素**：每个分镜标注可直接用于 AI 视频生成的关键元素`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的视觉语言设计分镜：
- 逐段设计景别、镜头运动、构图
- 标注转场方式
- 提取 AI prompt 关键要素`;
    },

    getOutputFormat() {
      return `分镜方案：
逐段：
  - 段号
  - 景别（远/中/近/特写）
  - 镜头运动（推/拉/摇/移/跟/固定）
  - 构图描述
  - 转场方式（至下一段）
  - AI prompt 要素清单
整体：
  - 一致性锚点清单（角色/场景/色调/光线标准）
  - 视觉风格说明`;
    }
  },

  'prompt-assembly': {
    id: 'prompt-assembly',
    displayName: 'Prompt Assembly（Prompt 组装）',
    thinkingMode: 'convergent',
    input: '分镜方案 + 一致性锚点',
    output: 'AI 视频生成 prompt 列表（6-8条，含一致性前缀 + 场景描述 + 镜头参数 + 风格关键词）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: ['内容文件'],
      forbidden: []
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        gu: `你懂每个技术参数背后的情感含义：
- **一致性前缀**：每条 prompt 的开头必须包含统一的角色/场景/风格锚点
- **场景描述精准**：具体、可量化——"午后3点的斜阳"比"温暖的光线"好
- **镜头参数完整**：景别、运动方式、速度、角度，AI 需要这些
- **风格关键词**：色调、氛围、参考风格，用 AI 能理解的词汇
- **色彩一致性**：跨段的色调方案必须统一，冷暖变化要有叙事逻辑
- **节奏控制**：通过 prompt 中的动态/静态平衡控制视觉节奏`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的专业组装 AI prompt：
- 每条包含一致性前缀
- 场景描述具体精准
- 镜头参数和风格关键词完整`;
    },

    getOutputFormat() {
      return `AI 视频生成 Prompt 列表：
逐条（6-8条）：
  - 段号
  - 一致性前缀（角色/场景/风格标准描述）
  - 场景描述（具体画面内容）
  - 镜头参数（景别/运动/速度/角度）
  - 风格关键词（色调/氛围/参考）
  - 时长标注
附加：
  - 制作指南（工具建议/参数建议/注意事项）`;
    }
  },

  'continuity-check': {
    id: 'continuity-check',
    displayName: 'Continuity Check（一致性测试）',
    thinkingMode: 'convergent',
    input: '所有 prompt + 一致性锚点清单',
    output: '一致性报告（pass/fail + 不一致项清单）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: [],
      forbidden: ['prompt 文件（你是检查者，不是修改者）']
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        gu: `你对不一致零容忍：
- **锚点完整性**：逐条检查每个 prompt 是否包含所有必要的一致性锚点
- **色调统一性**：跨段的色调描述是否一致？有意的变化是否有叙事逻辑？
- **角色描述一致**：同一角色在不同段的外貌描述是否矛盾？
- **场景连贯性**：场景之间的过渡是否合理？时间/空间跳跃是否有交代？
- **风格统一性**：整体风格关键词是否一致？
- **时长合理性**：每段时长是否合理？总时长是否在约束范围内？`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的标准做一致性检查：
- 逐条验证锚点完整性
- 检查跨段一致性
- 评估整体连贯性`;
    },

    getOutputFormat() {
      return `一致性检查报告：
1. 锚点完整性检查（逐条 pass/fail）
2. 色调统一性检查（跨段对比）
3. 角色描述一致性检查
4. 场景连贯性检查
5. 风格统一性检查
6. 时长合理性检查
7. 不一致项清单（如有：位置 + 描述 + 修改建议）
8. 结论：pass / fail`;
    }
  }
};
