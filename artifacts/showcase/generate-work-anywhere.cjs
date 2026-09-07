// Eight-slide editorial edition. Reuses staged UI captures; does not recapture live data.
const pptxgen = require('pptxgenjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const out = __dirname;
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.author = 'Yeaft';
pptx.title = 'Yeaft — Work from anywhere.';
pptx.subject = 'Cross-device work, role handoffs, Workbench and development automation';
pptx.lang = 'en-US';
pptx.theme = { headFontFace: 'Liberation Sans', bodyFontFace: 'Liberation Sans', lang: 'en-US' };
const C = { bg: 'F4F1EA', paper: 'FFFFFF', ink: '1D1D1B', muted: '686761', line: 'D7D2C8', accent: '8B5E3C', soft: 'E9E2D8' };
pptx.defineSlideMaster({ title: 'EDITORIAL', background: { color: C.bg }, objects: [
  { text: { text: 'YEAFT', options: { x: .68, y: .3, w: 1.5, h: .22, fontSize: 10, bold: true, color: C.ink, charSpacing: 2, margin: 0 } } },
], slideNumber: { x: 12, y: 7.08, w: .6, h: .2, fontSize: 10, color: C.muted, align: 'right', margin: 0 } });
function text(s, v, x, y, w, h, size = 18, color = C.ink, bold = false, extra = {}) {
  s.addText(v, { x, y, w, h, fontSize: size, color, bold, margin: 0, valign: 'mid', ...extra });
}
function body(s, v, x, y, w, h, size = 17) { text(s, v, x, y, w, h, size, C.muted, false, { valign: 'top', paraSpaceAfterPt: 6 }); }
function title(s, label, heading, sub) {
  text(s, label.toUpperCase(), .7, .85, 11.9, .27, 11, C.accent, true, { charSpacing: 1.1 });
  text(s, heading, .7, 1.25, 11.9, .82, 30, C.ink, true);
  if (sub) body(s, sub, .73, 2.12, 11.8, .55, 15);
}
function box(s, x, y, w, h) { s.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: C.soft }, line: { color: C.line, width: .6 } }); }
function arrow(s, x, y, w) { s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color: C.accent, width: 1.5, endArrowType: 'triangle' } }); }
function foot(s, value) { text(s, value, .7, 7.02, 11.1, .28, 9, C.muted); }
const pictures = {};
function image(s, key, x, y, w, h) {
  const p = pictures[key];
  let iw = w, ih = w / p.ratio;
  if (ih > h) { ih = h; iw = h * p.ratio; }
  s.addImage({ path: p.file, x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih });
}
const times = ['0–10s', '10–23s', '23–40s', '40–52s', '52–67s', '67–84s', '84–102s', '102–110s'];
const narration = [
  'Work from anywhere. With Yeaft, your location can change without leaving the work behind. Connect to your AI team through a browser.',
  'At home, at the office, or on the move, reconnect to the same Agent and Session. The browser is your entry point; your online Agent provides the working environment.',
  'Bring in the right role for the next step. An investigator finds the cause, an implementer makes the change, and a reviewer challenges it. Explicit handoffs carry the task forward—not a fixed pipeline.',
  'Define each role with configurable system prompts. Add shared project rules, so responsibilities, coding conventions, and review expectations travel with the work.',
  'Go beyond chat with Workbench. Inspect the actual files, check command output, and stay close to what the Agent is doing. Delegate the work without losing visibility.',
  'For development automation, give AI a goal, constraints, and acceptance criteria. For example: fix a bug, add a regression test, and prepare a patch for review—not a script of step-by-step prompts.',
  'Work Center keeps the goal, execution progress, and evidence visible. Let ready work advance on the online Agent. Step in for decisions and judge completion against the acceptance criteria. Work Center is currently in Preview.',
  'Anywhere access. Clear responsibilities. Real tools. Goal-driven execution. Yeaft. Your AI team. Real work. From anywhere.',
];
const notes = [
  '定位从 phone-first 改为随处工作。用户不必守在原来的设备前；不暗示执行环境会跨 Agent 自动迁移。',
  '桌面与移动布局来自既有隔离 staged UI 截图，不是新完成的跨设备实测。相同 Agent + Session 可从不同浏览器访问；Server 可达、Agent 在线是前提。',
  'VP = Virtual Person。一个 Session 有 1..N 个 VP。Investigate → Implement → Review 是交接示意；显式 VP 转发使用路由工具，不是普通文本写 @ 就执行。左侧真实 UI 截图展示配置角色，不是此开发案例的交接证据。',
  '示例 System Prompt 不是 UI 截图，也不是强制安全策略。VP persona、Project instruction、仓库规则是不同层，指令不能替代权限和 sandbox。',
  'Files / Terminal 截图沿用真实 Vue 组件与 staged transport。终端只回放实际 node --check 结果，不是 bug 修复或完整回归测试证明。',
  '建议的开发场景，不是已完成案例。任务拆解由目标决定，不强制固定流水线。不默认允许部署；Session 与 Work Center 是不同对象，不声称自动转换。',
  'Work Center 保留 Preview。持久目标不意味着 Agent 离线可执行；恢复和重试受副作用安全约束。完成需要验收与证据，不等于模型停止输出。Work Center VP 选择独立于 Session 成员。',
  '收束到随处接入、角色协作和目标执行，不重复整套功能清单。仓库链接指向 README；不暗示已经自动部署或发布。',
];
function slide(i) { const s = pptx.addSlide('EDITORIAL'); s.addNotes(`${times[i]} | Suggested English narration\n${narration[i]}\n\n中文讲述提示与事实边界\n${notes[i]}`); return s; }
async function main() {
  const assets = { conversation: '04-session-conversation.png', mobile: '04-session-mobile.png', roster: '05-session-roster.png', files: '08-workbench-files-correct.png', terminal: '08-workbench-terminal-correct.png', work: '09-work-center-structure.png' };
  for (const [key, name] of Object.entries(assets)) {
    const file = path.join(out, 'work-anywhere-assets', name), b = await fs.readFile(file);
    if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error(`Invalid PNG ${name}`);
    pictures[key] = { file, ratio: b.readUInt32BE(16) / b.readUInt32BE(20) };
  }
  {
    const s = slide(0);
    text(s, 'YOUR AI WORKSPACE, WHEREVER YOU ARE', .73, 1.18, 11.8, .3, 12, C.accent, true, { charSpacing: 1.2 });
    text(s, 'Work from\nanywhere.', .7, 2.0, 11.8, 2.0, 58, C.ink, true);
    body(s, 'Your AI team. Your working environment.\nReady when you connect.', .76, 4.65, 11.5, 1.05, 24);
    text(s, 'ANYWHERE ACCESS   /   ROLE HANDOFFS   /   REAL WORK', .76, 6.42, 11.5, .32, 13, C.accent);
  }
  {
    const s = slide(1);
    title(s, 'Anywhere access', 'Different devices. The same working context.', 'At home. At the office. On the move. Reconnect to the same Agent + Session.');
    image(s, 'conversation', .72, 2.97, 5.0, 3.45);
    image(s, 'mobile', 5.96, 2.97, 1.64, 3.45);
    text(s, 'BROWSER = ENTRY POINT', 8.1, 3.12, 4.35, .35, 12, C.accent, true);
    body(s, 'Choose the device\nthat works for you.', 8.1, 3.65, 4.3, .98, 23);
    text(s, 'AGENT = WORKING ENVIRONMENT', 8.1, 5.04, 4.35, .35, 11, C.accent, true);
    body(s, 'Project files and execution\nstay with your connected Agent.', 8.1, 5.55, 4.3, .9, 18);
    foot(s, 'Real UI · Staged demo · Requires a reachable Server and an online Agent.');
  }
  {
    const s = slide(2);
    title(s, 'Multi-role collaboration + handoffs', 'The right role. The next step.', 'Start with one VP. Add distinct responsibilities when the task needs them.');
    image(s, 'roster', .72, 2.95, 5.7, 3.73);
    const steps = [['01', 'Investigate', 'Find the cause. Pass the findings.'], ['02', 'Implement', 'Make the change. Hand off the patch.'], ['03', 'Review', 'Challenge the result. Return a verdict.']];
    steps.forEach(([n, h, d], i) => {
      const y = 3.02 + i * 1.14;
      text(s, n, 6.95, y, .5, .33, 12, C.accent, true);
      text(s, h, 7.5, y - .05, 4.9, .46, 22, C.ink, true);
      body(s, d, 7.5, y + .5, 4.9, .43, 15);
      if (i < 2) text(s, '↓', 7.52, y + .89, .4, .26, 15, C.accent);
    });
    text(s, 'Explicit handoffs—not a fixed pipeline.', 6.95, 6.58, 5.65, .27, 14, C.accent);
    foot(s, 'Real UI · Staged role configuration · Handoff sequence is illustrative.');
  }
  {
    const s = slide(3);
    title(s, 'Configurable system prompts', 'Define the roles. Set the working rules.', 'VP personas + shared Project instructions + repository conventions.');
    text(s, 'ROLE / IMPLEMENTER', .78, 3.09, 5.5, .32, 12, C.accent, true);
    text(s, 'A clear responsibility.', .78, 3.67, 5.5, .5, 25, C.ink, true);
    body(s, '“Make the smallest useful change.\nReport tests and open risks.”', .78, 4.45, 5.3, 1.36, 23);
    text(s, 'SHARED RULES / EXAMPLE', 7.05, 3.09, 5.4, .32, 12, C.accent, true);
    text(s, 'Consistent standards.', 7.05, 3.67, 5.4, .5, 25, C.ink, true);
    body(s, '“Review the exact revision.\nAsk before deployment.”', 7.05, 4.45, 5.3, 1.36, 23);
    text(s, 'Set expectations once. Carry them into the work.', .78, 6.42, 11.8, .4, 20, C.accent);
    foot(s, 'Illustrative instructions · Prompts guide behavior; they are not a security sandbox.');
  }
  {
    const s = slide(4);
    title(s, 'Workbench', 'Beyond chat. A real workbench.', 'Inspect, verify, and intervene—not just wait for an answer.');
    text(s, 'FILES / ACTUAL SOURCE', .75, 2.99, 5.8, .33, 13, C.accent, true);
    text(s, 'TERMINAL / COMMAND OUTPUT', 6.85, 2.99, 5.7, .33, 13, C.accent, true);
    image(s, 'files', .73, 3.52, 5.85, 2.97);
    image(s, 'terminal', 6.8, 3.52, 5.85, 2.97);
    foot(s, 'Real UI · Staged inspection demo · Terminal shows recorded node --check output, not a full test suite.');
  }
  {
    const s = slide(5);
    title(s, 'Development automation · Preview', 'From a development goal to execution.', 'Describe the outcome—not every next prompt.');
    box(s, .76, 3.07, 5.5, 2.88);
    text(s, 'YOUR BRIEF / ILLUSTRATIVE', 1.05, 3.34, 4.9, .3, 12, C.accent, true);
    text(s, 'Fix the bug.\nAdd a regression test.\nPrepare a patch for review.', 1.05, 3.95, 4.9, 1.48, 25, C.ink, true);
    arrow(s, 6.45, 4.48, .88);
    text(s, 'AI ADVANCES THE WORK', 7.66, 3.34, 4.85, .3, 12, C.accent, true);
    body(s, 'Investigate and make changes.\nRun tools and checks.\nRecord results and open risks.', 7.66, 3.98, 4.85, 1.5, 22);
    text(s, 'Bound the task with constraints and acceptance criteria.', .78, 6.42, 11.8, .38, 19, C.accent);
    foot(s, 'Illustrative scenario—not a completed case study · Execution depends on configured tools and permissions.');
  }
  {
    const s = slide(6);
    title(s, 'Work Center · Preview', 'Keep the task moving. Keep control.', 'A persistent goal, visible execution, and an outcome you can evaluate.');
    image(s, 'work', .73, 3.0, 7.63, 3.69);
    const rows = [['KEEP THE GOAL', 'Save the objective and acceptance criteria.'], ['FOLLOW PROGRESS', 'See execution status. Resolve decisions.'], ['CHECK THE OUTCOME', 'Inspect evidence against the goal.']];
    rows.forEach(([h, d], i) => {
      const y = 3.08 + i * 1.17;
      text(s, h, 8.85, y, 3.7, .31, 12, C.accent, true);
      body(s, d, 8.85, y + .48, 3.7, .69, 18);
    });
    foot(s, 'Real UI · Staged inspection demo · Execution requires an online Agent. Work Center is separate from Session.');
  }
  {
    const s = slide(7);
    text(s, 'WORK FROM ANYWHERE.', .75, 1.2, 11.8, .3, 13, C.accent, true, { charSpacing: 1.3 });
    text(s, 'Your AI team.\nReal work.\nFrom anywhere.', .72, 2.03, 11.85, 2.67, 44, C.ink, true);
    body(s, 'Connect. Collaborate. Let the work move forward.', .78, 5.38, 11.7, .65, 23);
    text(s, 'github.com/yeaft/yeaft-web-code-agent', .78, 6.38, 11.7, .47, 22, C.accent, true, { hyperlink: { url: 'https://github.com/yeaft/yeaft-web-code-agent#readme' } });
  }
  const file = path.join(out, 'yeaft-work-anywhere.pptx');
  await pptx.writeFile({ fileName: file });
  const words = narration.join(' ').split(/\s+/).length;
  const track = ['# Yeaft — Work from anywhere.', '', `8 页英文 PPT；英文配音 ${words} 词；目标 110 秒（不是已渲染视频时长）。`, ''];
  narration.forEach((n, i) => track.push(`## ${i + 1} · ${times[i]}`, '', n, '', `中文提示：${notes[i]}`, ''));
  await fs.writeFile(path.join(out, 'work-anywhere-talk-track.md'), track.join('\n'));
  console.log(`Created ${file}: 8 slides, ${words} narration words.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
