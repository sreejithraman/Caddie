import { LEGACY_OPERATIONS } from '../management/legacy-bridge.mjs';

export const TOOL_COMPATIBILITY = Object.freeze({
  declarationVersion: 1,
  currentProtocolVersion: 2,
  priorProtocolBridge: Object.freeze({
    protocolVersion: 1,
    lastToolProtocolVersion: 2,
    removeWhenToolProtocolVersionReaches: 3,
    operations: LEGACY_OPERATIONS,
  }),
});
