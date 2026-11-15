// The validator lives in src/core because config load, discovery and the fleet
// config routes now call it; this module keeps the preflight's import path.
export {
  resolveAgentInstructionsPath,
  validateAgentInstructionsPath,
  type AgentInstructionsPathFailureReason,
  type AgentInstructionsPathInput,
  type AgentInstructionsPathValidation,
} from '../../src/core/agent-instructions-path.ts';
