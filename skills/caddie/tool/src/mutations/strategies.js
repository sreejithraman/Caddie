'use strict';

// Domain operations deliberately describe intent; strategies describe the one
// filesystem transaction shape that implements that intent. Keep this mapping
// as the single taxonomy used by planning, application, and recovery.
const DEFINITIONS = Object.freeze({
  'materialize-skill': descriptor('directory-replace', 'destinationPath', 'expectedDestination', 'skill'),
  'ensure-harness-exposure': descriptor('symlink', 'linkPath', 'expected', 'link', { userHarnessAnchored: true, ownsHarnessLink: true }),
  'write-manifest': descriptor('file-replace', 'path', 'expected', 'file'),
  'write-lock': descriptor('file-replace', 'path', 'expected', 'file'),
  'write-registry': descriptor('file-replace', 'path', 'expected', 'file', { userStateAnchored: true }),
  'write-ledger': descriptor('file-replace', 'path', 'expected', 'file'),
  'remove-ledger': descriptor('remove', 'path', 'expected', 'removed'),
  'remove-legacy-state': descriptor('remove', 'path', 'expected', 'legacy-state'),
  'remove-legacy-manager-state': descriptor('remove', 'path', 'expected', 'legacy-manager', { userStateAnchored: true }),
  'cleanup-preserved-skill': descriptor('remove', 'path', 'expected', 'removed'),
  'cleanup-exposure': descriptor('remove', 'path', 'expected', 'removed', { userHarnessAnchored: true }),
});

const MUTATION_OPERATION_TYPES = Object.freeze(Object.keys(DEFINITIONS));
const RECOVERY_OPERATION_TYPES = Object.freeze(['recover-finish', 'recover-rollback']);

function descriptor(strategy, targetField, expectedField, storageSuffix, traits = {}) {
  return Object.freeze({ strategy, targetField, expectedField, storageSuffix, ...traits });
}

function strategyFor(operationOrType) {
  const type = typeof operationOrType === 'string' ? operationOrType : operationOrType?.type;
  return DEFINITIONS[type];
}

function targetFor(operation) {
  const definition = strategyFor(operation);
  return definition && operation[definition.targetField];
}

function expectedFor(operation) {
  const definition = strategyFor(operation);
  return definition && operation[definition.expectedField];
}

function isUserHarnessAnchored(operationOrType) {
  return strategyFor(operationOrType)?.userHarnessAnchored === true;
}

function isUserStateAnchored(operationOrType) {
  return strategyFor(operationOrType)?.userStateAnchored === true;
}

function ownsHarnessLink(operationOrType) {
  return strategyFor(operationOrType)?.ownsHarnessLink === true;
}

module.exports = {
  MUTATION_OPERATION_TYPES,
  RECOVERY_OPERATION_TYPES,
  expectedFor,
  isUserHarnessAnchored,
  isUserStateAnchored,
  ownsHarnessLink,
  strategyFor,
  targetFor,
};
