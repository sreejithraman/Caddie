import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { invalid } from '../protocol/errors.mjs';
import { loadRegistry } from '../registry/load-registry.mjs';

const require = createRequire(import.meta.url);
const { scopeLayout, userLayout } = require('../layout');

export async function locate(input, runtime = {}) {
  const env = runtime.env ?? process.env;
  const cwd = path.resolve(input.cwd ?? runtime.cwd ?? process.cwd());
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const configHome = path.resolve(input.configHome ?? env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  const user = userLayout(home);
  const registry = await loadRegistry(input, home);
  const userManifestPath = user.manifestPath;
  const legacyConfigPath = path.join(configHome, 'caddie', 'config.json');

  const cwdExists = await exists(cwd);
  if (!cwdExists) throw invalid('cwd-not-found', `Working directory does not exist: ${cwd}`, { cwd });

  const projectManifestPath = input.projectManifestPath
    ? path.resolve(input.projectManifestPath)
    : await findUp(path.join('.agents', '.caddie', 'manifest.json'), cwd, userManifestPath);
  const projectRoot = projectManifestPath ? projectRootFromManifest(projectManifestPath) : cwd;

  const userExists = await exists(userManifestPath);
  const projectExists = projectManifestPath ? await exists(projectManifestPath) : false;
  const legacyExists = await exists(legacyConfigPath);
  const issues = [];
  if (!userExists) issues.push({ scope: 'user', code: 'manifest-missing', path: userManifestPath });
  if (!projectExists) issues.push({ scope: 'project', code: 'manifest-missing', path: projectManifestPath });
  if (legacyExists) issues.push({ scope: 'user', code: 'legacy-state-present', path: legacyConfigPath });
  if (registry.status === 'unsupported') {
    issues.push({
      scope: 'machine',
      code: 'unsupported-registry-version',
      path: registry.registryPath,
      supported: [1],
      received: registry.version,
    });
  }

  return {
    user: { root: home, manifestPath: userManifestPath, status: userExists ? 'found' : 'missing' },
    project: {
      root: projectRoot,
      manifestPath: projectManifestPath,
      status: projectExists ? 'found' : 'missing',
    },
    registry,
    legacy: { configPath: legacyConfigPath, status: legacyExists ? 'found' : 'missing' },
    coverage: { status: issues.length ? 'partial' : 'complete', issues },
  };
}

async function findUp(fileName, start, excludedPath) {
  let directory = start;
  while (true) {
    const candidate = path.join(directory, fileName);
    if (candidate !== excludedPath && await exists(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function projectRootFromManifest(manifestPath) {
  const stateRoot = path.dirname(manifestPath);
  if (path.basename(stateRoot) !== '.caddie' || path.basename(path.dirname(stateRoot)) !== '.agents') {
    throw invalid('invalid-project-manifest-path', `Project manifest must live at .agents/.caddie/manifest.json: ${manifestPath}`, {
      manifestPath,
    });
  }
  return path.dirname(path.dirname(stateRoot));
}

async function exists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
