// Compatibility exports for legacy imports. The shared renderer now lives in
// assistantOutput.js because Claude CLI, Copilot CLI, and Yeaft Session all
// consume the same provider-neutral output frame shape.

export {
  getOrCreateExecutionStatus,
  handleAssistantOutputFrame,
  handleAssistantOutputFrame as handleClaudeOutput,
} from './assistantOutput.js';
