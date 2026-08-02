'use strict';

const path = require('node:path');

const SAFE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRenameIdentity(value, { fingerprint = false } = {}) {
  const keys = fingerprint ? 'fingerprint,name,path,source' : 'name,path,source';
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === keys
    && typeof value.name === 'string' && SAFE_SKILL_NAME.test(value.name)
    && typeof value.source === 'string' && value.source.length > 0
    && typeof value.path === 'string' && isSafeSelectionPath(value.path)
    && (!fingerprint || (typeof value.fingerprint === 'string' && value.fingerprint.length > 0));
}

function areDisjointRenamePairs(pairs) {
  const oldNames = new Map();
  const newNames = new Map();
  const oldSelections = new Map();
  const newSelections = new Map();
  for (const [index, { from, to }] of pairs.entries()) {
    const fromSelection = renameSelectionKey(from);
    const toSelection = renameSelectionKey(to);
    if (oldNames.has(from.name) || newNames.has(to.name)
      || oldSelections.has(fromSelection) || newSelections.has(toSelection)) return false;
    oldNames.set(from.name, index);
    newNames.set(to.name, index);
    oldSelections.set(fromSelection, index);
    newSelections.set(toSelection, index);
  }
  return ![...oldNames].some(([name, index]) => newNames.has(name) && newNames.get(name) !== index)
    && ![...oldSelections].some(([selection, index]) => (
      newSelections.has(selection) && newSelections.get(selection) !== index
    ));
}

function renameSelectionKey(identity) {
  return `${identity.source}\0${identity.path}`;
}

function isSafeSelectionPath(value) {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  if (value === '.') return true;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

module.exports = {
  areDisjointRenamePairs,
  isRenameIdentity,
  isSafeSelectionPath,
  renameSelectionKey,
};
