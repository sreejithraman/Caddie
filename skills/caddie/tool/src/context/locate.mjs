import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { invalid } from '../protocol/errors.mjs';
import { loadRegistry } from '../registry/load-registry.mjs';

export async function locate(input, runtime = {}) {
  const env = runtime.env ?? process.env;
  const cwd = path.resolve(input.cwd ?? runtime.cwd ?? process.cwd());
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const configHome = path.resolve(input.configHome ?? env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  const registry = await loadRegistry(input, configHome);
  const userManifestPath = path.resolve(
    input.userManifestPath
      ?? env.CADDIE_USER_MANIFEST
      ?? registry.userManifest
      ?? path.join(configHome, 'caddie', 'caddie.json'),
  );

  const cwdExists = await exists(cwd);
  if (!cwdExists) throw invalid('cwd-not-found', `Working directory does not exist: ${cwd}`, { cwd });

  const projectManifestPath = input.projectManifestPath
    ? path.resolve(input.projectManifestPath)
    : await findUp('caddie.json', cwd, userManifestPath);

  const userExists = await exists(userManifestPath);
  const projectExists = projectManifestPath ? await exists(projectManifestPath) : false;
  const issues = [];
  if (!userExists) issues.push({ scope: 'user', code: 'manifest-missing', path: userManifestPath });
  if (!projectExists) issues.push({ scope: 'project', code: 'manifest-missing', path: projectManifestPath });
  if (registry.status === 'unsupported') {
    issues.push({
      scope: 'machine',
      code: 'unsupported-machine-config-version',
      path: registry.configPath,
      supported: [1],
      received: registry.version,
    });
  }

  return {
    user: { manifestPath: userManifestPath, status: userExists ? 'found' : 'missing' },
    project: {
      root: projectManifestPath ? path.dirname(projectManifestPath) : cwd,
      manifestPath: projectManifestPath,
      status: projectExists ? 'found' : 'missing',
    },
    registry,
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

async function exists(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
