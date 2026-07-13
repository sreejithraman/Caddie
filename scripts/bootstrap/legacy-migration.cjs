const fs = require('node:fs');
const path = require('node:path');

const { assertSafeAncestorChain } = require('./safe-path.cjs');
const { bindArtifacts, stageArtifactSet } = require('./stage-artifact-set.cjs');

function createLegacyMigration({
  fingerprintDirectory,
  writeJson,
  releaseOwnedFile,
  ensureParents,
  maybeInjectFailure,
  maybeCrash,
  validOwner,
}) {
  return {
    recognizesJournal(journal) {
      return journal?.version === 3 && journal.mode === 'legacy-standard-migration';
    },

    async recover(journalPath, journal, layout) {
      const recovery = validateRecoveryStorage(
        journalPath,
        validateRecoveryJournal(journalPath, journal, layout, validOwner),
      );
      preflightRecovery(layout);
      await recoverLegacyMigration(journalPath, recovery, fingerprintDirectory, releaseOwnedFile, ensureParents);
    },

    async tryMigrate({ sourceSkill, commit, repository, layout, owner }) {
      const recognized = await recognizeLegacyLayout(layout, fingerprintDirectory);
      if (!recognized) return false;
      const prepared = await prepareLegacyMigration({
        sourceSkill,
        commit,
        repository,
        layout,
        owner,
        legacyConfig: recognized.config,
        fingerprintDirectory,
        writeJson,
      });
      await commitLegacyMigration({
        prepared,
        layout,
        owner,
        fingerprintDirectory,
        releaseOwnedFile,
        ensureParents,
        maybeInjectFailure,
        maybeCrash,
        validOwner,
      });
      return true;
    },
  };
}

async function recognizeLegacyLayout(layout, fingerprintDirectory) {
  const { legacyDestination, outputs, journalPath } = layout;
  const destinationStat = fs.lstatSync(outputs.destination, { throwIfNoEntry: false });
  if (!destinationStat?.isSymbolicLink()) return null;
  const legacyStat = fs.lstatSync(legacyDestination, { throwIfNoEntry: false });
  if (!legacyStat?.isDirectory() || legacyStat.isSymbolicLink()) return null;
  if (resolveLink(outputs.destination) !== path.resolve(legacyDestination)) return null;
  const claudeStat = fs.lstatSync(outputs.claudeExposure, { throwIfNoEntry: false });
  if (!claudeStat?.isSymbolicLink() || resolveLink(outputs.claudeExposure) !== path.resolve(legacyDestination)) return null;

  for (const artifact of fixedLegacyArtifacts(layout)) {
    assertSafeAncestorChain(artifact.anchor, artifact.path);
  }
  for (const operationFile of layout.activeOperationFiles) {
    assertSafeAncestorChain(operationFile.anchor, operationFile.path);
  }
  assertSafeAncestorChain(layout.anchors.state, journalPath);
  if (layout.activeOperationFiles.some(({ path: operationPath }) => (
    fs.lstatSync(operationPath, { throwIfNoEntry: false })
  ))) return null;
  for (const artifact of layout.artifacts.filter(({ kind }) => kind === 'document')) {
    const stat = fs.lstatSync(artifact.path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) return null;
  }

  let manifest;
  let lock;
  let ledger;
  let config;
  try {
    manifest = JSON.parse(fs.readFileSync(outputs.manifest, 'utf8'));
    lock = JSON.parse(fs.readFileSync(outputs.lock, 'utf8'));
    ledger = JSON.parse(fs.readFileSync(outputs.ledger, 'utf8'));
    config = JSON.parse(fs.readFileSync(outputs.config, 'utf8'));
  } catch {
    return null;
  }

  const legacyFingerprint = await fingerprintDirectory(legacyDestination);
  const entry = ledger?.entries?.find((candidate) => candidate.name === 'caddie');
  const expectedHarnessLinks = [outputs.destination, outputs.claudeExposure].sort();
  const isExactLegacyLayout = legacyFingerprint.complete
    && hasExactKeys(manifest, ['version', 'scope', 'sources', 'selections'])
    && manifest?.version === 1 && manifest.scope === 'user'
    && Object.keys(manifest.sources ?? {}).length === 1
    && hasExactKeys(manifest.sources?.caddie, ['type', 'url', 'ref'])
    && manifest.sources?.caddie?.type === 'git'
    && typeof manifest.sources.caddie.url === 'string'
    && Array.isArray(manifest.selections) && manifest.selections.length === 1
    && hasExactKeys(manifest.selections[0], ['source', 'path'])
    && manifest.selections[0]?.source === 'caddie'
    && manifest.selections[0]?.path === '.agents/skills/caddie'
    && hasExactKeys(lock, ['version', 'sources'])
    && lock?.version === 1 && Object.keys(lock.sources ?? {}).length === 1
    && hasExactKeys(lock.sources?.caddie, ['type', 'url', 'commit'])
    && lock.sources?.caddie?.type === 'git'
    && lock.sources.caddie.url === manifest.sources.caddie.url
    && typeof lock.sources.caddie.commit === 'string'
    && manifest.sources.caddie.ref === lock.sources.caddie.commit
    && hasExactKeys(ledger, ['version', 'scopeId', 'harnessLinks', 'entries'])
    && ledger?.version === 1 && ledger.scopeId === 'user'
    && Array.isArray(ledger.harnessLinks)
    && JSON.stringify([...ledger.harnessLinks].sort()) === JSON.stringify(expectedHarnessLinks)
    && Array.isArray(ledger.entries) && ledger.entries.length === 1
    && hasExactKeys(entry, ['name', 'path', 'source', 'selectedPath', 'fingerprint'])
    && path.resolve(entry?.path ?? '') === path.resolve(legacyDestination)
    && entry.source === 'caddie' && entry.selectedPath === '.agents/skills/caddie'
    && entry.fingerprint === legacyFingerprint.digest
    && config?.version === 1
    && path.resolve(config.userManifest ?? '') === path.resolve(outputs.manifest)
    && Array.isArray(config.registeredProjects);
  return isExactLegacyLayout ? { config } : null;
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

async function prepareLegacyMigration({
  sourceSkill,
  commit,
  repository,
  layout,
  owner,
  legacyConfig,
  fingerprintDirectory,
  writeJson,
}) {
  const { caddieHome, outputs, journalPath } = layout;
  const stage = fs.mkdtempSync(path.join(caddieHome, '.standard-migration-'));
  const stagedRoot = path.join(stage, 'new');
  const backupRoot = path.join(stage, 'backups');
  fs.mkdirSync(stagedRoot);
  fs.mkdirSync(backupRoot);

  try {
    const stagedArtifacts = await stageArtifactSet({
      stageRoot: stagedRoot,
      sourceSkill,
      artifacts: layout.artifacts,
      outputs,
      repository,
      commit,
      config: legacyConfig,
      fingerprintDirectory,
      writeJson,
    });

    const targets = Object.fromEntries(fixedLegacyArtifacts(layout).map(({ name, path: artifactPath }) => [name, artifactPath]));
    const backups = Object.fromEntries(Object.keys(targets).map((name) => [name, path.join(backupRoot, name)]));
    const oldExpected = await bindArtifacts(targets, 'Legacy migration could not bind existing artifact', fingerprintDirectory);
    writeJson(journalPath, {
      version: 3,
      mode: 'legacy-standard-migration',
      owner,
      stage,
      targets,
      backups,
      oldExpected,
      newExpected: stagedArtifacts.expected,
    });
    return { stage, staged: stagedArtifacts.staged, targets, backups };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

async function commitLegacyMigration({
  prepared,
  layout,
  owner,
  fingerprintDirectory,
  releaseOwnedFile,
  ensureParents,
  maybeInjectFailure,
  maybeCrash,
  validOwner,
}) {
  let published = 0;
  try {
    for (const [name, candidate] of Object.entries(prepared.targets)) fs.renameSync(candidate, prepared.backups[name]);
    for (const artifact of layout.artifacts) {
      fs.renameSync(prepared.staged[artifact.name], artifact.path);
      published += 1;
      maybeInjectFailure(published);
      maybeCrash(published);
    }
    fs.rmSync(prepared.stage, { recursive: true, force: true });
    releaseOwnedFile(layout.journalPath, owner.nonce);
  } catch (error) {
    const journal = JSON.parse(fs.readFileSync(layout.journalPath, 'utf8'));
    const recovery = validateRecoveryStorage(
      layout.journalPath,
      validateRecoveryJournal(layout.journalPath, journal, layout, validOwner),
    );
    preflightRecovery(layout);
    await recoverLegacyMigration(layout.journalPath, recovery, fingerprintDirectory, releaseOwnedFile, ensureParents);
    throw error;
  }
}

function validateRecoveryJournal(journalPath, journal, layout, validOwner) {
  const caddieHome = path.dirname(journalPath);
  const targetArtifacts = fixedLegacyArtifacts(layout);
  const targetNames = targetArtifacts.map(({ name }) => name);
  const outputNames = layout.artifacts.map(({ name }) => name);
  const expectedTargets = Object.fromEntries(targetArtifacts.map(({ name, path: artifactPath }) => [name, artifactPath]));
  if (!hasExactKeys(journal, ['version', 'mode', 'owner', 'stage', 'targets', 'backups', 'oldExpected', 'newExpected'])
    || journal.version !== 3
    || journal.mode !== 'legacy-standard-migration'
    || !validOwner(journal.owner)
    || !hasExactKeys(journal.owner, ['pid', 'nonce', 'acquiredAt'])
    || typeof journal.stage !== 'string'
    || path.dirname(path.resolve(journal.stage)) !== path.resolve(caddieHome)
    || !path.basename(journal.stage).startsWith('.standard-migration-')
    || !hasExactKeys(journal.targets, targetNames)
    || !hasExactKeys(journal.backups, targetNames)
    || !hasExactKeys(journal.oldExpected, targetNames)
    || !hasExactKeys(journal.newExpected, outputNames)) {
    throw new Error('Bootstrap legacy migration journal has an unsupported shape.');
  }
  for (const [name, candidate] of Object.entries(expectedTargets)) {
    if (path.resolve(journal.targets[name] ?? '') !== path.resolve(candidate)
      || path.resolve(journal.backups[name] ?? '') !== path.join(path.resolve(journal.stage), 'backups', name)
      || typeof journal.oldExpected[name] !== 'string') {
      throw new Error('Bootstrap legacy migration journal does not bind fixed artifacts.');
    }
    if (name !== 'legacyDestination' && typeof journal.newExpected[name] !== 'string') {
      throw new Error('Bootstrap legacy migration journal does not bind staged artifacts.');
    }
  }
  return {
    owner: journal.owner,
    stage: path.resolve(journal.stage),
    targets: expectedTargets,
    backups: Object.fromEntries(targetNames.map((name) => [name, path.join(path.resolve(journal.stage), 'backups', name)])),
    oldExpected: Object.fromEntries(targetNames.map((name) => [name, journal.oldExpected[name]])),
    newExpected: Object.fromEntries(outputNames.map((name) => [name, journal.newExpected[name]])),
    outputNames,
  };
}

async function recoverLegacyMigration(journalPath, recovery, fingerprintDirectory, releaseOwnedFile, ensureParents) {
  if (!recovery.stagePresent) {
    for (const name of recovery.outputNames) {
      const candidate = recovery.targets[name];
      const evidence = await fingerprintDirectory(candidate);
      if (!evidence.complete || evidence.digest !== recovery.newExpected[name]) {
        throw new Error(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
    }
    releaseOwnedFile(journalPath, recovery.owner.nonce);
    return;
  }
  for (const [name, candidate] of Object.entries(recovery.targets)) {
    const backup = recovery.backups[name];
    const backupStat = fs.lstatSync(backup, { throwIfNoEntry: false });
    const targetStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!backupStat) {
      if (!targetStat) throw new Error(`Bootstrap recovery is missing legacy artifact: ${candidate}`);
      const evidence = await fingerprintDirectory(candidate);
      if (!evidence.complete || evidence.digest !== recovery.oldExpected[name]) {
        throw new Error(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
      continue;
    }
    const backupEvidence = await fingerprintDirectory(backup);
    if (!backupEvidence.complete || backupEvidence.digest !== recovery.oldExpected[name]) {
      throw new Error(`Bootstrap recovery preserves changed backup: ${backup}`);
    }
    if (targetStat) {
      const targetEvidence = await fingerprintDirectory(candidate);
      if (!targetEvidence.complete || targetEvidence.digest !== recovery.newExpected[name]) {
        throw new Error(`Bootstrap recovery preserves changed artifact: ${candidate}`);
      }
      fs.rmSync(candidate, { recursive: true, force: true });
    }
    ensureParents(candidate, []);
    fs.renameSync(backup, candidate);
  }
  fs.rmSync(recovery.stage, { recursive: true, force: true });
  releaseOwnedFile(journalPath, recovery.owner.nonce);
}

function validateRecoveryStorage(journalPath, recovery) {
  const caddieHome = path.dirname(journalPath);
  requireRealRecoveryDirectory(caddieHome);
  const stageStat = fs.lstatSync(recovery.stage, { throwIfNoEntry: false });
  if (!stageStat) return { ...recovery, stagePresent: false };
  requireRealRecoveryDirectory(recovery.stage, stageStat);
  requireRealRecoveryDirectory(path.join(recovery.stage, 'backups'));
  return { ...recovery, stagePresent: true };
}

function requireRealRecoveryDirectory(candidate, stat = fs.lstatSync(candidate, { throwIfNoEntry: false })) {
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Bootstrap recovery requires a real recovery directory: ${candidate}`);
  }
}

function fixedLegacyArtifacts(layout) {
  return [
    ...layout.artifacts,
    {
      name: 'legacyDestination',
      kind: 'legacy-skill-directory',
      anchor: layout.anchors.state,
      path: layout.legacyDestination,
    },
  ];
}

function preflightRecovery(layout) {
  for (const artifact of fixedLegacyArtifacts(layout)) {
    assertSafeAncestorChain(artifact.anchor, artifact.path);
  }
}

function resolveLink(candidate) {
  return path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
}

module.exports = { createLegacyMigration };
