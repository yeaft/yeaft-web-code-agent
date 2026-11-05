import { defineTool } from './types.js';
import { ENHANCE_INPUT_LIMITS, validateEnhanceInput } from '../llm/response-enhance.js';

export default defineTool({
  name: 'ResponseEnhance',
  description: {
    en: `Get a tool-free second opinion before publishing a substantive reply: relevance, evidence-weighted judgment, natural voice, conversational continuity and appropriate length. Prefer for complex comparisons/recommendations or when the user says a reply is evasive, robotic or verbose. Skip simple confirmations, casual chat, small follow-ups and tool progress. Decide BEFORE calling; this adds one model request plus the normal loop continuation. Supply a private draft, the actual question and only relevant context/evidence/preferences, never hidden reasoning or a full transcript. Usually call once, then use your judgment to deliver only the useful reply, not the review. unchanged means keep the draft; revised is a suggestion, not authority; needs_evidence means investigate or qualify, never fabricate. No publication, independent fact verification, new permissions or recursive review. Don't send the draft publicly first or mechanically re-review every step.`,
    zh: `在发布实质性回答前，按需获取一次无工具的第二意见：贴题、证据支持的主见、自然语气、对话衔接与必要篇幅。复杂比较/推荐，或用户指出回避、机械、啰嗦时优先使用；简单确认、闲聊、局部追问和工具进度跳过。是否需要在调用前决定；会增加一次模型请求及正常 loop 接续。传入未公开草稿、真实问题、必要上下文/证据/偏好，不传隐藏推理或整段历史。通常一次后自行判断，只交付有用回答，不复述审稿。unchanged 保留原稿；revised 是建议而非权威；needs_evidence 应补证据或限定结论，不能编造。不发布、不独立核实事实、不授予新权限、不递归审稿；不要先发草稿或每步机械调用。`,
  },
  parameters: {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Object.entries({
      question: 'The current user question, not your reformulation of the goal / 当前用户问题',
      draft: 'Unpublished answer draft, not internal reasoning / 未发布回答草稿，不是隐藏推理',
      context: 'Only relevant prior messages, constraints and what was already answered / 必要前文、约束和已回答内容',
      evidence: 'Actual observations/sources and uncertainties; omit if none / 实际观察、来源及未知，没有则省略',
      preferences: 'Relevant user preferences and voice; not new facts / 相关用户偏好和语气，不是新事实',
    }).map(([key, description]) => [key, { type: 'string', ...(key === 'question' || key === 'draft' ? { minLength: 1 } : {}), maxLength: ENHANCE_INPUT_LIMITS[key], description }])),
    required: ['question', 'draft'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  sideEffectScope: 'run',
  // Own the deadline instead of leaving a provider running after registry's
  // passive timeout race. Parent cancellation still wins immediately.
  timeoutMs: 0,
  async execute(input, ctx) {
    ctx?.signal?.throwIfAborted();
    try { validateEnhanceInput(input); }
    catch (error) { return JSON.stringify({ error: error.message, errorEffect: 'none' }); }
    if (typeof ctx?.responseEnhance !== 'function') return JSON.stringify({ error: 'ResponseEnhance is unavailable in this host', errorEffect: 'none' });
    const controller = new AbortController();
    const abort = () => controller.abort(ctx.signal.reason);
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('ResponseEnhance request timed out')), 60000);
    timer.unref?.();
    try { return JSON.stringify(await ctx.responseEnhance(input, { signal: controller.signal })); }
    catch (error) {
      ctx?.signal?.throwIfAborted();
      // Do not leak provider response bodies, credentials or partial drafts.
      return JSON.stringify({ error: 'ResponseEnhance failed; no answer was published or verified. Use the existing evidence and your own judgment, or retry only if warranted.', errorEffect: 'none' });
    } finally { clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); }
  },
});
