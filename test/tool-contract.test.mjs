import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

test('returns exactly one versioned JSON envelope for locate without making writes', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-locate-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const configHome = path.join(fixture, 'config');
  await mkdir(project, { recursive: true });
  const before = await tree(fixture);

  const result = invoke({ version: 1, operation: 'locate', input: { cwd: project, home, configHome } });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    ok: true,
    operation: 'locate',
    result: {
      user: { root: home, manifestPath: path.join(home, '.agents', '.caddie', 'manifest.json'), status: 'missing' },
      project: { root: project, manifestPath: null, status: 'missing' },
      registry: {
        status: 'missing',
        registryPath: path.join(home, '.agents', '.caddie', 'registry.json'),
        registeredProjects: [],
      },
      legacy: { configPath: path.join(configHome, 'caddie', 'config.json'), status: 'missing' },
    },
    coverage: {
      status: 'partial',
      issues: [
        { scope: 'user', code: 'manifest-missing', path: path.join(home, '.agents', '.caddie', 'manifest.json') },
        { scope: 'project', code: 'manifest-missing', path: null },
      ],
    },
  });
  assert.deepEqual(await tree(fixture), before);
});

test('inspect composes User Skills and Project Skills and reads names from SKILL.md', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-inspect-'));
  const user = path.join(fixture, 'user');
  const project = path.join(fixture, 'project');
  const userSource = path.join(user, 'sources');
  const projectSource = path.join(project, 'skill-source');
  await skill(path.join(userSource, 'shared-helper'), 'shared-helper');
  await skill(path.join(projectSource, 'project-helper'), 'project-helper');
  await mkdir(project, { recursive: true });
  const userManifest = path.join(user, '.agents', '.caddie', 'manifest.json');
  const projectManifest = path.join(project, '.agents', '.caddie', 'manifest.json');
  await json(userManifest, {
    manifestVersion: 1,
    scope: 'user',
    sources: { authored: { type: 'local', path: './sources' } },
    skills: [{ source: 'authored', path: 'shared-helper' }],
  });
  await json(projectManifest, {
    version: 1,
    scope: 'project',
    sources: [{ name: 'project', type: 'local', path: './skill-source' }],
    selections: [{ source: 'project', path: 'project-helper' }],
  });
  const before = await tree(fixture);

  const result = invoke({
    version: 1,
    operation: 'inspect',
    input: { cwd: project, home: user },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.coverage.status, 'complete');
  assert.deepEqual(envelope.result.availableSkills.map(({ name, scope }) => ({ name, scope })), [
    { name: 'shared-helper', scope: 'user' },
    { name: 'project-helper', scope: 'project' },
  ]);
  assert.equal(envelope.result.scopes.user.manifestVersion, 1);
  assert.equal(envelope.result.scopes.project.manifestVersion, 1);
  assert.deepEqual(await tree(fixture), before);
});

test('inspect lets a project skill shadow a same-named user skill with explicit evidence', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-collision-'));
  const user = path.join(fixture, 'user');
  const project = path.join(fixture, 'project');
  await skill(path.join(user, 'source', 'same-name'), 'same-name');
  await skill(path.join(project, 'source', 'same-name'), 'same-name');
  const userManifest = path.join(user, '.agents', '.caddie', 'manifest.json');
  await json(userManifest, manifest('user', './source', 'same-name'));
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), manifest('project', './source', 'same-name'));

  const result = invoke({ version: 1, operation: 'inspect', input: { cwd: project, home: user } });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.result.availableSkills.map(({ name, scope }) => ({ name, scope })), [
    { name: 'same-name', scope: 'project' },
  ]);
  assert.deepEqual(envelope.result.shadowedSkills.map(({ name, selected, shadowed }) => ({
    name,
    selected: selected.scope,
    shadowed: shadowed.scope,
  })), [{ name: 'same-name', selected: 'project', shadowed: 'user' }]);
  assert.equal(envelope.result.scopes.user.skills[0].name, 'same-name');
  assert.equal(envelope.result.scopes.project.skills[0].name, 'same-name');
});

test('unsupported manifests are bounded partial evidence and unsupported protocol versions are invalid', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-version-'));
  const project = path.join(fixture, 'project');
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), { manifestVersion: 2, scope: 'project', sources: {}, skills: [] });

  const manifestResult = invoke({ version: 1, operation: 'inspect', input: { cwd: project, home: path.join(fixture, 'home') } });
  assert.equal(manifestResult.status, 0);
  assert.equal(JSON.parse(manifestResult.stdout).result.scopes.project.status, 'unsupported');
  assert.equal(JSON.parse(manifestResult.stdout).coverage.issues[1].code, 'unsupported-manifest-version');

  const protocolResult = invoke({ version: 99, operation: 'locate', input: {} });
  assert.equal(JSON.parse(protocolResult.stdout).error.code, 'unsupported-protocol-version');
  assert.equal(protocolResult.stdout.trim().split('\n').length, 1);
});

test('invalid input and selections cannot contaminate stdout or escape a source', async () => {
  const malformed = spawnSync(process.execPath, [tool], { cwd: repositoryRoot, input: '{no', encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stderr, '');
  assert.equal(JSON.parse(malformed.stdout).error.code, 'invalid-json');

  const fixture = await mkdtemp(path.join(tmpdir(), 'caddie-escape-'));
  const project = path.join(fixture, 'project');
  await skill(path.join(fixture, 'outside'), 'outside');
  await json(path.join(project, '.agents', '.caddie', 'manifest.json'), manifest('project', './source', '../../outside'));
  const escaped = invoke({ version: 1, operation: 'inspect', input: { cwd: project, home: path.join(fixture, 'home') } });
  assert.equal(JSON.parse(escaped.stdout).error.code, 'selection-outside-source');
});

function invoke(request) {
  return spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
}

function manifest(scope, sourcePath, selectionPath) {
  return {
    manifestVersion: 1,
    scope,
    sources: { local: { type: 'local', path: sourcePath } },
    skills: [{ source: 'local', path: selectionPath }],
  };
}

async function skill(directory, name) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nUntrusted fixture content.\n`);
  await writeFile(path.join(directory, 'asset.txt'), 'complete directory evidence\n');
}

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function tree(root) {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) {
        result.push(`${relative}/`);
        await visit(path.join(directory, entry.name), relative);
      } else {
        result.push(`${relative}:${await readFile(path.join(directory, entry.name), 'utf8')}`);
      }
    }
  }
  await visit(root);
  return result;
}
