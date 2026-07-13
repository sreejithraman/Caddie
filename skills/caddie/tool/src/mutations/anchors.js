'use strict';

const path = require('node:path');
const { canonicalSkillsRoot, claudeSkillsRoot, scopeLayout } = require('../layout');
const { isUserHarnessAnchored, isUserStateAnchored } = require('./strategies');

function approvedMutationAnchor(plan, operation, candidate, home) {
  const resolved = path.resolve(candidate);
  const scopeRoot = path.resolve(plan.scope.root);
  const legacyConfigHome = plan.scope.legacyConfigHome && path.resolve(plan.scope.legacyConfigHome);
  if (isInside(scopeRoot, resolved)) return scopeRoot;
  if (legacyConfigHome && isInside(legacyConfigHome, resolved)) return legacyConfigHome;
  if (plan.scope.id === 'user' && isInside(canonicalSkillsRoot(plan.scope, home), resolved)) return home;
  if (plan.scope.id === 'user' && isUserHarnessAnchored(operation)
    && isInside(claudeSkillsRoot(plan.scope, home), resolved)) return home;
  if (isUserStateAnchored(operation)
    && isInside(scopeLayout({ id: 'user', root: home }, home).agentsRoot, resolved)) return home;
  return null;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { approvedMutationAnchor };
