/**
 * Two dogs waiting animation: a big dog and a small one bark at each other
 * from their posts, strain forward until the leashes snap, stand stunned and
 * slink back. Still rough, so it is hidden: it is not offered in Settings or
 * picked at random, and only `?preview=dog` shows it. Looks and moods are
 * CSS (styles/waiting/dog.css).
 */
const component = {
  name: 'DogWaiting',
  // The props every waiting animation is given. The dogs use neither.
  props: {
    clockKey: { type: String, default: '' },
    status: { type: String, default: '' },
  },
  template: `
    <span class="svg-dog-scene" :class="'dog-phase-' + dogPhase" aria-hidden="true">
      <svg viewBox="0 0 120 28" xmlns="http://www.w3.org/2000/svg">
        <!-- Left post -->
        <rect class="svg-dog-post" x="1" y="18" width="2" height="8" rx="0.5"/>
        <!-- Left leash (Spike) -->
        <path class="svg-dog-leash svg-dog-leash-l" :d="leashPathL" stroke-width="0.8" :style="{ opacity: leashOpacityL }"/>
        <!-- Left snap FX (at left post) -->
        <g class="svg-dog-snap-fx" :style="{ transformOrigin: '3px 20px' }">
          <line class="svg-dog-snap-line" x1="0" y1="16" x2="6" y2="24"/>
          <line class="svg-dog-snap-line" x1="6" y1="16" x2="0" y2="24"/>
        </g>
        <!-- Spike (left, big dog) -->
        <g :transform="spikeTransform">
          <g class="svg-dog-silhouette">
            <g class="svg-dog-tail-group" style="transform-origin: -1px 13px"><path class="svg-dog-tail" d="M-1 13 Q-3 9 -1 6" stroke-width="2.2"/></g>
            <g class="svg-dog-leg-bl" style="transform-origin: 2px 18px"><path class="svg-dog-leg" d="M2 18 L1 24 Q1 25.5 2.5 25.5" stroke-width="0"/></g>
            <g class="svg-dog-leg-br" style="transform-origin: 4px 18px"><path class="svg-dog-leg" d="M4 18 L3 24 Q3 25.5 4.5 25.5" stroke-width="0"/></g>
            <ellipse class="svg-dog-body" cx="8" cy="14" rx="7" ry="5"/>
            <g class="svg-dog-leg-fl" style="transform-origin: 13px 18px"><path class="svg-dog-leg" d="M13 18 L14 24 Q14 25.5 12.5 25.5" stroke-width="0"/></g>
            <g class="svg-dog-leg-fr" style="transform-origin: 11px 18px"><path class="svg-dog-leg" d="M11 18 L12 24 Q12 25.5 10.5 25.5" stroke-width="0"/></g>
            <rect class="svg-dog-collar" x="12" y="9.5" width="3.5" height="2" rx="0.5"/>
            <polygon class="svg-dog-spike-stud" points="13,9.5 13.4,8.5 13.8,9.5"/>
            <polygon class="svg-dog-spike-stud" points="14.5,9.5 14.9,8.5 15.3,9.5"/>
            <g class="svg-dog-head-group">
              <circle class="svg-dog-head" cx="16" cy="7" r="5.5"/>
              <polygon class="svg-dog-ear svg-dog-ear-l" points="11.5,5 13,-2 15,4"/>
              <polygon class="svg-dog-ear svg-dog-ear-r" points="17,4 19,-2 20.5,5"/>
              <ellipse class="svg-dog-jaw" cx="17" cy="11.5" rx="3" ry="1.8"/>
              <ellipse class="svg-dog-eye" cx="14" cy="6.5" rx="1.5" ry="1.6"/>
              <ellipse class="svg-dog-eye" cx="18.5" cy="6.5" rx="1.5" ry="1.6"/>
              <ellipse class="svg-dog-pupil" cx="14.5" cy="6.8" rx="0.7" ry="0.9"/>
              <ellipse class="svg-dog-pupil" cx="19" cy="6.8" rx="0.7" ry="0.9"/>
              <circle class="svg-dog-eye-shine" cx="13.8" cy="6" r="0.4"/>
              <circle class="svg-dog-eye-shine" cx="18.3" cy="6" r="0.4"/>
              <ellipse class="svg-dog-nose" cx="17" cy="9.5" rx="1.5" ry="1"/>
              <path class="svg-dog-mouth" d="M15 10.5 Q17 11.5 19 10.5" stroke-width="0.6"/>
              <ellipse class="svg-dog-bark-mouth" cx="17" cy="12" rx="2.5" ry="1.5"/>
              <ellipse class="svg-dog-tongue" cx="17" cy="13" rx="1" ry="0.7"/>
            </g>
          </g>
        </g>
        <!-- Right post -->
        <rect class="svg-dog-post" x="117" y="18" width="2" height="8" rx="0.5"/>
        <!-- Right leash (Teddy) -->
        <path class="svg-dog-leash svg-dog-leash-r" :d="leashPathR" stroke-width="0.8" :style="{ opacity: leashOpacityR }"/>
        <!-- Right snap FX (at right post) -->
        <g class="svg-dog-snap-fx" :style="{ transformOrigin: '118px 20px' }">
          <line class="svg-dog-snap-line" x1="115" y1="16" x2="121" y2="24"/>
          <line class="svg-dog-snap-line" x1="121" y1="16" x2="115" y2="24"/>
        </g>
        <!-- Teddy (right, small dog) -->
        <g :transform="teddyTransform">
          <g class="svg-dog-silhouette">
            <g class="svg-dog-tail-group" style="transform-origin: -1px 11px"><path class="svg-dog-tail" d="M-1 11 Q-3 7 -1 5 Q1 3 0 6" stroke-width="1.5"/></g>
            <g class="svg-dog-leg-bl" style="transform-origin: 2px 14px"><path class="svg-dog-leg" d="M2 14 L1.5 22 Q1.5 23.5 3 23.5" stroke-width="0"/></g>
            <g class="svg-dog-leg-br" style="transform-origin: 3.5px 14px"><path class="svg-dog-leg" d="M3.5 14 L3 22 Q3 23.5 4.5 23.5" stroke-width="0"/></g>
            <ellipse class="svg-dog-body" cx="6" cy="12" rx="5" ry="3.5"/>
            <g class="svg-dog-leg-fl" style="transform-origin: 10px 14px"><path class="svg-dog-leg" d="M10 14 L10.5 22 Q10.5 23.5 9 23.5" stroke-width="0"/></g>
            <g class="svg-dog-leg-fr" style="transform-origin: 8.5px 14px"><path class="svg-dog-leg" d="M8.5 14 L9 22 Q9 23.5 7.5 23.5" stroke-width="0"/></g>
            <rect class="svg-dog-collar" x="9.5" y="7.5" width="2.5" height="1.5" rx="0.5"/>
            <g class="svg-dog-head-group">
              <circle class="svg-dog-head" cx="12.5" cy="5.5" r="5"/>
              <circle class="svg-dog-fluff" cx="12.5" cy="4.5" r="5.5"/>
              <ellipse class="svg-dog-ear svg-dog-ear-l" cx="8.5" cy="6.5" rx="2" ry="3"/>
              <ellipse class="svg-dog-ear svg-dog-ear-r" cx="16.5" cy="6.5" rx="2" ry="3"/>
              <ellipse class="svg-dog-eye" cx="10.5" cy="5" rx="1.8" ry="2"/>
              <ellipse class="svg-dog-eye" cx="15" cy="5" rx="1.8" ry="2"/>
              <ellipse class="svg-dog-pupil" cx="11" cy="5.3" rx="0.9" ry="1.1"/>
              <ellipse class="svg-dog-pupil" cx="15.5" cy="5.3" rx="0.9" ry="1.1"/>
              <circle class="svg-dog-eye-shine" cx="10.3" cy="4.5" r="0.5"/>
              <circle class="svg-dog-eye-shine" cx="14.8" cy="4.5" r="0.5"/>
              <ellipse class="svg-dog-nose" cx="12.8" cy="7.5" rx="1" ry="0.7"/>
              <path class="svg-dog-mouth" d="M11.5 8.3 Q12.8 9 14 8.3" stroke-width="0.5"/>
              <ellipse class="svg-dog-bark-mouth" cx="12.8" cy="9.5" rx="2" ry="1.2"/>
              <ellipse class="svg-dog-tongue" cx="12.8" cy="10.3" rx="0.8" ry="0.5"/>
            </g>
          </g>
        </g>
        <!-- Question marks (stunned phase) -->
        <text class="svg-dog-question svg-dog-question-l" :x="questionLX" y="4" font-size="6">?</text>
        <text class="svg-dog-question svg-dog-question-r" :x="questionRX" y="4" font-size="6">?</text>
      </svg>
    </span>
  `,
  setup() {
    // Positions are percentages of the scene's width.
    const dogPosL = Vue.ref(5);
    const dogPosR = Vue.ref(95);
    const dogPhase = Vue.ref('bark-both');
    const dogFlipL = Vue.ref(1);   // 1 = face right, -1 = face left
    const dogFlipR = Vue.ref(-1);  // -1 = face left, 1 = face right
    let startedAt = 0;
    let frameId = null;

    function updateDogWalk() {
      const elapsed = (Date.now() - startedAt) % 18000;

      if (elapsed < 2000) {
        // 0-2s: both bark at edges
        dogPosL.value = 5; dogPosR.value = 95; dogPhase.value = 'bark-both';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 5000) {
        // 2-5s: left dog walks forward (5% → 30%), right barks in place
        const t = (elapsed - 2000) / 3000;
        dogPosL.value = 5 + t * 25; dogPosR.value = 95;
        dogPhase.value = 'left-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 8000) {
        // 5-8s: right dog walks forward (95% → 70%), left barks in place
        const t = (elapsed - 5000) / 3000;
        dogPosL.value = 30; dogPosR.value = 95 - t * 25;
        dogPhase.value = 'right-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 10000) {
        // 8-10s: both walk toward each other (30→43, 70→57)
        const t = (elapsed - 8000) / 2000;
        dogPosL.value = 30 + t * 13; dogPosR.value = 70 - t * 13;
        dogPhase.value = 'both-approach';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 11000) {
        // 10-11s: leash snaps at posts
        dogPosL.value = 43; dogPosR.value = 57;
        dogPhase.value = 'snap';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 12500) {
        // 11-12.5s: stunned
        dogPosL.value = 43; dogPosR.value = 57;
        dogPhase.value = 'stunned';
        dogFlipL.value = 1; dogFlipR.value = -1;
      } else if (elapsed < 15000) {
        // 12.5-15s: retreat (turn around, walk back)
        const t = (elapsed - 12500) / 2500;
        dogPosL.value = 43 - t * 38; dogPosR.value = 57 + t * 38;
        dogPhase.value = 'retreat';
        dogFlipL.value = -1; dogFlipR.value = 1; // flipped — walking back
      } else if (elapsed < 17000) {
        // 15-17s: at post, rehang leash
        dogPosL.value = 5; dogPosR.value = 95;
        dogPhase.value = 'rehang';
        dogFlipL.value = -1; dogFlipR.value = 1; // still facing post
      } else {
        // 17-18s: turn back to face each other
        dogPosL.value = 5; dogPosR.value = 95;
        dogPhase.value = 'reset';
        dogFlipL.value = 1; dogFlipR.value = -1; // back to normal
      }
      frameId = requestAnimationFrame(updateDogWalk);
    }

    // Dog computed properties — map 0-100% position to SVG viewBox x coordinates
    // Spike collar at local x=13.5, Teddy collar at local x=10.5
    // Position represents where the collar should be in SVG coords (pos * 1.2)
    const spikeTransform = Vue.computed(() => {
      const collarSvgX = dogPosL.value * 1.2;
      if (dogFlipL.value < 0) {
        // Facing left: mirror around collar point
        return `translate(${collarSvgX + 13.5}, 0) scale(-1, 1)`;
      }
      // Facing right: collar at local x=13.5
      return `translate(${collarSvgX - 13.5}, 0)`;
    });
    const teddyTransform = Vue.computed(() => {
      const collarSvgX = dogPosR.value * 1.2;
      if (dogFlipR.value > 0) {
        // Facing right (retreat): collar at local x=10.5
        return `translate(${collarSvgX - 10.5}, 2)`;
      }
      // Facing left (default): mirror around collar point
      return `translate(${collarSvgX + 10.5}, 2) scale(-1, 1)`;
    });
    // Leash paths depend on phase: connected to post vs dragging
    const leashConnected = Vue.computed(() => {
      const p = dogPhase.value;
      return p === 'bark-both' || p === 'left-approach' || p === 'right-approach' || p === 'both-approach' || p === 'reset';
    });
    const leashPathL = Vue.computed(() => {
      const collarSvgX = dogPosL.value * 1.2;
      const collarY = 10;
      if (leashConnected.value) {
        // Post top (3, 18) to collar
        const sag = Math.max(0, (collarSvgX - 3) * 0.12);
        return `M3,18 Q${(3 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (dogPhase.value === 'rehang') {
        // During rehang, leash goes from collar down to near post then up to post top
        return `M${collarSvgX},${collarY} Q${collarSvgX - 3},20 3,18`;
      }
      // Snap/stunned/retreat: leash hangs from collar, drags trailing behind/below
      const dragDir = dogFlipL.value < 0 ? 1 : -1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    });
    const leashPathR = Vue.computed(() => {
      const collarSvgX = dogPosR.value * 1.2;
      const collarY = 10;
      if (leashConnected.value) {
        // Post top (118, 18) to collar
        const sag = Math.max(0, (118 - collarSvgX) * 0.12);
        return `M118,18 Q${(118 + collarSvgX) / 2},${18 + sag} ${collarSvgX},${collarY}`;
      }
      if (dogPhase.value === 'rehang') {
        return `M${collarSvgX},${collarY} Q${collarSvgX + 3},20 118,18`;
      }
      // Snap/stunned/retreat: leash hangs from collar
      const dragDir = dogFlipR.value > 0 ? -1 : 1;
      const dragX = collarSvgX + dragDir * 8;
      return `M${collarSvgX},${collarY} Q${collarSvgX},18 ${dragX},22`;
    });
    const leashOpacityL = Vue.computed(() => {
      return dogPhase.value === 'snap' ? 0.2 : 0.4;
    });
    const leashOpacityR = Vue.computed(() => {
      return dogPhase.value === 'snap' ? 0.2 : 0.4;
    });
    const questionLX = Vue.computed(() => dogPosL.value * 1.2);
    const questionRX = Vue.computed(() => dogPosR.value * 1.2);

    Vue.onMounted(() => {
      startedAt = Date.now();
      frameId = requestAnimationFrame(updateDogWalk);
    });
    Vue.onBeforeUnmount(() => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
    });

    return { dogPhase, spikeTransform, teddyTransform, leashPathL, leashPathR, leashOpacityL, leashOpacityR, questionLX, questionRX };
  },
};

export default { id: 'dog', layout: 'inline', hidden: true, component };
