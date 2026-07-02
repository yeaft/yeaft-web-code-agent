const deckBase = window.SLIDE_META?.base || './';
const slides = [
  { id: 'index', href: `${deckBase}index.html`, num: '00', title: 'Start', zh: '开场', kicker: 'Course frame' },
  { id: 'why', href: `${deckBase}sections/01-why.html`, num: '01', title: 'Why build Yeaft', zh: '为什么做 Yeaft', kicker: 'Motivation' },
  { id: 'picture', href: `${deckBase}sections/02-picture.html`, num: '02', title: 'Yeaft in one picture', zh: '一张图看 Yeaft', kicker: 'Mental model' },
  { id: 'architecture', href: `${deckBase}sections/03-architecture.html`, num: '03', title: 'High-level architecture', zh: '高层架构', kicker: 'System map' },
  { id: 'orchestrator', href: `${deckBase}sections/04-orchestrator.html`, num: '04', title: 'Orchestrator', zh: '编排器', kicker: 'Turn loop' },
  { id: 'context', href: `${deckBase}sections/05-context.html`, num: '05', title: 'Context', zh: '上下文', kicker: 'Prompt / memory / dream' },
  { id: 'tools', href: `${deckBase}sections/06-tools.html`, num: '06', title: 'Tools, Skills, MCP', zh: '工具、技能、MCP', kicker: 'Action surface' },
  { id: 'vp-session', href: `${deckBase}sections/07-vp-session.html`, num: '07', title: 'VP + Session', zh: 'VP 与 Session', kicker: 'Multi-agent unit' },
  { id: 'llm', href: `${deckBase}sections/08-llm-provider.html`, num: '08', title: 'LLM provider', zh: '模型供应商', kicker: 'Adapter router' },
  { id: 'session-management', href: `${deckBase}sections/09-session-management.html`, num: '09', title: 'Session management', zh: '会话管理', kicker: 'Persistence' },
  { id: 'debug', href: `${deckBase}sections/10-debug.html`, num: '10', title: 'Debug', zh: '调试观测', kicker: 'Traceability' },
  { id: 'wrap', href: `${deckBase}sections/11-wrap.html`, num: '11', title: 'Wrap-up', zh: '收束', kicker: 'Build lens' }
];

function currentIndex() {
  const id = window.SLIDE_META?.id || 'index';
  return Math.max(0, slides.findIndex((slide) => slide.id === id));
}

function getLang() {
  return localStorage.getItem('insideYeaftSlidesLang') || 'en';
}

function setLang(lang) {
  localStorage.setItem('insideYeaftSlidesLang', lang);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.body.classList.toggle('lang-zh', lang === 'zh');
  document.body.classList.toggle('lang-en', lang !== 'zh');
  document.querySelectorAll('[data-lang-label]').forEach((el) => {
    el.textContent = lang === 'zh' ? 'EN' : '中文';
  });
}

function renderChrome() {
  const active = currentIndex();
  const sidebar = document.querySelector('[data-sidebar]');
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="brand-mark">
        <div class="brand-logo">Y</div>
        <div>
          <div class="brand-title">Inside Yeaft</div>
          <div class="brand-subtitle">Code Agent architecture deck</div>
        </div>
      </div>
      <div class="sidebar-tools">
        <button class="tool-button" type="button" data-lang-toggle><span data-lang-label></span></button>
        <a class="tool-button mini-link" href="${deckBase}index.html">Index</a>
      </div>
      <nav class="slide-nav" aria-label="Slide navigation">
        ${slides.map((slide, index) => `
          <a class="nav-link ${index === active ? 'is-active' : ''}" href="${slide.href}">
            <span class="nav-index">${slide.num}</span>
            <span>
              <span class="nav-title"><span data-en>${slide.title}</span><span data-zh>${slide.zh}</span></span>
              <span class="nav-kicker">${slide.kicker}</span>
            </span>
          </a>`).join('')}
      </nav>
      <div class="sidebar-footer">
        <span data-en>Use ← / → to move, T to translate. The sidebar is the jump map; slide controls stay outside the content.</span>
        <span data-zh>使用 ← / → 翻页，按 T 切换中英。左侧栏负责快速跳转，翻页控制不会侵入幻灯片内容。</span>
      </div>`;
  }

  const prev = slides[active - 1];
  const next = slides[active + 1];
  const controls = document.querySelector('[data-controls]');
  if (controls) {
    controls.innerHTML = `
      <a class="float-arrow prev ${prev ? '' : 'is-disabled'}" href="${prev?.href || '#'}" aria-label="Previous slide">←</a>
      <a class="float-arrow next ${next ? '' : 'is-disabled'}" href="${next?.href || '#'}" aria-label="Next slide">→</a>
      <div class="progress-line"><span style="--progress: ${((active + 1) / slides.length) * 100}%"></span></div>`;
  }

  document.querySelectorAll('[data-lang-toggle]').forEach((button) => {
    button.addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
  });

  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if (event.key === 'ArrowLeft' && prev) window.location.href = prev.href;
    if (event.key === 'ArrowRight' && next) window.location.href = next.href;
    if (event.key.toLowerCase() === 't') setLang(getLang() === 'zh' ? 'en' : 'zh');
  });

  setLang(getLang());
}

document.addEventListener('DOMContentLoaded', renderChrome);
