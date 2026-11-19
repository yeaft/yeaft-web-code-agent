/**
 * Stage for canvas waiting animations: an area under the transcript that a
 * scene paints into. It has no surface of its own. The canvas is transparent
 * and scenes draw straight onto the page, so they must not fill a background
 * and their colours have to read on the page in both themes. The stage owns
 * everything a scene should not have to care about — sizing, pixel ratio,
 * theme changes, reduced motion, stalled connections, running only while on
 * screen — and the opening: a wait starts on a line of "waiting" text and
 * cuts to the scene after STAGE_INTRO_MS, so a reply that arrives at once
 * never flashes a full-size picture.
 *
 * A scene is a plain object:
 *   name       Component name.
 *   className  Class on the stage root. The scene's stylesheet hangs its
 *              colour tokens on it, and tests find the scene by it.
 *   tokens     { key: '--css-token' } colours to resolve for `paint`.
 *   posterMs   Scene time of the frame held for reduced motion and for
 *              connections that have stalled.
 *   paint(ctx, { elapsedMs, width, height, dpr, colors })
 *              Draw one frame. `elapsedMs` counts from the cut to the scene;
 *              `width`/`height` are CSS px and the context is already scaled
 *              by `dpr` and cleared. `colors[key]` is [r, g, b] and
 *              `colors.font` the UI font family. May return { beat, shot }
 *              to expose where the scene is, for tests and debugging.
 *
 * The scene is a function of the wait clock (see wait-clock.js), not of this
 * component, so a re-created indicator resumes the scene in progress.
 */
import { readWaitClock } from '../../utils/wait-clock.js';

/** How long a wait shows the "waiting" card before the stage cuts to the scene. */
export const STAGE_INTRO_MS = 900;
/** Height of the picture as a fraction of its width. */
export const STAGE_RATIO = 5 / 11;

/** Statuses where nothing is progressing: the scene holds still instead of running on. */
const STALLED = new Set(['disconnected', 'agent-offline', 'session-lost', 'cli-exited']);
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** [r, g, b] (0–255) as a CSS colour. */
export const rgb = ([r, g, b], alpha = 1) => (alpha >= 1
  ? `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
  : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.max(0, alpha).toFixed(3)})`);
/** Mix two [r, g, b] colours; `u` = 0 gives `a`, 1 gives `b`. */
export const blend = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

function parseColor(ctx, value) {
  if (!value) return [128, 128, 128];
  // Let the canvas normalise any CSS colour syntax to #rrggbb or rgba().
  // Alpha is dropped: scene tokens are opaque, and scenes apply their own.
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  const normal = String(ctx.fillStyle);
  if (normal.startsWith('#') && normal.length === 7) {
    return [parseInt(normal.slice(1, 3), 16), parseInt(normal.slice(3, 5), 16), parseInt(normal.slice(5, 7), 16)];
  }
  const parts = normal.match(/[\d.]+/g);
  return parts && parts.length >= 3 ? parts.slice(0, 3).map(Number) : [128, 128, 128];
}

/**
 * Resolve a scene's colour tokens on its stage element.
 * @param {Element} host Stage root carrying the tokens.
 * @param {CanvasRenderingContext2D} ctx Any 2D context, used to parse colours.
 * @param {Record<string, string>} tokens { key: '--css-token' }.
 * @returns {Record<string, number[]|string>} [r, g, b] per key, plus `font`.
 */
export function readStageColors(host, ctx, tokens) {
  const style = getComputedStyle(host);
  const colors = { font: style.fontFamily || 'sans-serif' };
  for (const [key, token] of Object.entries(tokens || {})) colors[key] = parseColor(ctx, style.getPropertyValue(token).trim());
  return colors;
}

/**
 * @param scene Scene definition (see the module comment).
 * @returns Vue component taking `clockKey` (identity of the wait being shown)
 *   and `status` (waiting status of the conversation).
 */
export function createStageAnimation(scene) {
  return {
    name: scene.name,
    props: {
      clockKey: { type: String, default: '' },
      status: { type: String, default: '' },
    },
    template: `
      <div class="waiting-stage" :class="[sceneClass, { 'is-open': open, 'is-cut': cut }, status ? 'is-' + status : '']" aria-hidden="true">
        <span v-if="!open" class="waiting-stage-intro">{{ $t('chat.waiting.stageIntro') }}</span>
        <canvas ref="canvasRef" class="waiting-stage-canvas"></canvas>
      </div>
    `,
    setup(props) {
      const canvasRef = Vue.ref(null);
      // Closed shows the "waiting" card; open shows the scene.
      const open = Vue.ref(false);
      // Set when this stage itself went from the card to the scene, which
      // plays the cut. A stage re-created mid-scene opens without one.
      const cut = Vue.ref(false);
      let host = null;
      let ctx = null;
      let colors = null;
      let width = 0;
      let height = 0;
      let dpr = 1;
      let frameId = null;
      let openTimer = null;
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
        if (!ctx || !open.value || width < 8) return;
        const still = held();
        const now = Date.now();
        const elapsedMs = still ? scene.posterMs : Math.max(0, now - readWaitClock(props.clockKey, now) - STAGE_INTRO_MS);
        if (!colors) colors = readStageColors(host, ctx, scene.tokens);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const where = scene.paint(ctx, { elapsedMs, width, height, dpr, colors }) || {};
        // Where the scene is, for tests and debugging. Written only on change.
        if (host.dataset.beat !== (where.beat || '')) host.dataset.beat = where.beat || '';
        if (host.dataset.shot !== (where.shot || '')) host.dataset.shot = where.shot || '';
        if (host.dataset.held !== String(still)) host.dataset.held = String(still);
      };

      const resize = () => {
        const canvas = canvasRef.value;
        if (disposed || !canvas || !host) return;
        // The picture's height follows its width. The box's own height is
        // still animating open when this first runs, and reports a resize on
        // every frame of that; only a new width or pixel ratio needs a new
        // backing store.
        if (host.clientWidth === width && pixelRatio() === dpr) return;
        width = host.clientWidth;
        height = Math.round(width * STAGE_RATIO);
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
        if (open.value && onScreen && !held()) frameId = requestAnimationFrame(tick);
      };

      /** Repaint now, and run the loop only while the scene is open, on screen and playing. */
      function refresh() {
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
        if (disposed) return;
        paint();
        if (open.value && onScreen && !held()) frameId = requestAnimationFrame(tick);
      }

      /**
       * Show the card until the wait is STAGE_INTRO_MS old, then the scene.
       * Without a 2D context there is no scene, and the card stays.
       */
      const syncOpen = () => {
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        if (disposed || !ctx) return;
        // A held scene shows one frame whatever the clock says, so it stays open.
        if (open.value && held()) return;
        const now = Date.now();
        const waited = now - readWaitClock(props.clockKey, now);
        if (waited >= STAGE_INTRO_MS) {
          if (!open.value) open.value = true;
          return;
        }
        open.value = false;
        cut.value = true;
        openTimer = setTimeout(syncOpen, STAGE_INTRO_MS - waited);
      };

      // A scene that was held or off screen stopped reading its wait clock,
      // and a clock left unread is forgotten. So whenever it may play again,
      // check the wait first: a forgotten one starts over from the card
      // rather than freezing on the scene's first frame.
      const resume = () => {
        syncOpen();
        refresh();
      };
      const recolor = () => {
        colors = null;
        resume();
      };
      const onMotionChange = (event) => {
        reducedMotion = event.matches;
        resume();
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
            resume();
          });
          viewObserver.observe(host);
        } else {
          onScreen = true;
        }
        themeObserver = new MutationObserver(recolor);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        syncOpen();
        resize();
      });

      // Post-flush watchers run after the classes are in the DOM, so the
      // colour tokens can be re-read and the opened picture measured.
      Vue.watch(() => props.status, recolor, { flush: 'post' });
      Vue.watch(() => props.clockKey, resume, { flush: 'post' });
      Vue.watch(open, resize, { flush: 'post' });

      Vue.onBeforeUnmount(() => {
        disposed = true;
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        sizeObserver?.disconnect();
        viewObserver?.disconnect();
        themeObserver?.disconnect();
        motionQuery?.removeEventListener?.('change', onMotionChange);
      });

      return { canvasRef, open, cut, sceneClass: scene.className };
    },
  };
}
