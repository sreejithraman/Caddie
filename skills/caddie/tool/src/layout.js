'use strict';

const os = require('node:os');
const path = require('node:path');

// One path policy for portable Agent Skills, Caddie-owned state, and the one
// compatibility adapter. Callers receive the whole layout so they never need
// to reconstruct a related path independently.
function scopeLayout(scope, home = os.homedir()) {
  const root = scope.id === 'user' ? path.resolve(home) : path.resolve(scope.root);
  const agentsRoot = path.join(root, '.agents');
  const stateRoot = path.join(agentsRoot, '.caddie');
  return Object.freeze({
    root,
    agentsRoot,
    canonicalSkillsRoot: path.join(agentsRoot, 'skills'),
    claudeSkillsRoot: scope.id === 'user'
      ? path.join(path.resolve(home), '.claude', 'skills')
      : path.join(root, '.claude', 'skills'),
    stateRoot,
    manifestPath: path.join(stateRoot, 'manifest.json'),
    lockPath: path.join(stateRoot, 'lock.json'),
    ledgerPath: path.join(stateRoot, 'ledger.json'),
    operationJournalPath: path.join(stateRoot, 'operation-journal.json'),
  });
}

function userLayout(home = os.homedir()) {
  const layout = scopeLayout({ id: 'user', root: path.resolve(home) }, home);
  return Object.freeze({
    ...layout,
    registryPath: path.join(layout.stateRoot, 'registry.json'),
    legacySkillLockPath: path.join(layout.agentsRoot, '.skill-lock.json'),
    userMutationLockPath: path.join(layout.stateRoot, 'user-mutation.lock'),
    userOperationPath: path.join(layout.stateRoot, 'user-operation.json'),
  });
}

function canonicalSkillsRoot(scope, home = os.homedir()) {
  return scopeLayout(scope, home).canonicalSkillsRoot;
}

function claudeSkillsRoot(scope, home = os.homedir()) {
  return scopeLayout(scope, home).claudeSkillsRoot;
}

function runtimeUserCoordinationRoot(home = os.homedir()) {
  return userLayout(home).stateRoot;
}

module.exports = {
  canonicalSkillsRoot,
  claudeSkillsRoot,
  runtimeUserCoordinationRoot,
  scopeLayout,
  userLayout,
};
