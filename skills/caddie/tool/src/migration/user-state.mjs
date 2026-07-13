import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { createPlan } = require('../plans');
const { userLayout } = require('../layout');

export async function inspectUserStateMigration(input = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const configHome = path.resolve(input.configHome ?? env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  const legacyRoot = path.join(configHome, 'caddie');
  const configPath = path.join(legacyRoot, 'config.json');
  const destination = userLayout(home);
  const config = await readJsonFile(configPath, { allowMissing: true, label: 'legacy machine configuration' });
  if (!config) {
    return {
      status: 'absent',
      home,
      configHome,
      legacyRoot,
      destination: publicDestination(destination),
      removable: false,
      findings: [],
    };
  }
  if (config.version !== 1 || typeof config.userManifest !== 'string'
    || !Array.isArray(config.registeredProjects)
    || config.registeredProjects.some((candidate) => typeof candidate !== 'string')) {
    throw invalid('unsupported-legacy-state', `Legacy Caddie state is not a supported version 1 layout: ${configPath}`, {
      configPath,
    });
  }

  const source = {
    manifestPath: path.resolve(config.userManifest),
  };
  source.root = path.dirname(source.manifestPath);
  source.lockPath = path.join(source.root, 'caddie.lock');
  source.ledgerPath = path.join(source.root, '.agents', '.caddie', 'ledger.json');

  const collisions = [];
  for (const candidate of [destination.manifestPath, destination.lockPath, destination.ledgerPath, destination.registryPath]) {
    if (await exists(candidate)) collisions.push(candidate);
  }
  if (collisions.length > 0) {
    return {
      status: 'collision',
      home,
      configHome,
      legacyRoot,
      source,
      destination: publicDestination(destination),
      removable: false,
      findings: collisions.map((candidate) => ({ code: 'migration-target-exists', path: candidate })),
    };
  }

  const [manifestValue, lockValue, ledgerValue] = await Promise.all([
    readJsonFile(source.manifestPath, { label: 'legacy User Skills manifest' }),
    readJsonFile(source.lockPath, { label: 'legacy Caddie lock' }),
    readJsonFile(source.ledgerPath, { label: 'legacy Caddie ledger' }),
  ]);
  await parseManifest(source.manifestPath, 'user', source.root);
  if (lockValue.version !== 1 || !lockValue.sources || typeof lockValue.sources !== 'object') {
    throw invalid('unsupported-legacy-lock', `Legacy Caddie Lock is not supported: ${source.lockPath}`, { path: source.lockPath });
  }
  if (ledgerValue.version !== 1 || ledgerValue.scopeId !== 'user' || !Array.isArray(ledgerValue.entries)) {
    throw invalid('unsupported-legacy-ledger', `Legacy Caddie Ledger is not supported: ${source.ledgerPath}`, { path: source.ledgerPath });
  }

  const [legacyFingerprint, manifestFingerprint, lockFingerprint, ledgerFingerprint] = await Promise.all([
    fingerprint(legacyRoot),
    fingerprint(source.manifestPath),
    fingerprint(source.lockPath),
    fingerprint(source.ledgerPath),
  ]);
  const externalSourceState = !isInside(legacyRoot, source.root);
  return {
    status: 'ready',
    home,
    configHome,
    legacyRoot,
    legacyFingerprint,
    source: {
      ...source,
      manifestFingerprint,
      lockFingerprint,
      ledgerFingerprint,
      external: externalSourceState,
    },
    destination: publicDestination(destination),
    documents: {
      manifest: rebaseLocalSources(manifestValue, source.root),
      lock: lockValue,
      ledger: ledgerValue,
      registry: {
        version: 1,
        registeredProjects: [...new Set(config.registeredProjects.map((candidate) => path.resolve(candidate)))],
      },
    },
    removable: true,
    findings: externalSourceState
      ? [{ code: 'external-legacy-source-preserved', paths: [source.manifestPath, source.lockPath, source.ledgerPath] }]
      : [],
  };
}

export async function createUserStateMigrationPlan(input = {}, runtime = {}) {
  const evidence = await inspectUserStateMigration(input, runtime);
  if (evidence.status !== 'ready' || evidence.removable !== true) {
    throw invalid('user-state-migration-not-ready', `User state migration is not ready: ${evidence.status}`, {
      status: evidence.status,
      findings: evidence.findings,
    });
  }
  const scope = { id: 'user', root: evidence.home, legacyConfigHome: evidence.configHome };
  const content = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const operations = [
    { type: 'write-manifest', path: evidence.destination.manifestPath, content: content(evidence.documents.manifest), expected: { state: 'absent' } },
    { type: 'write-lock', path: evidence.destination.lockPath, content: content(evidence.documents.lock), expected: { state: 'absent' } },
    { type: 'write-registry', path: evidence.destination.registryPath, content: content(evidence.documents.registry), expected: { state: 'absent' } },
    { type: 'remove-legacy-state', path: evidence.legacyRoot, expected: { state: 'fingerprint', fingerprint: evidence.legacyFingerprint } },
    { type: 'write-ledger', path: evidence.destination.ledgerPath, content: content(evidence.documents.ledger), expected: { state: 'absent' } },
  ];
  const preconditions = evidence.source.external ? [
    { path: evidence.source.manifestPath, expected: { state: 'file', fingerprint: evidence.source.manifestFingerprint } },
    { path: evidence.source.lockPath, expected: { state: 'file', fingerprint: evidence.source.lockFingerprint } },
    { path: evidence.source.ledgerPath, expected: { state: 'file', fingerprint: evidence.source.ledgerFingerprint } },
  ] : [];
  return { evidence, plan: createPlan({ kind: 'migrate', home: evidence.home, scope, operations, preconditions }) };
}

function publicDestination(layout) {
  return {
    stateRoot: layout.stateRoot,
    manifestPath: layout.manifestPath,
    lockPath: layout.lockPath,
    ledgerPath: layout.ledgerPath,
    registryPath: layout.registryPath,
  };
}

function rebaseLocalSources(manifest, sourceRoot) {
  const copy = structuredClone(manifest);
  if (Array.isArray(copy.sources)) {
    copy.sources = copy.sources.map((source) => source?.type === 'local'
      ? { ...source, path: path.resolve(sourceRoot, source.path) }
      : source);
  } else if (copy.sources && typeof copy.sources === 'object') {
    copy.sources = Object.fromEntries(Object.entries(copy.sources).map(([name, source]) => [
      name,
      source?.type === 'local' ? { ...source, path: path.resolve(sourceRoot, source.path) } : source,
    ]));
  }
  return copy;
}

async function readJsonFile(candidate, { allowMissing = false, label } = {}) {
  let text;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalid('unsafe-legacy-state', `${label} must be a real file: ${candidate}`, { path: candidate });
    text = await fs.readFile(candidate, 'utf8');
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw invalid('invalid-legacy-state-json', `${label} is not valid JSON: ${candidate}`, { path: candidate });
  }
}

async function exists(candidate) {
  return fs.lstat(candidate).then(() => true, (error) => error.code === 'ENOENT' ? false : Promise.reject(error));
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
