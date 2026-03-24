/**
 * Cross-platform service management for yeaft-agent
 * Supports: Linux (systemd), macOS (launchd), Windows (pm2)
 *
 * Re-export entry point — actual implementation lives in service/ submodules:
 *   service/config.js   — shared configuration and utility functions
 *   service/linux.js    — Linux (systemd) implementation
 *   service/macos.js    — macOS (launchd) implementation
 *   service/windows.js  — Windows (pm2) implementation
 *   service/index.js    — platform dispatcher
 */
export {
  getConfigDir,
  getLogDir,
  getConfigPath,
  saveServiceConfig,
  loadServiceConfig,
  parseServiceArgs,
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  logs,
  doctor
} from './service/index.js';
