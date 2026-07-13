import path from 'node:path';
import os from 'node:os';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');

export async function planProjectRegistration(input, runtime = {}) {
  if (typeof input.scope?.id !== 'string' || !input.scope.id.startsWith('project:')) {
    return { scope: input.scope, operation: null };
  }
  const env = runtime.env ?? process.env;
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const configHome = path.resolve(input.configHome ?? env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  const configRoot = path.join(configHome, 'caddie');
  const configPath = path.join(configRoot, 'config.json');
  const configAnchor = await nearestExistingDirectory(configHome);
  const projectRoot = await realpath(path.resolve(input.scope.root));

  let current;
  let expected;
  try {
    current = JSON.parse(await readFile(configPath, 'utf8'));
    expected = { state: 'file', fingerprint: await fingerprint(configPath) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      current = { version: 1, registeredProjects: [] };
      expected = { state: 'absent' };
    } else if (error instanceof SyntaxError) {
      throw invalid('invalid-machine-config-json', `Machine configuration is not valid JSON: ${configPath}`, { configPath });
    } else {
      throw error;
    }
  }

  if (!current || Array.isArray(current) || typeof current !== 'object' || current.version !== 1) {
    throw invalid('invalid-machine-config', `Machine configuration must be a supported version 1 object: ${configPath}`, { configPath });
  }
  if (!Array.isArray(current.registeredProjects)
    || current.registeredProjects.some((project) => typeof project !== 'string')) {
    throw invalid('invalid-registered-projects', 'Registered Projects must be an array of paths', { configPath });
  }

  const registeredRealPaths = await Promise.all(current.registeredProjects.map(async (project) => {
    const resolved = path.resolve(project);
    return realpath(resolved).catch((error) => error.code === 'ENOENT' ? resolved : Promise.reject(error));
  }));
  const alreadyRegistered = registeredRealPaths.includes(projectRoot);
  return {
    scope: { ...input.scope, configRoot: configAnchor, machineConfigPath: configPath },
    operation: alreadyRegistered ? null : {
      type: 'write-machine-config',
      path: configPath,
      content: `${JSON.stringify({
        ...current,
        registeredProjects: [...current.registeredProjects, projectRoot],
      }, null, 2)}\n`,
      expected,
    },
  };
}

async function nearestExistingDirectory(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    const stat = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw invalid('invalid-config-home', `Machine configuration ancestor must be a real directory: ${current}`, { path: current });
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw invalid('invalid-config-home', `No real ancestor exists for machine configuration: ${candidate}`);
    current = parent;
  }
}
