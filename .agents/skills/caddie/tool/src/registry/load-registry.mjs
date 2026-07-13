import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { invalid } from '../protocol/errors.mjs';

export const REGISTRY_VERSION = 1;

export async function loadRegistry(input, configHome) {
  const configPath = path.resolve(
    input.machineConfigPath ?? path.join(configHome, 'caddie', 'config.json'),
  );
  let text;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return { status: 'missing', configPath, userManifest: null, registeredProjects: [] };
    }
    throw cause;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('invalid-machine-config-json', `Machine configuration is not valid JSON: ${configPath}`, {
      configPath,
    });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw invalid('invalid-machine-config', `Machine configuration must be an object: ${configPath}`, {
      configPath,
    });
  }
  if (value.version !== REGISTRY_VERSION) {
    return {
      status: 'unsupported',
      configPath,
      version: value.version ?? null,
      userManifest: null,
      registeredProjects: [],
    };
  }
  if (!Array.isArray(value.registeredProjects) || value.registeredProjects.some((item) => typeof item !== 'string')) {
    throw invalid('invalid-registered-projects', 'Registered Projects must be an array of paths', {
      configPath,
    });
  }
  return {
    status: 'found',
    configPath,
    version: value.version,
    userManifest: typeof value.userManifest === 'string' ? path.resolve(value.userManifest) : null,
    registeredProjects: [...new Set(value.registeredProjects.map((item) => path.resolve(item)))],
  };
}
