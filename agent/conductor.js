/**
 * Conductor Mode — V5 Entry Point
 *
 * Aggregates and re-exports conductor sub-module public API.
 * Singleton model: one Conductor per Agent.
 */

// Session core (singleton)
export {
  getConductor,
  initConductor,
  handleConductorUserInput,
  stopConductor,
  clearConductor
} from './conductor/session.js';

// Persistence
export {
  handleLoadConductorHistory,
  loadState as loadConductorState,
  ensureConductorHome
} from './conductor/persistence.js';

// UI messages
import { sendConductorMessage } from './conductor/ui-messages.js';
import { getConductor } from './conductor/session.js';
import { handleLoadConductorHistory as _handleLoadConductorHistory } from './conductor/persistence.js';

// Dependency injection wrapper for history loading
export async function handleConductorHistory(msg) {
  return _handleLoadConductorHistory(msg, getConductor(), sendConductorMessage);
}

// Semaphore
export { globalSemaphore } from './conductor/semaphore.js';
