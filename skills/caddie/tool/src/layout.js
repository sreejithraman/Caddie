'use strict';

const os = require('node:os');
const path = require('node:path');

const HARNESS_SETTINGS = Object.freeze({
  codex: Object.freeze({
    value: false,
    layout(_scope, home) {
      return { path: userLayout(home).codexConfigPath, anchorRoot: path.resolve(home), userCoordinated: true };
    },
  }),
  claude: Object.freeze({
    value: 'off',
    layout(scope, home) {
      const user = scope.id === 'user';
      return {
        path: user
          ? userLayout(home).claudeSettingsPath
          : path.join(path.resolve(scope.root), '.claude', 'settings.local.json'),
        anchorRoot: user ? path.resolve(home) : path.resolve(scope.root),
        userCoordinated: user,
      };
    },
  }),
});

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
    codexConfigPath: path.join(path.resolve(home), '.codex', 'config.toml'),
    claudeSettingsPath: path.join(path.resolve(home), '.claude', 'settings.json'),
  });
}

function harnessSettingsLayout(harness, scope, home = os.homedir()) {
  const descriptor = HARNESS_SETTINGS[harness];
  if (!descriptor) throw new Error(`unsupported harness: ${String(harness)}`);
  return Object.freeze(descriptor.layout(scope, home));
}

function harnessSettingsPath(harness, scope, home = os.homedir()) {
  return harnessSettingsLayout(harness, scope, home).path;
}

function supportsHarnessSettings(harness) {
  return Object.hasOwn(HARNESS_SETTINGS, harness);
}

function validHarnessSettingValue(harness, value) {
  return supportsHarnessSettings(harness) && HARNESS_SETTINGS[harness].value === value;
}

function harnessSettingValue(harness) {
  if (!supportsHarnessSettings(harness)) throw new Error(`unsupported harness: ${String(harness)}`);
  return HARNESS_SETTINGS[harness].value;
}

function supportedHarnesses() {
  return Object.freeze(Object.keys(HARNESS_SETTINGS));
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
  harnessSettingsLayout,
  harnessSettingsPath,
  harnessSettingValue,
  runtimeUserCoordinationRoot,
  scopeLayout,
  userLayout,
  supportsHarnessSettings,
  supportedHarnesses,
  validHarnessSettingValue,
};
