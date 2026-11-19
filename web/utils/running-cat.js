const CAT_PHASE_CLASSES = [
  'speed-napping',
  'speed-normal',
  'speed-fast',
  'speed-turbo',
  'speed-crazy',
  'speed-tired',
  'speed-petted',
];

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

export function applyRunningCatFrame(walkElement, spriteElement, frame) {
  if (!walkElement || !spriteElement || !frame) return;
  walkElement.style.transform = frame.transform;
  for (const className of CAT_PHASE_CLASSES) spriteElement.classList.toggle(className, className === frame.phase);
}

export function createRunningCatLoop({
  onFrame,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}) {
  let running = false;
  let frameId = null;

  const tick = () => {
    frameId = null;
    if (!running) return;
    onFrame?.();
    if (running) frameId = requestFrame(tick);
  };

  return {
    start() {
      if (running) return false;
      running = true;
      frameId = requestFrame(tick);
      return true;
    },
    stop() {
      if (!running) return false;
      running = false;
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      return true;
    },
    isRunning() {
      return running;
    },
  };
}
