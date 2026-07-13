const path = require('node:path');
const {
  canonicalSkillsRoot,
  claudeSkillsRoot,
  userLayout,
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
    resolve: ({ layout }) => layout.manifestPath,
  },
  {
    name: 'lock',
    kind: 'document',
    anchor: 'state',
    resolve: ({ layout }) => layout.lockPath,
  },
  {
    name: 'ledger',
    kind: 'document',
    anchor: 'state',
    resolve: ({ layout }) => layout.ledgerPath,
  },
  {
    name: 'registry',
    kind: 'document',
    anchor: 'state',
    resolve: ({ layout }) => layout.registryPath,
  },
]);

function createBootstrapLayout({ home }) {
  const layout = userLayout(home);
  const caddieHome = layout.stateRoot;
  const userHome = path.resolve(home);
  const userScope = { id: 'user', root: userHome };
  const anchors = {
    user: path.resolve(home),
    state: path.resolve(home),
  };
  const context = { home, caddieHome, userHome, userScope, layout };
  const artifacts = ARTIFACT_DESCRIPTORS.map(({ resolve, ...descriptor }) => ({
    ...descriptor,
    path: resolve(context),
    anchor: anchors[descriptor.anchor],
  }));
  const outputs = Object.fromEntries(artifacts.map((artifact) => [artifact.name, artifact.path]));
  return {
    caddieHome,
    userHome,
    outputs,
    journalPath: path.join(caddieHome, '.bootstrap-journal.json'),
    lockPath: path.join(caddieHome, '.bootstrap.lock'),
    anchors,
    artifacts,
  };
}

function createArtifactDocuments({ outputs, repository, commit, fingerprint, registry = {} }) {
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
    registry: {
      ...registry,
      version: 1,
      registeredProjects: Array.isArray(registry.registeredProjects) ? registry.registeredProjects : [],
    },
  };
}

module.exports = { ARTIFACT_DESCRIPTORS, createArtifactDocuments, createBootstrapLayout };
