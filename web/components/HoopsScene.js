import { HOOPS_POSTER_MS, resolveHoopsPlay } from '../utils/hoops-play.js';
import { resolveHoopsCamera } from '../utils/hoops-camera.js';
import { drawHoopsFrame, readHoopsPalette } from '../utils/hoops-draw.js';
import { readWaitClock } from '../utils/wait-clock.js';

/** Statuses where nothing is progressing: the play holds still instead of running on. */
const STALLED = new Set(['disconnected', 'agent-offline', 'session-lost', 'cli-exited']);
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * Basketball waiting animation: one possession drawn on a canvas in the
 * typing indicator while a turn runs. Decorative, so it is hidden from
 * assistive tech; the surrounding UI states what is happening.
 *
 * The play is a function of the wait clock (see wait-clock.js), not of this
 * component, so a re-created indicator resumes the possession in progress.
 *
 * Props
 *   clockKey  Identity of the wait being shown.
 *   status    Waiting status of the conversation; tints the scene, and stalled
 *             statuses hold a still frame.
 */
export default {
  name: 'HoopsScene',
  props: {
    clockKey: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  template: `
    <div class="hoops-scene" :class="status ? 'is-' + status : ''" aria-hidden="true">
      <canvas ref="canvasRef" class="hoops-scene-canvas"></canvas>
    </div>
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
    let disposed = false;
    let sizeObserver = null;
    let viewObserver = null;
    let themeObserver = null;
    let motionQuery = null;

    const held = () => reducedMotion || STALLED.has(props.status);
    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 3);

    const paint = () => {
      if (!ctx || width < 8 || height < 16) return;
      const still = held();
      const now = Date.now();
      const play = resolveHoopsPlay(still ? HOOPS_POSTER_MS : now - readWaitClock(props.clockKey, now));
      const camera = resolveHoopsCamera(play, width, height);
      if (!palette) palette = readHoopsPalette(host, ctx);
      drawHoopsFrame(ctx, { play, camera, width, height, dpr, palette });
      // Where the play is, for tests and debugging. Written only on change.
      if (host.dataset.beat !== play.beat) host.dataset.beat = play.beat;
      if (host.dataset.shot !== camera.shot) host.dataset.shot = camera.shot;
      if (host.dataset.held !== String(still)) host.dataset.held = String(still);
    };

    const resize = () => {
      const canvas = canvasRef.value;
      if (disposed || !canvas || !host) return;
      width = host.clientWidth;
      height = host.clientHeight;
      dpr = pixelRatio();
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      refresh();
    };

    const tick = () => {
      frameId = null;
      if (disposed) return;
      // Browser zoom or a move between monitors changes the ratio without a resize.
      if (pixelRatio() !== dpr) { resize(); return; }
      paint();
      if (onScreen && !held()) frameId = requestAnimationFrame(tick);
    };

    /** Repaint now, and run the loop only while the scene is on screen and playing. */
    function refresh() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      if (disposed) return;
      paint();
      if (onScreen && !held()) frameId = requestAnimationFrame(tick);
    }

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
      if (typeof ResizeObserver === 'function') {
        sizeObserver = new ResizeObserver(resize);
        sizeObserver.observe(host);
      }
      // An off-screen scene neither draws nor keeps its clock alive.
      if (typeof IntersectionObserver === 'function') {
        viewObserver = new IntersectionObserver((entries) => {
          // Entries are in time order; the last one is the current state.
          onScreen = entries[entries.length - 1].isIntersecting;
          refresh();
        });
        viewObserver.observe(host);
      } else {
        onScreen = true;
      }
      themeObserver = new MutationObserver(repaletted);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      resize();
    });

    // Post-flush watchers run after the status class is in the DOM, so the
    // tint tokens can be re-read, and stop with the component.
    Vue.watch(() => props.status, repaletted, { flush: 'post' });
    Vue.watch(() => props.clockKey, refresh, { flush: 'post' });

    Vue.onBeforeUnmount(() => {
      disposed = true;
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
