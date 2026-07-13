const fs = require('node:fs');
const path = require('node:path');

const { createArtifactDocuments } = require('./artifacts.cjs');

async function stageArtifactSet({
  stageRoot,
  sourceSkill,
  artifacts,
  outputs,
  repository,
  commit,
  registry,
  fingerprintDirectory,
  writeJson,
}) {
  const staged = Object.fromEntries(artifacts.map(({ name }) => [name, path.join(stageRoot, name)]));
  for (const artifact of artifacts.filter(({ kind }) => kind === 'skill-directory')) {
    fs.cpSync(sourceSkill, staged[artifact.name], { recursive: true, errorOnExist: true, force: false });
  }

  const fingerprint = await fingerprintDirectory(staged.destination);
  if (!fingerprint.complete) throw new Error('The staged Caddie Skill could not be fingerprinted completely.');
  const documents = createArtifactDocuments({
    outputs,
    repository,
    commit,
    fingerprint: fingerprint.digest,
    registry,
  });
  for (const artifact of artifacts) {
    if (artifact.kind === 'compatibility-link') {
      fs.mkdirSync(path.dirname(staged[artifact.name]), { recursive: true });
      fs.symlinkSync(
        path.relative(path.dirname(artifact.path), outputs.destination),
        staged[artifact.name],
        'dir',
      );
    } else if (artifact.kind === 'document') {
      writeJson(staged[artifact.name], documents[artifact.name]);
    }
  }

  return {
    staged,
    expected: await bindArtifacts(
      staged,
      'Bootstrap could not bind staged artifact',
      fingerprintDirectory,
    ),
  };
}

async function bindArtifacts(artifacts, failurePrefix, fingerprintDirectory) {
  const expected = {};
  for (const [name, candidate] of Object.entries(artifacts)) {
    const evidence = await fingerprintDirectory(candidate);
    if (!evidence.complete) throw new Error(`${failurePrefix}: ${name}`);
    expected[name] = evidence.digest;
  }
  return expected;
}

module.exports = { bindArtifacts, stageArtifactSet };
