const path = require('node:path');
const {
  canonicalSkillsRoot,
  claudeSkillsRoot,
  runtimeUserCoordinationRoot,
  stateRoot,
} = require('../../skills/caddie/tool/src/layout');

const ARTIFACT_DESCRIPTORS = Object.freeze([
  {
    name: 'destination',
    kind: 'skill-directory',
    anchor: 'user',
    resolve: ({ userScope, home }) => path.join(canonicalSkillsRoot(userScope, home), 'caddie'),
  },
  {
    name: 'claudeExposure',
    kind: 'compatibility-link',
    anchor: 'user',
    resolve: ({ userScope, home }) => path.join(claudeSkillsRoot(userScope, home), 'caddie'),
  },
  {
    name: 'manifest',
    kind: 'document',
    anchor: 'state',
    resolve: ({ userHome }) => path.join(userHome, 'caddie.json'),
  },
  {
    name: 'lock',
    kind: 'document',
    anchor: 'state',
    resolve: ({ userHome }) => path.join(userHome, 'caddie.lock'),
  },
  {
    name: 'ledger',
    kind: 'document',
    anchor: 'state',
    resolve: ({ userScope }) => path.join(stateRoot(userScope), 'ledger.json'),
  },
  {
    name: 'config',
    kind: 'document',
    anchor: 'state',
    resolve: ({ caddieHome }) => path.join(caddieHome, 'config.json'),
  },
]);

function createBootstrapLayout({ home, configHome }) {
  const caddieHome = path.join(configHome, 'caddie');
  const userHome = path.join(caddieHome, 'user');
  const userScope = { id: 'user', root: userHome };
  const anchors = {
    user: path.resolve(home),
    state: path.resolve(configHome),
  };
  const context = { home, configHome, caddieHome, userHome, userScope };
  const artifacts = ARTIFACT_DESCRIPTORS.map(({ resolve, ...descriptor }) => ({
    ...descriptor,
    path: resolve(context),
    anchor: anchors[descriptor.anchor],
  }));
  const outputs = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.path]));
  const activeOperationFiles = [
    {
      name: 'legacyOperationJournal',
      path: path.join(stateRoot(userScope), 'operation-journal.json'),
      anchor: anchors.state,
    },
    {
      name: 'standardUserOperation',
      path: path.join(runtimeUserCoordinationRoot(home), 'user-operation.json'),
      anchor: anchors.user,
    },
  ];
  return {
    caddieHome,
    userHome,
    outputs,
    journalPath: path.join(caddieHome, '.bootstrap-journal.json'),
    lockPath: path.join(caddieHome, '.bootstrap.lock'),
    legacyDestination: path.join(canonicalSkillsRoot({ id: 'project', root: userHome }), 'caddie'),
    anchors,
    artifacts,
    activeOperationFiles,
  };
}

function createArtifactDocuments({ outputs, repository, commit, fingerprint, config = {} }) {
  const source = { type: 'git', url: repository, ref: commit };
  return {
    manifest: {
      version: 1,
      scope: 'user',
      sources: { caddie: source },
      selections: [{ source: 'caddie', path: 'skills/caddie' }],
    },
    lock: {
      version: 1,
      sources: { caddie: { type: 'git', url: repository, commit } },
    },
    ledger: {
      version: 1,
      scopeId: 'user',
      harnessLinks: [outputs.claudeExposure],
      entries: [{
        name: 'caddie',
        path: outputs.destination,
        source: 'caddie',
        selectedPath: 'skills/caddie',
        fingerprint,
      }],
    },
    config: {
      ...config,
      version: 1,
      userManifest: outputs.manifest,
      registeredProjects: Array.isArray(config.registeredProjects) ? config.registeredProjects : [],
    },
  };
}

module.exports = { ARTIFACT_DESCRIPTORS, createArtifactDocuments, createBootstrapLayout };
