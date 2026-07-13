'use strict';

// Domain operations deliberately describe intent; strategies describe the one
// filesystem transaction shape that implements that intent. Keep this mapping
// as the single taxonomy used by planning, application, and recovery.
const DEFINITIONS = Object.freeze({
  'materialize-skill': descriptor('directory-replace', 'destinationPath', 'expectedDestination', 'skill'),
  'ensure-harness-exposure': descriptor('symlink', 'linkPath', 'expected'),
  'write-manifest': descriptor('file-replace', 'path', 'expected', 'file'),
  'write-lock': descriptor('file-replace', 'path', 'expected', 'file'),
  'write-machine-config': descriptor('file-replace', 'path', 'expected', 'file'),
  'write-ledger': descriptor('file-replace', 'path', 'expected', 'file'),
  'remove-ledger': descriptor('remove', 'path', 'expected', 'removed'),
  'remove-legacy-lock': descriptor('remove', 'path', 'expected', 'removed'),
  'cleanup-preserved-skill': descriptor('remove', 'path', 'expected', 'removed'),
  'cleanup-exposure': descriptor('remove', 'path', 'expected', 'removed'),
});

const MUTATION_OPERATION_TYPES = Object.freeze(Object.keys(DEFINITIONS));
const RECOVERY_OPERATION_TYPES = Object.freeze(['recover-finish', 'recover-rollback']);

function descriptor(strategy, targetField, expectedField, storageSuffix) {
  return Object.freeze({ strategy, targetField, expectedField, storageSuffix });
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

module.exports = {
  MUTATION_OPERATION_TYPES,
  RECOVERY_OPERATION_TYPES,
  expectedFor,
  strategyFor,
  targetFor,
};
