import { HOOPS_POSTER_MS, resolveHoopsPlay } from '../utils/hoops-play.js';
import { resolveHoopsCamera } from '../utils/hoops-camera.js';
import { drawHoopsFrame, readHoopsPalette } from '../utils/hoops-draw.js';
import { readWaitClock } from '../utils/wait-clock.js';

/** Statuses where nothing is progressing: the play holds still instead of running on. */
const STALLED = new Set(['disconnected', 'agent-offline', 'session-lost', 'cli-exited']);
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Waiting scene: a basketball possession drawn on a canvas while a turn runs.
 * Decorative, so it is hidden from assistive tech; the surrounding UI states
 * what is happening.
 *
 * Every instance is a camera on the same play. Instances sharing a `clockKey`
 * read one clock (see wait-clock.js) and stay in step without talking to each
 * other, so the scene is not tied to any one component.
 *
 * Props
 *   view      'court' — strip under a transcript; 'broadcast' — screen in the status pane.
 *   clockKey  Identity of the wait being shown.
 *   status    Waiting status of the conversation; tints the scene, and stalled
 *             statuses hold a still frame.
 */
export default {
  name: 'HoopsScene',
  props: {
    view: { type: String, default: 'court' },
    clockKey: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  template: `
    <span class="hoops-scene" :class="['hoops-scene-' + view, status ? 'is-' + status : '']" aria-hidden="true">
      <canvas ref="canvasRef" class="hoops-scene-canvas"></canvas>
    </span>
  `,
  setup(props) {
    const canvasRef = Vue.ref(null);
    let host = null;
    let ctx = null;
    let palette = null;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let frameId = null;
    let onScreen = false;
    let reducedMotion = false;
    let sizeObserver = null;
    let viewObserver = null;
    let themeObserver = null;
    let motionQuery = null;

    const held = () => reducedMotion || STALLED.has(props.status);

    const paint = () => {
      if (!ctx || width < 8 || height < 8) return;
      const now = Date.now();
      const play = resolveHoopsPlay(held() ? HOOPS_POSTER_MS : now - readWaitClock(props.clockKey, now));
      const camera = resolveHoopsCamera(props.view, play, width, height);
      if (!palette) palette = readHoopsPalette(host, ctx);
      drawHoopsFrame(ctx, { play, camera, width, height, dpr, palette, view: props.view });
      // Where the play is, for tests and debugging. Written only on change.
      if (host.dataset.beat !== play.beat) host.dataset.beat = play.beat;
      if (host.dataset.shot !== camera.shot) host.dataset.shot = camera.shot;
    };

    const tick = () => {
      frameId = null;
      paint();
      if (onScreen && !held()) frameId = requestAnimationFrame(tick);
    };

    /** Repaint now and (re)start the loop only while the scene is visible and playing. */
    const refresh = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      paint();
      if (onScreen && !held()) frameId = requestAnimationFrame(tick);
    };

    const resize = () => {
      const canvas = canvasRef.value;
      if (!canvas || !host) return;
      width = host.clientWidth;
      height = host.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      refresh();
    };

    const repaletted = () => {
      palette = null;
      refresh();
    };
    const onMotionChange = (event) => {
      reducedMotion = event.matches;
      refresh();
    };

    Vue.onMounted(() => {
      const canvas = canvasRef.value;
      host = canvas?.parentElement || null;
      ctx = canvas?.getContext?.('2d') || null;
      if (!host || !ctx) return;
      motionQuery = window.matchMedia?.(REDUCED_MOTION) || null;
      reducedMotion = !!motionQuery?.matches;
      motionQuery?.addEventListener?.('change', onMotionChange);
      sizeObserver = new ResizeObserver(resize);
      sizeObserver.observe(host);
      // Off-screen scenes neither draw nor keep the clock alive.
      viewObserver = new IntersectionObserver((entries) => {
        onScreen = entries.some(entry => entry.isIntersecting);
        refresh();
      });
      viewObserver.observe(host);
      themeObserver = new MutationObserver(repaletted);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      resize();
    });

    // The status class changes the tint tokens; wait for the DOM before re-reading them.
    Vue.watch(() => props.status, () => Vue.nextTick(repaletted));
    Vue.watch(() => [props.view, props.clockKey], refresh);

    Vue.onBeforeUnmount(() => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      sizeObserver?.disconnect();
      viewObserver?.disconnect();
      themeObserver?.disconnect();
      motionQuery?.removeEventListener?.('change', onMotionChange);
    });

    return { canvasRef };
  },
};
