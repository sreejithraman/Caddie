'use strict';

const path = require('node:path');

const MAX_TITLE_LENGTH = 120;
const UNSAFE_PRESENTATION_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u201c\u201d]/gu;

function createPlanTitle({ kind, scope, operations }) {
  const scopeName = scope.id === 'user' ? 'User' : 'Project';
  const operationTypes = new Set(operations.map(({ type }) => type));

  if (kind === 'recovery') {
    const operation = operations.find(({ type }) => ['recover-finish', 'recover-rollback'].includes(type));
    const action = operation?.type === 'recover-rollback' ? 'Roll Back' : 'Finish';
    return boundedTitle(`${action}: ${effectivePlanTitle(operation?.interruptedPlan, scopeName)}`);
  }
  if (kind === 'migrate') return 'Migrate User Caddie State';
  if (operationTypes.has('remove-legacy-manager-state')) return 'Remove Legacy Skill Manager State';
  const cleanupNames = operations
    .filter(({ type }) => type === 'cleanup-preserved-skill')
    .map(({ path: skillPath }) => path.basename(skillPath));
  if (kind === 'unmanage' && cleanupNames.length > 0) {
    return skillTitle('Stop Managing and Remove', scopeName, cleanupNames);
  }
  if (kind === 'unmanage') return `Stop Managing ${scopeName} Skills`;

  const materializations = operations.filter(({ type }) => type === 'materialize-skill');
  if (kind === 'reconcile' && materializations.length > 0) {
    const installs = materializations.filter(({ expectedDestination }) => expectedDestination?.state === 'absent');
    const action = installs.length === materializations.length
      ? 'Install'
      : installs.length === 0 ? 'Update' : 'Reconcile';
    return skillTitle(action, scopeName, materializations.map(({ name }) => name));
  }

  if (kind === 'adopt') {
    const names = operations
      .filter(({ type }) => type === 'ensure-harness-exposure')
      .map(({ targetPath }) => path.basename(targetPath));
    return skillTitle('Adopt', scopeName, names);
  }

  if (kind === 'cleanup') {
    if (cleanupNames.length > 0) return skillTitle('Remove', scopeName, cleanupNames);
  }

  return `${kind === 'reconcile' ? 'Reconcile' : 'Change'} ${scopeName} Skills`;
}

function effectivePlanTitle(plan, fallbackScopeName = 'User') {
  if (validPlanTitle(plan?.title)) return plan.title;
  if (plan?.kind && plan?.scope && Array.isArray(plan?.operations)) return createPlanTitle(plan);
  return `${fallbackScopeName} Skills Change`;
}

function planPresentation(plan) {
  const title = effectivePlanTitle(plan);
  return Object.freeze({ title, approvalPrompt: `Apply “${title}”?` });
}

function skillTitle(action, scopeName, names) {
  const uniqueNames = [...new Set(names.map(String))].sort();
  if (uniqueNames.length === 1) return boundedTitle(`${action} ${scopeName} Skill: ${cleanText(uniqueNames[0])}`);
  if (uniqueNames.length > 1) return `${action} ${uniqueNames.length} ${scopeName} Skills`;
  return `${action} ${scopeName} Skills`;
}

function boundedTitle(value) {
  const clean = canonicalDisplayText(value);
  const codePoints = Array.from(clean);
  return codePoints.length <= MAX_TITLE_LENGTH
    ? clean
    : `${codePoints.slice(0, MAX_TITLE_LENGTH - 1).join('').trimEnd()}…`;
}

function cleanText(value) {
  return canonicalDisplayText(value);
}

function canonicalDisplayText(value) {
  return String(value).normalize('NFC').replace(UNSAFE_PRESENTATION_CHARACTERS, '�');
}

function validPlanTitle(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && Array.from(value).length <= MAX_TITLE_LENGTH
    && canonicalDisplayText(value) === value;
}

module.exports = { createPlanTitle, effectivePlanTitle, planPresentation, validPlanTitle };
