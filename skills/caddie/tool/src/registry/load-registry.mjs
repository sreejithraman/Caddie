import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { invalid } from '../protocol/errors.mjs';

const require = createRequire(import.meta.url);
const { userLayout } = require('../layout');

export const REGISTRY_VERSION = 1;

export async function loadRegistry(input, home) {
  const registryPath = userLayout(home).registryPath;
  let text;
  try {
    text = await readFile(registryPath, 'utf8');
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      return { status: 'missing', registryPath, registeredProjects: [] };
    }
    throw cause;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('invalid-registry-json', `Caddie Registry is not valid JSON: ${registryPath}`, {
      registryPath,
    });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw invalid('invalid-registry', `Caddie Registry must be an object: ${registryPath}`, {
      registryPath,
    });
  }
  if (value.version !== REGISTRY_VERSION) {
    return {
      status: 'unsupported',
      registryPath,
      version: value.version ?? null,
      registeredProjects: [],
    };
  }
  if (!Array.isArray(value.registeredProjects) || value.registeredProjects.some((item) => typeof item !== 'string')) {
    throw invalid('invalid-registered-projects', 'Registered Projects must be an array of paths', {
      registryPath,
    });
  }
  return {
    status: 'found',
    registryPath,
    version: value.version,
    registeredProjects: [...new Set(value.registeredProjects.map((item) => path.resolve(item)))],
  };
}
