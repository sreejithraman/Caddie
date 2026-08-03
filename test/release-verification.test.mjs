import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTOMATED_CHECKS,
  HUMAN_CHECK_IDS,
  REPOSITORY_ROOT,
  collectMacDraft,
  repositorySnapshot,
  runPublicCheck,
  templateRecord,
  validateRecord,
} from '../scripts/release-verification.mjs';

const templatePath = 'packaging/verification/record.template.json';
const structureSchemaPath = 'packaging/verification/record.structure.schema.json';

test('the checked-in draft schema and template cannot claim release or live proof', async () => {
  const schema = JSON.parse(await readFile(structureSchemaPath, 'utf8'));
  const checkedIn = JSON.parse(await readFile(templatePath, 'utf8'));

  assert.match(schema.title, /Structural Schema/);
  assert.match(schema.description, /does not validate proof/i);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.recordStatus.const, 'draft');
  assert.equal(schema.properties.qualification.properties.liveUserReconciliationEligible.const, false);
  assert.equal(schema.properties.release.properties.signedArtifactSHA256.type, 'null');
  assert.deepEqual(validateRecord(checkedIn), checkedIn);
  assert.deepEqual(checkedIn, templateRecord());
  assert.equal(checkedIn.checks.length, AUTOMATED_CHECKS.length + HUMAN_CHECK_IDS.length);
  assert.equal(checkedIn.checks.filter(({ kind, status }) => kind === 'human' && status === 'not-run').length, HUMAN_CHECK_IDS.length);
});

test('the macOS collector stores fixed public facts and outcomes without command output', async () => {
  const called = [];
  const record = await collectMacDraft({
    facts: {
      generatedAt: '2026-08-03T20:00:00.000Z',
      generatedBy: 'local-macos',
      workflowRunURL: null,
      source: { commit: 'a'.repeat(40), clean: true },
      environment: { platform: 'macos', architecture: 'arm64', macOSVersion: '15.6', nodeVersion: '22.22.0', swiftVersion: '6.3.3' },
    },
    commandRunner(check) {
      called.push(check.id);
      return check.id === 'swift-package-tests' ? 'command-failed' : 'passed';
    },
    repositoryInspector: () => ({ commit: 'a'.repeat(40), clean: true }),
  });

  assert.deepEqual(called, AUTOMATED_CHECKS.map(({ id }) => id));
  assert.equal(record.qualification.liveUserReconciliationEligible, false);
  assert.deepEqual(record.qualification.blockers, [
    'automated-check-failed', 'signed-release-not-supplied', 'human-proof-not-run',
  ]);
  assert.equal(record.checks.find(({ id }) => id === 'swift-package-tests').status, 'failed');
  assert.ok(record.checks.filter(({ kind }) => kind === 'human').every(({ status }) => status === 'not-run'));
  const serialized = JSON.stringify(record);
  for (const forbidden of ['/Users/', '/home/', '/private/', 'secret-value', 'command output']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replaceAll('/', '\\/')));
  }
});

test('repository inspection stays anchored to the verifier repository', () => {
  const calls = [];
  const result = repositorySnapshot(undefined, (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { status: 0, stdout: `${REPOSITORY_ROOT}\n` };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (args[0] === 'ls-files') return { status: 0, stdout: 'H tracked.txt\n' };
    return { status: 0, stdout: '' };
  });

  assert.deepEqual(result, { commit: 'a'.repeat(40), clean: true });
  assert.ok(calls.every(({ options }) => options.cwd === REPOSITORY_ROOT));
});

test('repository inspection rejects assume-unchanged and skip-worktree entries', async (t) => {
  const repository = await mkdtemp(path.join(tmpdir(), 'caddie-verification-git-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(git('init').status, 0);
  assert.equal(git('config', 'user.email', 'verification@example.invalid').status, 0);
  assert.equal(git('config', 'user.name', 'Verification Test').status, 0);
  await writeFile(path.join(repository, 'tracked.txt'), 'first\n');
  assert.equal(git('add', 'tracked.txt').status, 0);
  assert.equal(git('commit', '-m', 'fixture').status, 0);

  assert.equal(git('update-index', '--assume-unchanged', 'tracked.txt').status, 0);
  assert.throws(() => repositorySnapshot(repository), /hidden Git index flags/);
  assert.equal(git('update-index', '--no-assume-unchanged', 'tracked.txt').status, 0);
  assert.equal(git('update-index', '--skip-worktree', 'tracked.txt').status, 0);
  assert.throws(() => repositorySnapshot(repository), /hidden Git index flags/);
});

test('the collector rejects source mutation after automated checks', async () => {
  await assert.rejects(() => collectMacDraft({
    facts: {
      generatedAt: '2026-08-03T20:00:00.000Z',
      generatedBy: 'local-macos',
      workflowRunURL: null,
      source: { commit: 'a'.repeat(40), clean: true },
      environment: { platform: 'macos', architecture: 'arm64', macOSVersion: '15.6', nodeVersion: '22.22.0', swiftVersion: '6.3.3' },
    },
    commandRunner: () => 'passed',
    repositoryInspector: () => ({ commit: 'a'.repeat(40), clean: false }),
  }), /source changed during automated checks/);
});

test('public checks use the repository root and report a fixed timeout reason', async () => {
  let observed;
  const fakeChild = (code) => {
    const child = new EventEmitter();
    child.pid = 12345;
    child.kill = () => {};
    queueMicrotask(() => child.emit('exit', code));
    return child;
  };
  const passed = await runPublicCheck(AUTOMATED_CHECKS[0], (...args) => {
    observed = args;
    return fakeChild(0);
  });
  assert.equal(passed, 'passed');
  assert.equal(observed[2].cwd, REPOSITORY_ROOT);
  assert.equal(observed[2].detached, true);

  const failed = await runPublicCheck(AUTOMATED_CHECKS[0], () => fakeChild(1));
  assert.equal(failed, 'command-failed');
});

test('a timed-out public check kills its full process group', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'caddie-verification-timeout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sentinel = path.join(directory, 'survived.txt');
  const childProgram = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 300)`;
  const parentProgram = `require('node:child_process').spawn(process.execPath, ['--eval', ${JSON.stringify(childProgram)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  const startedAt = Date.now();
  const result = await runPublicCheck({
    id: 'process-tree-fixture',
    executable: process.execPath,
    arguments: ['--eval', parentProgram],
    timeoutMs: 100,
  });
  assert.equal(result, 'command-timed-out');
  assert.ok(Date.now() - startedAt < 1_000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(() => access(sentinel));
});

test('the file validator rejects duplicate keys at every object depth', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'caddie-verification-record-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = await readFile(templatePath, 'utf8');
  const cases = [
    raw.replace('  "recordVersion": 1,', '  "recordVersion": 1,\n  "recordVersion": 1,'),
    raw.replace('    "liveUserReconciliationEligible": false,', '    "liveUserReconciliationEligible": false,\n    "liveUserReconciliationEligible": false,'),
    raw.replace('{ "id": "repository-node-tests",', '{ "id": "repository-node-tests", "id": "repository-node-tests",'),
  ];

  for (const [index, duplicate] of cases.entries()) {
    assert.doesNotThrow(() => JSON.parse(duplicate));
    const recordPath = path.join(directory, `duplicate-${index}.json`);
    await writeFile(recordPath, duplicate);
    const checked = spawnSync(process.execPath, ['scripts/release-verification.mjs', 'validate', recordPath], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    });
    assert.equal(checked.status, 2);
    assert.equal(checked.stderr, 'record has duplicate JSON object keys\n');
  }
});

test('the validator rejects attempts to turn draft evidence into release proof', () => {
  const cases = [];

  const unknown = templateRecord();
  unknown.localPath = '/Users/example/Caddie';
  cases.push(unknown);

  const eligible = templateRecord();
  eligible.qualification.liveUserReconciliationEligible = true;
  cases.push(eligible);

  const signed = templateRecord();
  signed.release.signedArtifactSHA256 = 'a'.repeat(64);
  cases.push(signed);

  const humanClaim = templateRecord();
  humanClaim.checks.find(({ kind }) => kind === 'human').status = 'passed';
  cases.push(humanClaim);

  const changedCommand = templateRecord();
  changedCommand.checks[0].command = 'npm test -- --output /private/result';
  cases.push(changedCommand);

  for (const record of cases) assert.throws(() => validateRecord(record));
});

test('the macOS draft workflow has read-only access and does not run human or signing work', async () => {
  const workflow = await readFile('.github/workflows/macos-verification-draft.yml', 'utf8');
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /runs-on: macos-/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /npm run verify:mac -- --output release-verification\.json --github-actions/);
  assert.match(workflow, /npm run verify:record -- release-verification\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /secrets\.|codesign|notarytool|stapler|generate_appcast|brew install|test:release/);
});

test('the standard test suite never starts installed Agent Harnesses', async () => {
  const harness = await readFile('test/claude-harness.test.cjs', 'utf8');
  assert.match(harness, /CADDIE_REQUIRE_CLAUDE !== '1'/);
  assert.match(harness, /CADDIE_REQUIRE_CODEX !== '1'/);
  assert.match(harness, /t\.skip\('Claude Code runs only in the release gate'\)/);
  assert.match(harness, /t\.skip\('Codex runs only in the release gate'\)/);
});
