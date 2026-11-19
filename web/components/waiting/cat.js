/**
 * Running cat waiting animation: a small SVG cat that walks, breaks into a
 * run, tires, gets petted and naps, back and forth along the typing
 * indicator. Its looks and moods are CSS (styles/waiting/cat.css); this file
 * holds the markup and decides where the cat is and what it is doing.
 */
const PHASES = ['speed-napping', 'speed-normal', 'speed-fast', 'speed-turbo', 'speed-crazy', 'speed-tired', 'speed-petted'];
/** Room kept clear at the far end of the indicator, in px: the cat's own length. */
const TURNAROUND = 40;

/**
 * Where the cat is and what it is doing after `elapsedMs` of its 19 s loop.
 * @param {number} travelPx How far it can walk before turning round.
 * @returns {{ phase: string, transform: string }} Mood class and position.
 */
export function resolveRunningCatFrame(elapsedMs, travelPx = 0) {
  const elapsed = Math.max(0, elapsedMs) % 19000;
  let progress = 0;
  let direction = 1;
  let phase = 'speed-normal';

  // Start walking immediately. The old four-second nap made short tool calls
  // look like a static blinking cat and repeated streaming state transitions
  // could restart that nap indefinitely.
  if (elapsed < 2500) {
    progress = (elapsed / 2500) * 0.16;
  } else if (elapsed < 5000) {
    progress = 0.16 + ((elapsed - 2500) / 2500) * 0.29;
    phase = 'speed-fast';
  } else if (elapsed < 7500) {
    progress = 0.45 + ((elapsed - 5000) / 2500) * 0.55;
    phase = 'speed-turbo';
  } else if (elapsed < 10000) {
    progress = 1 - ((elapsed - 7500) / 2500);
    direction = -1;
    phase = 'speed-crazy';
  } else if (elapsed < 14000) {
    progress = 0;
    phase = 'speed-tired';
  } else if (elapsed < 16000) {
    progress = 0;
    phase = 'speed-petted';
  } else {
    progress = 0;
    phase = 'speed-napping';
  }

  return {
    phase,
    transform: `translate3d(${Math.max(0, travelPx) * progress}px, 0, 0) scaleX(${direction})`,
  };
}

const component = {
  name: 'CatWaiting',
  // The props every waiting animation is given. The cat uses neither: it
  // starts over with each indicator, and the indicator's status class tints it.
  props: {
    clockKey: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  template: `
    <span class="svg-cat-walk" ref="walkRef">
    <span class="svg-running-cat speed-normal" ref="spriteRef" aria-hidden="true">
      <svg viewBox="0 0 36 28" xmlns="http://www.w3.org/2000/svg">
        <!-- Silhouette group: single opacity prevents overlap darkening -->
        <g class="svg-cat-silhouette">
          <!-- Tail — starts at body edge for seamless connection -->
          <g class="svg-cat-tail-group">
            <path class="svg-cat-tail" d="M7.5 17 Q3 12 4 6 Q4.5 3 6 5" stroke-width="2"/>
          </g>
          <!-- Back legs -->
          <g class="svg-cat-leg-bl"><path class="svg-cat-leg" d="M10 20 L8 25 Q8 26.5 9.5 26.5 L10.5 26.5" stroke-width="0"/></g>
          <g class="svg-cat-leg-br"><path class="svg-cat-leg" d="M8 20 L6 25 Q6 26.5 7.5 26.5 L8.5 26.5" stroke-width="0"/></g>
          <!-- Body -->
          <ellipse class="svg-cat-body" cx="15" cy="17" rx="7.5" ry="5"/>
          <!-- Front legs -->
          <g class="svg-cat-leg-fl"><path class="svg-cat-leg" d="M21 20 L23 25 Q23 26.5 21.5 26.5 L20.5 26.5" stroke-width="0"/></g>
          <g class="svg-cat-leg-fr"><path class="svg-cat-leg" d="M19 20 L21 25 Q21 26.5 19.5 26.5 L18.5 26.5" stroke-width="0"/></g>
          <!-- Head group: contains head + face so tired animation moves everything together -->
          <g class="svg-cat-head-group">
            <circle class="svg-cat-head" cx="24" cy="9" r="7"/>
            <!-- Ears -->
            <g class="svg-cat-ear-l"><polygon class="svg-cat-ear" points="18,7 20,-1 23,6"/></g>
            <g class="svg-cat-ear-r"><polygon class="svg-cat-ear" points="25,6 28,-1 30,7"/></g>
            <!-- Face details (inside head group so they follow head movement) -->
            <polygon class="svg-cat-inner-ear" points="19,6.5 20.5,0.5 22,5.5"/>
            <polygon class="svg-cat-inner-ear" points="26,5.5 27.5,0.5 29,6.5"/>
            <ellipse class="svg-cat-eye" cx="21.5" cy="8.5" rx="2" ry="2.2"/>
            <ellipse class="svg-cat-eye" cx="27" cy="8.5" rx="2" ry="2.2"/>
            <ellipse class="svg-cat-pupil" cx="22" cy="8.8" rx="1.1" ry="1.3"/>
            <ellipse class="svg-cat-pupil" cx="27.5" cy="8.8" rx="1.1" ry="1.3"/>
            <circle class="svg-cat-eye-shine" cx="21.2" cy="7.8" r="0.6"/>
            <circle class="svg-cat-eye-shine" cx="26.7" cy="7.8" r="0.6"/>
            <!-- Closed happy eyes — curved ∪ lines, only visible in petted mode -->
            <path class="svg-cat-closed-eye" d="M19.8 8.5 Q21.5 10.5 23.2 8.5" stroke-width="0.8" fill="none"/>
            <path class="svg-cat-closed-eye" d="M25.3 8.5 Q27 10.5 28.7 8.5" stroke-width="0.8" fill="none"/>
            <path class="svg-cat-nose" d="M23.5 11.5 L24.2 12.2 L25 11.5 Z"/>
            <path class="svg-cat-mouth" d="M23 12.5 Q24.2 13.8 24.2 12.5" stroke-width="0.7"/>
            <path class="svg-cat-mouth" d="M24.3 12.5 Q24.3 13.8 25.5 12.5" stroke-width="0.7"/>
            <line class="svg-cat-whisker" x1="19.5" y1="11" x2="14" y2="10" stroke-width="0.5"/>
            <line class="svg-cat-whisker" x1="19.5" y1="12" x2="14" y2="12.5" stroke-width="0.5"/>
            <line class="svg-cat-whisker" x1="29" y1="11" x2="34" y2="10" stroke-width="0.5"/>
            <line class="svg-cat-whisker" x1="29" y1="12" x2="34" y2="12.5" stroke-width="0.5"/>
            <!-- Breath puffs — only visible in tired mode -->
            <circle class="svg-cat-breath svg-cat-breath-1" cx="27" cy="14" r="0.8"/>
            <circle class="svg-cat-breath svg-cat-breath-2" cx="28" cy="13.5" r="0.6"/>
            <circle class="svg-cat-breath svg-cat-breath-3" cx="29" cy="14.5" r="0.5"/>
          </g>
        </g>
        <!-- Blur legs (outside silhouette — has own opacity control) -->
        <ellipse class="svg-cat-leg-blur" cx="12.5" cy="22" rx="1.8" ry="1.2"/>
        <ellipse class="svg-cat-leg-blur" cx="17.5" cy="22" rx="1.8" ry="1.2"/>
        <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="14" cy="22" rx="1.5" ry="1"/>
        <ellipse class="svg-cat-leg-blur svg-cat-leg-blur-inner" cx="16" cy="22" rx="1.5" ry="1"/>
        <!-- Petting hand — only visible in speed-petted mode -->
        <g class="svg-cat-petting-hand">
          <line class="svg-cat-hand-arm" x1="24" y1="-3" x2="24" y2="0" stroke-width="2.5" stroke-linecap="round"/>
          <ellipse class="svg-cat-hand-palm" cx="24" cy="1.5" rx="3.5" ry="2"/>
          <ellipse class="svg-cat-finger" cx="21.5" cy="3.2" rx="0.9" ry="1.2"/>
          <ellipse class="svg-cat-finger" cx="24" cy="3.5" rx="0.9" ry="1.3"/>
          <ellipse class="svg-cat-finger" cx="26.5" cy="3.2" rx="0.9" ry="1.2"/>
        </g>
        <!-- Napping bed — soft oval cushion, only visible in napping mode -->
        <ellipse class="svg-cat-bed" cx="15" cy="24" rx="12" ry="3"/>
        <!-- Drool — tiny droplet near mouth, only visible in napping mode -->
        <circle class="svg-cat-drool" cx="26.5" cy="14" r="0.6"/>
      </svg>
    </span>
    </span>
  `,
  setup() {
    const walkRef = Vue.ref(null);
    const spriteRef = Vue.ref(null);
    let startedAt = 0;
    let frameId = null;

    // Position and mood are written straight to the DOM. Driving them through
    // reactive state re-rendered the whole transcript sixty times a second.
    const tick = () => {
      const walk = walkRef.value;
      const sprite = spriteRef.value;
      if (walk && sprite) {
        const travelPx = Math.max(0, (walk.parentElement?.clientWidth || 0) - TURNAROUND);
        const frame = resolveRunningCatFrame(Date.now() - startedAt, travelPx);
        walk.style.transform = frame.transform;
        for (const phase of PHASES) sprite.classList.toggle(phase, phase === frame.phase);
      }
      frameId = requestAnimationFrame(tick);
    };

    Vue.onMounted(() => {
      startedAt = Date.now();
      frameId = requestAnimationFrame(tick);
    });
    Vue.onBeforeUnmount(() => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
    });

    return { walkRef, spriteRef };
  },
};

export default { id: 'cat', layout: 'inline', component };
