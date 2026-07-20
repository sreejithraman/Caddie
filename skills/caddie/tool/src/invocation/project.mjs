import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const YAML = require('../../vendor/yaml.cjs');

export const USER_ONLY_INVOCATION = 'user-only';

export function validateInvocationPolicy(value) {
  if (value === undefined) return null;
  if (value !== USER_ONLY_INVOCATION) {
    throw invocationError(
      'invalid-invocation-policy',
      `Invocation Policy must be ${JSON.stringify(USER_ONLY_INVOCATION)}`,
    );
  }
  return value;
}

export async function inspectInvocation(root) {
  const findings = [];
  const disableModelInvocation = await invocationValue(
    () => readSkillInvocation(path.join(root, 'SKILL.md')), 'SKILL.md', findings,
  );
  const allowImplicitInvocation = await invocationValue(
    () => readCodexInvocation(path.join(root, 'agents', 'openai.yaml')), 'agents/openai.yaml', findings,
  );
  return {
    disableModelInvocation,
    allowImplicitInvocation,
    classification: classify({ disableModelInvocation, allowImplicitInvocation }),
    ...(findings.length > 0 ? { findings } : {}),
  };
}

export async function projectInvocation(root, policy) {
  validateInvocationPolicy(policy);
  if (policy !== USER_ONLY_INVOCATION) return inspectInvocation(root);

  const skillPath = path.join(root, 'SKILL.md');
  const skillContent = await readFile(skillPath, 'utf8');
  const { fields, remainder } = parseSkillDocument(skillContent, skillPath);
  fields['disable-model-invocation'] = true;
  await writeFile(skillPath, `---\n${YAML.stringify(fields).trimEnd()}\n---\n${remainder}`);

  const codexPath = path.join(root, 'agents', 'openai.yaml');
  const codex = await readYamlObject(codexPath, { allowMissing: true });
  const currentPolicy = plainObject(codex.policy) ? codex.policy : {};
  codex.policy = { ...currentPolicy, allow_implicit_invocation: false };
  await mkdir(path.dirname(codexPath), { recursive: true });
  await writeFile(codexPath, YAML.stringify(codex));

  return inspectInvocation(root);
}

function parseSkillDocument(content, candidate) {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!match) throw invocationError('skill-frontmatter-missing', `SKILL.md has no YAML frontmatter: ${candidate}`);
  const fields = parseYamlObject(match[1], candidate);
  return { fields, remainder: content.slice(match[0].length) };
}

async function readSkillInvocation(candidate) {
  const content = await readFile(candidate, 'utf8');
  const { fields } = parseSkillDocument(content, candidate);
  return booleanOrNull(fields['disable-model-invocation']);
}

async function readCodexInvocation(candidate) {
  const value = await readYamlObject(candidate, { allowMissing: true });
  return booleanOrNull(plainObject(value.policy) ? value.policy.allow_implicit_invocation : undefined);
}

async function readYamlObject(candidate, { allowMissing = false } = {}) {
  let content;
  try {
    content = await readFile(candidate, 'utf8');
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return {};
    throw error;
  }
  return parseYamlObject(content, candidate);
}

function parseYamlObject(content, candidate) {
  let document;
  try {
    document = YAML.parseDocument(content, { schema: 'core', uniqueKeys: true });
  } catch {
    throw invocationError('invocation-metadata-invalid', `Invocation metadata is invalid YAML: ${candidate}`);
  }
  if (document.errors.length > 0) {
    throw invocationError('invocation-metadata-invalid', `Invocation metadata is invalid YAML: ${candidate}`);
  }
  const value = document.toJS();
  if (!plainObject(value)) {
    throw invocationError('invocation-metadata-invalid', `Invocation metadata must be a YAML mapping: ${candidate}`);
  }
  return value;
}

function classify({ disableModelInvocation, allowImplicitInvocation }) {
  if (disableModelInvocation === true && allowImplicitInvocation === false) return 'user-only';
  if ((disableModelInvocation === true && allowImplicitInvocation === null)
    || (disableModelInvocation === null && allowImplicitInvocation === false)) return 'one-sided-user-only';
  if ((disableModelInvocation === true && allowImplicitInvocation === true)
    || (disableModelInvocation === false && allowImplicitInvocation === false)) return 'conflicting';
  if (disableModelInvocation === false && allowImplicitInvocation === true) return 'model-allowed';
  return 'unspecified';
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invocationError(code, message) {
  return Object.assign(new Error(message), { code, disposition: 'invalid' });
}

async function invocationValue(read, candidate, findings) {
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT') findings.push({ code: error.code ?? 'invocation-metadata-unreadable', path: candidate });
    return null;
  }
}
