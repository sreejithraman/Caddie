'use strict';

const os = require('node:os');
const path = require('node:path');

// One path policy for portable Agent Skills and the one compatibility adapter.
function canonicalSkillsRoot(scope, home = os.homedir()) {
  return scope.id === 'user'
    ? path.join(path.resolve(home), '.agents', 'skills')
    : path.join(path.resolve(scope.root), '.agents', 'skills');
}

function claudeSkillsRoot(scope, home = os.homedir()) {
  return scope.id === 'user'
    ? path.join(path.resolve(home), '.claude', 'skills')
    : path.join(path.resolve(scope.root), '.claude', 'skills');
}

function stateRoot(scope) {
  return path.join(path.resolve(scope.root), '.agents', '.caddie');
}

function scopeMutationStateRoot(scopeRoot) {
  return stateRoot({ root: scopeRoot });
}

function runtimeUserCoordinationRoot(home = os.homedir()) {
  return path.join(path.resolve(home), '.agents', '.caddie');
}

module.exports = {
  canonicalSkillsRoot,
  claudeSkillsRoot,
  runtimeUserCoordinationRoot,
  scopeMutationStateRoot,
  stateRoot,
};
