const VISIBLE_SILENCE_MS = 60_000;

// Display clock only. Tool activity, heartbeats and thinking never buy
// another minute; only meaningful user-visible output does.
export function createVisibleQueryProgress({ signal, publish }) {
  let phase = 'preparing';
  let silent = false;
  let shown = null;
  let stopped = false;
  let timer;

  function update() {
    const next = phase !== 'awaiting_user' && (silent || phase === 'retrying') ? phase : null;
    if (next === shown) return;
    shown = next;
    publish(next);
  }

  function arm() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      silent = true;
      update();
    }, VISIBLE_SILENCE_MS);
    timer.unref?.();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (shown !== null) publish(null);
  }

  if (signal?.aborted) stop();
  else {
    arm();
    signal?.addEventListener('abort', stop, { once: true });
  }

  return {
    phase(next) {
      if (stopped) return;
      phase = next;
      update();
    },
    visibleOutput() {
      if (stopped) return;
      silent = false;
      update();
      arm();
    },
    stop,
  };
}
