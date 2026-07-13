import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = path.join(root, 'skills', 'caddie');

test('the skill repository keeps source under skills/ and reserves .agents for installations', async () => {
  await access(path.join(skillRoot, 'SKILL.md'));
  await assert.rejects(access(path.join(root, '.agents')));
});

test('the Caddie skill carries its runtime references and parser inside its own folder', async () => {
  const instructions = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.doesNotMatch(instructions, /CONTEXT\.md|\.\.\//);
  assert.match(instructions, /references\/domain\.md/);
  assert.match(instructions, /license: LICENSE\.txt/);
  await access(path.join(skillRoot, 'LICENSE.txt'));
  await access(path.join(skillRoot, 'references', 'domain.md'));
  await access(path.join(skillRoot, 'tool', 'vendor', 'yaml.cjs'));
  await access(path.join(skillRoot, 'tool', 'vendor', 'YAML-LICENSE.txt'));
});
