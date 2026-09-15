/**
 * Resolve the Work Center gate. An explicitly present legacy environment
 * variable overrides the persisted Agent setting; otherwise config defaults off.
 */
export function getWorkCenterFeatureState(config = {}, env = process.env) {
  const overridden = Object.prototype.hasOwnProperty.call(env || {}, 'YEAFT_WORK_CENTER_ENABLED');
  return {
    enabled: overridden ? env.YEAFT_WORK_CENTER_ENABLED === 'true' : config?.workCenter?.enabled === true,
    source: overridden ? 'environment' : 'config',
    overridden,
  };
}

export function isWorkCenterEnabled(env = process.env, config = {}) {
  return getWorkCenterFeatureState(config, env).enabled;
}

/** Boot the persisted feature without changing its configured value. */
export async function startWorkCenterFeature(enabled, boot) {
  if (enabled !== true) return { effective: false, runtimeError: null };
  try {
    await boot();
    return { effective: true, runtimeError: null };
  } catch (error) {
    return { effective: false, runtimeError: error?.message || String(error) };
  }
}
