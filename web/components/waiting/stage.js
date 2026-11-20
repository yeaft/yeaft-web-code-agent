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
 *   posterMs   Scene time of the frame held while the connection has
 *              stalled: nothing is progressing, so nothing moves.
 *   stills     Scene times of its key moments, in story order. With motion
 *              reduced the stage shows these in turn instead of playing the
 *              scene: each held still for CALM_STILL_MS and dissolved into
 *              the next, so the wait still visibly goes on without camera
 *              moves, shake or flashes. Defaults to [posterMs].
 *   paint(ctx, { elapsedMs, width, height, dpr, colors, core, backdrop })
 *              Draw one frame. `elapsedMs` counts from the cut to the scene;
 *              `width`/`height` are CSS px and the context is already scaled
 *              by `dpr` and cleared. `colors[key]` is [r, g, b] and
 *              `colors.font` the UI font family. May return { beat, shot }
 *              to expose where the scene is, for tests and debugging.
 *
 * Scenes are composed for a STAGE_RATIO picture: `core`, { x, y, width,
 * height } in CSS px, centred in the canvas. On a phone the core is the
 * whole canvas. A wider stage keeps the height, so the core stays the same
 * size in the middle, and gives the scene a second context, `backdrop`, for
 * the world around it: floor lines and fixtures only, drawn through the same
 * camera across the whole width and with the same shake and fade as the
 * scene. The stage shows the scene over the core and the backdrop beyond it,
 * blending the two over a short run past the core's edges, so players and
 * effects stay in the middle and only the setting runs on to the ends.
 * Without `backdrop` a scene draws exactly what it always has. Flat marks
 * such as a score belong inside the core, sized by `core.width`.
 *
 * The scene is a function of the wait clock (see wait-clock.js), not of this
 * component, so a re-created indicator resumes the scene in progress.
 */
import { holdWaitClock, readWaitClock } from '../../utils/wait-clock.js';

/** How long a wait shows the "waiting" card before the stage cuts to the scene. */
export const STAGE_INTRO_MS = 900;
/** With motion reduced, how long each still is shown, its dissolve included. */
export const CALM_STILL_MS = 2400;
const CALM_DISSOLVE_MS = 450;

/**
 * Which still is on show `t` ms into a wait with motion reduced, and how far
 * it has dissolved in from the one before. The first still is simply there.
 * @param {number} count Number of stills.
 * @returns {{ index: number, previous: number, mix: number, nextInMs: number }}
 *   `mix` goes 0 → 1 over the dissolve; `nextInMs` is how long the picture
 *   stays as it is (0 while dissolving).
 */
export function calmStill(count, t) {
  const time = Math.max(0, t);
  const step = Math.floor(time / CALM_STILL_MS);
  const into = time - step * CALM_STILL_MS;
  const index = step % count;
  const u = step === 0 || count < 2 ? 1 : Math.min(1, into / CALM_DISSOLVE_MS);
  const mix = u * u * (3 - 2 * u);
  return { index, previous: (index + count - 1) % count, mix, nextInMs: mix < 1 ? 0 : CALM_STILL_MS - into };
}
/** Height of the picture scenes are composed for, as a fraction of its width. */
export const STAGE_RATIO = 5 / 11;

/**
 * The part of a `width` x `height` canvas a scene is composed for: all of it
 * up to STAGE_RATIO, else a centred box of that ratio and the full height.
 * Rounding in the page's layout leaves a narrow canvas a pixel or so off the
 * ratio, which still counts as all of it.
 * @returns {{ x: number, y: number, width: number, height: number }} CSS px.
 */
export function stageCore(width, height) {
  const composed = height / STAGE_RATIO;
  if (width <= composed + 1.5) return { x: 0, y: 0, width, height };
  return { x: (width - composed) / 2, y: 0, width: composed, height };
}

/**
 * How far past each side of the core the scene fades out into the backdrop.
 * About as short as the fade at the edge of a phone's picture, so the scene
 * keeps the framing it has there: whoever the camera has left out stays
 * out, and only the setting runs on beside it.
 */
const blendRun = core => Math.min(core.x, 24);

/**
 * Horizontal mask over the core: opaque across it, easing to clear
 * `blendRun` beyond each side.
 */
function coreMask(ctx, core) {
  const run = blendRun(core);
  const from = core.x - run;
  const span = core.width + 2 * run;
  const mask = ctx.createLinearGradient(from, 0, from + span, 0);
  // Smoothstep in a few stops, so the hand-over has no visible edge.
  for (const [u, alpha] of [[0, 0], [0.25, 0.156], [0.5, 0.5], [0.75, 0.844], [1, 1]]) {
    mask.addColorStop((u * run) / span, `rgba(0, 0, 0, ${alpha})`);
    mask.addColorStop(1 - (u * run) / span, `rgba(0, 0, 0, ${alpha})`);
  }
  return mask;
}

/**
 * Paint one frame of a scene onto `ctx`, which is cleared and scaled to CSS
 * px. A canvas wider than its core is composed from the scene and its
 * backdrop: the scene is drawn on `scratch` and the backdrop on `ctx`; `ctx`
 * then keeps the backdrop only where the core mask is clear, `scratch` keeps
 * the scene only where it is opaque, and the two are added. Over the core
 * the picture is exactly the scene, past the blend run exactly the backdrop,
 * and in between a straight cross-fade.
 * @param {CanvasRenderingContext2D} ctx
 * @param scene Scene definition (see the module comment).
 * @param {{ elapsedMs: number, width: number, height: number, dpr: number, colors: object }} frame
 * @param {{ canvas?: HTMLCanvasElement, ctx?: CanvasRenderingContext2D|null }} scratch
 *   Owned by the caller and kept between frames; filled in on first use.
 * @returns Whatever `scene.paint` returned.
 */
export function paintStageFrame(ctx, scene, frame, scratch) {
  const { width, height, dpr } = frame;
  const core = stageCore(width, height);
  if (core.width >= width) return scene.paint(ctx, { ...frame, core });
  if (!scratch.canvas) {
    scratch.canvas = document.createElement('canvas');
    scratch.ctx = scratch.canvas.getContext('2d');
  }
  const layer = scratch.ctx;
  if (!layer) return scene.paint(ctx, { ...frame, core });
  if (scratch.canvas.width !== ctx.canvas.width || scratch.canvas.height !== ctx.canvas.height) {
    scratch.canvas.width = ctx.canvas.width;
    scratch.canvas.height = ctx.canvas.height;
  }
  layer.setTransform(dpr, 0, 0, dpr, 0, 0);
  layer.clearRect(0, 0, width, height);
  const where = scene.paint(layer, { ...frame, core, backdrop: ctx });
  for (const [target, operation] of [[ctx, 'destination-out'], [layer, 'destination-in']]) {
    target.setTransform(dpr, 0, 0, dpr, 0, 0);
    target.globalCompositeOperation = operation;
    target.fillStyle = coreMask(target, core);
    target.fillRect(0, 0, width, height);
    target.globalCompositeOperation = 'source-over';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(scratch.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return where;
}

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
      // Where a wide stage draws the scene before laying it over the backdrop.
      let scratch = {};
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
      let releaseClock = null;
      let onScreen = false;
      let reducedMotion = false;
      let disposed = false;
      let sizeObserver = null;
      let viewObserver = null;
      let themeObserver = null;
      let motionQuery = null;
      let wakeTimer = null;
      // With motion reduced: the stills on show, each painted once onto a
      // canvas of its own and kept while it is the current or the last one.
      const calmFrames = new Map();
      const stills = scene.stills?.length ? scene.stills : [scene.posterMs];

      /** 'live' plays the scene, 'calm' shows its stills in turn, 'held' stays on its poster. */
      const motion = () => (STALLED.has(props.status) ? 'held' : (reducedMotion ? 'calm' : 'live'));
      const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 3);

      /** One still, drawn at the stage's size the first time it is wanted. */
      const calmFrame = (index) => {
        if (calmFrames.has(index)) return calmFrames.get(index);
        const canvas = document.createElement('canvas');
        canvas.width = ctx.canvas.width;
        canvas.height = ctx.canvas.height;
        const still = canvas.getContext('2d');
        if (!still) return null;
        still.setTransform(dpr, 0, 0, dpr, 0, 0);
        const where = paintStageFrame(still, scene, { elapsedMs: stills[index], width, height, dpr, colors }, scratch) || {};
        const frame = { canvas, where };
        calmFrames.set(index, frame);
        return frame;
      };

      /** The still for `t`, dissolving in from the one before. Returns ms the picture holds. */
      const paintCalm = (t) => {
        const { index, previous, mix, nextInMs } = calmStill(stills.length, t);
        // Keep the still before only while it is dissolving out.
        const keep = (key) => key === index || (mix < 1 && key === previous);
        for (const key of [...calmFrames.keys()]) if (!keep(key)) calmFrames.delete(key);
        const current = calmFrame(index);
        const before = mix < 1 ? calmFrame(previous) : null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (before) {
          ctx.globalAlpha = 1 - mix;
          ctx.drawImage(before.canvas, 0, 0);
          // Added on, so the two blend straight across: before·(1 − mix) + current·mix.
          ctx.globalCompositeOperation = 'lighter';
        }
        if (current) {
          ctx.globalAlpha = mix;
          ctx.drawImage(current.canvas, 0, 0);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (host.dataset.still !== String(index)) host.dataset.still = String(index);
        return { where: current?.where || {}, holdMs: nextInMs };
      };

      /** Paint the picture as it is now. Returns ms until it next changes (0: next frame). */
      const paint = () => {
        if (!ctx || !open.value || width < 8) return Infinity;
        const mode = motion();
        const now = Date.now();
        const elapsedMs = Math.max(0, now - readWaitClock(props.clockKey, now) - STAGE_INTRO_MS);
        if (!colors) colors = readStageColors(host, ctx, scene.tokens);
        if (mode !== 'calm' && calmFrames.size) calmFrames.clear();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        let where;
        let holdMs = 0;
        if (mode === 'calm') {
          ({ where, holdMs } = paintCalm(elapsedMs));
        } else {
          where = paintStageFrame(ctx, scene, { elapsedMs: mode === 'held' ? scene.posterMs : elapsedMs, width, height, dpr, colors }, scratch) || {};
          holdMs = mode === 'held' ? Infinity : 0;
          if (host.dataset.still) host.dataset.still = '';
        }
        // Where the scene is, for tests and debugging. Written only on change.
        if (host.dataset.beat !== (where.beat || '')) host.dataset.beat = where.beat || '';
        if (host.dataset.shot !== (where.shot || '')) host.dataset.shot = where.shot || '';
        if (host.dataset.motion !== mode) host.dataset.motion = mode;
        return holdMs;
      };

      const resize = () => {
        const canvas = canvasRef.value;
        if (disposed || !canvas || !host) return;
        // The stylesheet sizes the picture: its height follows its width up
        // to a cap, independent of the box, which animates open around it.
        if (canvas.clientWidth === width && canvas.clientHeight === height && pixelRatio() === dpr) return;
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        dpr = pixelRatio();
        canvas.width = Math.max(1, Math.round(width * dpr));
        canvas.height = Math.max(1, Math.round(height * dpr));
        calmFrames.clear();
        refresh();
      };

      /**
       * Paint again after `holdMs`: on the next frame while the picture moves,
       * later while a still is up, never while held. Only while the scene is
       * open and on screen.
       */
      const schedule = (holdMs) => {
        if (disposed || !open.value || !onScreen || !Number.isFinite(holdMs)) return;
        if (holdMs <= 0) {
          frameId = requestAnimationFrame(tick);
          return;
        }
        wakeTimer = setTimeout(() => {
          wakeTimer = null;
          frameId = requestAnimationFrame(tick);
        }, holdMs);
      };
      const stop = () => {
        if (frameId !== null) cancelAnimationFrame(frameId);
        frameId = null;
        if (wakeTimer !== null) clearTimeout(wakeTimer);
        wakeTimer = null;
      };

      function tick() {
        frameId = null;
        if (disposed) return;
        // Browser zoom or a move between monitors changes the ratio without a resize.
        if (pixelRatio() !== dpr) { resize(); return; }
        schedule(paint());
      }

      /** Repaint now, and keep painting for as long as the picture changes. */
      function refresh() {
        stop();
        if (disposed) return;
        schedule(paint());
      }

      /**
       * Show the card until the wait is STAGE_INTRO_MS old, then the scene.
       * Without a 2D context there is no scene, and the card stays.
       */
      const syncOpen = () => {
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        if (disposed || !ctx) return;
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

      // A scene that is held, off screen or in a background tab stops reading
      // its wait clock. The stage holds the clock for as long as it is
      // mounted, so the wait is still the same wait when the scene draws again.
      const follow = () => {
        releaseClock?.();
        releaseClock = holdWaitClock(props.clockKey);
        syncOpen();
        refresh();
      };
      const recolor = () => {
        colors = null;
        calmFrames.clear();
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
          sizeObserver.observe(canvas);
        }
        // An off-screen scene does not draw.
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
        themeObserver = new MutationObserver(recolor);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        follow();
        resize();
      });

      // Post-flush watchers run after the classes are in the DOM, so the
      // colour tokens can be re-read and the opened picture measured.
      Vue.watch(() => props.status, recolor, { flush: 'post' });
      Vue.watch(() => props.clockKey, () => { if (ctx) follow(); }, { flush: 'post' });
      Vue.watch(open, () => { resize(); refresh(); }, { flush: 'post' });

      Vue.onBeforeUnmount(() => {
        disposed = true;
        stop();
        calmFrames.clear();
        if (openTimer !== null) clearTimeout(openTimer);
        openTimer = null;
        releaseClock?.();
        releaseClock = null;
        sizeObserver?.disconnect();
        viewObserver?.disconnect();
        themeObserver?.disconnect();
        motionQuery?.removeEventListener?.('change', onMotionChange);
        scratch = {};
      });

      return { canvasRef, open, cut, sceneClass: scene.className };
    },
  };
}
