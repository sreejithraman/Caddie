import path from 'node:path';
import os from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { fingerprint } = require('../apply/filesystem');
const { userLayout } = require('../layout');

export async function planProjectRegistration(input, runtime = {}) {
  if (typeof input.scope?.id !== 'string' || !input.scope.id.startsWith('project:')) {
    return { scope: input.scope, operation: null };
  }
  const env = runtime.env ?? process.env;
  const home = path.resolve(input.home ?? env.HOME ?? os.homedir());
  const registryPath = userLayout(home).registryPath;
  const projectRoot = await realpath(path.resolve(input.scope.root));

  let current;
  let expected;
  try {
    current = JSON.parse(await readFile(registryPath, 'utf8'));
    expected = { state: 'file', fingerprint: await fingerprint(registryPath) };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      current = { version: 1, registeredProjects: [] };
      expected = { state: 'absent' };
    } else if (error instanceof SyntaxError) {
      throw invalid('invalid-registry-json', `Caddie Registry is not valid JSON: ${registryPath}`, { registryPath });
    } else {
      throw error;
    }
  }

  if (!current || Array.isArray(current) || typeof current !== 'object' || current.version !== 1) {
    throw invalid('invalid-registry', `Caddie Registry must be a supported version 1 object: ${registryPath}`, { registryPath });
  }
  if (!Array.isArray(current.registeredProjects)
    || current.registeredProjects.some((project) => typeof project !== 'string')) {
    throw invalid('invalid-registered-projects', 'Registered Projects must be an array of paths', { registryPath });
  }

  const registeredRealPaths = await Promise.all(current.registeredProjects.map(async (project) => {
    const resolved = path.resolve(project);
    return realpath(resolved).catch((error) => error.code === 'ENOENT' ? resolved : Promise.reject(error));
  }));
  const alreadyRegistered = registeredRealPaths.includes(projectRoot);
  return {
    scope: input.scope,
    operation: alreadyRegistered ? null : {
      type: 'write-registry',
      path: registryPath,
      content: `${JSON.stringify({
        ...current,
        registeredProjects: [...current.registeredProjects, projectRoot],
      }, null, 2)}\n`,
      expected,
    },
  };
}
