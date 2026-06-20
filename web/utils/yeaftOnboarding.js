/**
 * Decide whether the Yeaft main pane should show the no-session onboarding guide.
 *
 * Keep this pure so page-level rendering and tests don't collapse the "snapshot
 * has not loaded yet" state into "there are definitely no Sessions".
 */
export function shouldShowYeaftOnboardingGuide({
  hasYeaftAgent = false,
  sessionsReady = false,
  sessionsEmpty = false,
  activeSessionId = null,
  topbarSession = null,
} = {}) {
  if (!hasYeaftAgent) return true;
  if (!sessionsReady) return false;
  if (sessionsEmpty) return true;
  return !topbarSession && !activeSessionId;
}
