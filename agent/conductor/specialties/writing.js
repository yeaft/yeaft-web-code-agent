/**
 * Conductor — Writing 场景特有 Specialty 定义
 * writing, pacing, editing
 */

export const writingSpecialties = {
  writing: {
    id: 'writing',
    displayName: 'Writing（撰写）',
    thinkingMode: 'convergent',
    input: '章节大纲 + 节奏方案 + 角色设定',
    output: '正文章节（2000-4000字/章）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: ['内容文件'],
      forbidden: []
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        zhouzi: `现在是动笔的时候了：
- **对白即性格**：每个角色的说话方式不同——用词、语气、口癖都是人设的一部分
- **幽默从角色长出来**：梗不是硬插的，是角色在那个情境下自然会说的话
- **搞笑中夹私货**：看起来是段子的句子，可能藏着伏笔或情感种子
- **节奏如呼吸**：轻松-正经-轻松-燃-刀，节奏错了一切都废
- **章末钩子必杀**：断章是一门艺术，让读者骂着"这个作者真该死"然后点下一章
- **按大纲和节奏方案执行**：不自作主张改剧情走向`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的风格撰写正文：
- 按大纲和节奏方案执行
- 对白和叙述自然流畅
- 每章保持2000-4000字`;
    },

    getOutputFormat() {
      return `正文章节产出：
1. 章节正文（2000-4000字）
2. 章末钩子（让读者继续看的理由）
3. 伏笔清单（本章埋设/回收的伏笔）
4. 自评（节奏感、对白质量、爽点落地情况）`;
    }
  },

  pacing: {
    id: 'pacing',
    displayName: 'Pacing（节奏设计）',
    thinkingMode: 'divergent',
    input: '卷纲/大纲 + 人物关系',
    output: '爽点节奏方案（每章的爽点类型 + 章末钩子 + 情绪曲线）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: ['memory.md'],
      forbidden: ['内容正文']
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        zhouzi: `你是节奏大师，这是你最擅长的：
- **压3爽7黄金比例**：30%铺垫，70%爽点——不是每章，是整体节奏
- **爽点类型多样化**：反转、装逼打脸、温情、燃战、下刀——不能单调
- **章末钩子设计**：每章结尾必须让读者手痒，断章技巧是核心竞争力
- **情绪过山车**：大爽前必有压抑，大刀前必有温情——反差出效果
- **阅读体感模拟**：闭眼想象自己是读者，这段看到什么感觉？想跳过吗？`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的直觉设计节奏：
- 标注每章的爽点类型和情绪基调
- 设计章末钩子
- 绘制整体情绪曲线`;
    },

    getOutputFormat() {
      return `爽点节奏方案：
1. 整体情绪曲线（图表描述）
2. 逐章节奏表：
   - 章节号 + 爽点类型 + 情绪基调 + 章末钩子
3. 压爽比例分析
4. 关键转折点标注`;
    }
  },

  editing: {
    id: 'editing',
    displayName: 'Editing（审稿）',
    thinkingMode: 'convergent',
    input: '正文 + 设定文档 + 伏笔账本',
    output: '审稿报告（设定一致性/时间线/人物逻辑/爽点落地/文字质量）',
    toolRules: {
      readonly: ['Read', 'Grep', 'Glob'],
      writable: [],
      forbidden: ['正文修改（你是审稿者，不是修改者）']
    },
    getPersonalizedBehavior(persona) {
      const behaviors = {
        maboyong: `你用考据级的严格标准审稿：
- **设定一致性**：世界观圣经是宪法，正文不得与设定矛盾——零容忍
- **时间线核查**：角色在 A 地做完某事，到 B 地需要多少时间？对得上吗？
- **人物逻辑**：这个角色在这个情境下会说这句话/做这个事吗？符合 TA 的性格吗？
- **爽点落地**：大纲设计的爽点在正文中是否真正兑现了？效果如何？
- **文字质量**：有没有病句、重复用词、节奏拖沓？
- **毒舌但建设性**：指出问题必须给修改建议，不能只说"这不行"`
      };

      return behaviors[persona.id] || `你用 ${persona.name} 的标准审稿：
- 逐项检查设定一致性、时间线、人物逻辑
- 评估爽点落地和文字质量
- 指出问题并给出修改建议`;
    },

    getOutputFormat() {
      return `审稿报告：
1. 设定一致性检查（pass/fail + 矛盾清单）
2. 时间线核查（pass/fail + 问题标注）
3. 人物逻辑检查（pass/fail + 不合理行为清单）
4. 爽点落地评估（每个爽点：设计 vs 实际效果）
5. 文字质量评分
6. 修改建议清单（必须改 + 建议改）
7. 总体评价：pass / fail`;
    }
  }
};
