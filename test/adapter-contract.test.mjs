import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInProcessAdapter } from '../skills/caddie/tool/src/adapter/in-process.mjs';
import {
  ChildProcessAdapterError,
  createChildProcessAdapter,
  OPERATION_LIMITS_MS,
  RETRY_DELAY_MS,
  STOP_GRACE_MS,
} from '../skills/caddie/tool/src/adapter/child-process.mjs';
import { TOOL_COMPATIBILITY } from '../skills/caddie/tool/src/adapter/compatibility.mjs';
import { readManagementState } from '../skills/caddie/tool/src/management/formats.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(repositoryRoot, 'bin', 'caddie-tool.mjs');

for (const [name, makeAdapter] of [
  ['in-process', async (home) => createInProcessAdapter({ managementOptions: { home } })],
  ['child-process', async (home) => createChildProcessAdapter({
    command: process.execPath,
    args: [tool],
    cwd: repositoryRoot,
    env: { ...process.env, HOME: home },
  })],
]) {
  test(`${name} Adapter serves the version 2 status, cycle, and act contract`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), `caddie-${name}-contract-`));
    const stateRoot = path.join(home, '.agents', '.caddie');
    await writeJson(path.join(stateRoot, 'manifest.json'), {
      version: 1, scope: 'user', sources: {}, selections: [],
    });
    await writeJson(path.join(stateRoot, 'lock.json'), { version: 1, sources: {} });
    await writeJson(path.join(stateRoot, 'ledger.json'), {
      version: 1, scopeId: 'user', entries: [], harnessLinks: [], harnessSettings: [],
    });
    const adapter = await makeAdapter(home);

    const status = await adapter.execute(request('status', {}, `${name}-status`));
    assert.equal(status.ok, true);
    assert.equal(status.result.snapshot.state, 'uninitialized');

    const cycle = await adapter.execute(request('cycle', {
      idempotencyId: `${name}-cycle-id`, mode: 'observe-only', hint: { kind: 'manual' }, subjectIds: [],
    }, `${name}-cycle`));
    assert.equal(cycle.ok, true);
    assert.equal(cycle.result.snapshot.state, 'ready');

    const actRequest = request('act', {
      idempotencyId: `${name}-act-id`, form: 'request', intent: { type: 'resume-reconciliation' },
    }, `${name}-act`);
    const acted = await adapter.execute(actRequest);
    const replayed = await adapter.execute(actRequest);
    assert.equal(acted.ok, true);
    assert.deepEqual(replayed, acted);
    assert.equal(acted.result.snapshot.pendingActions[0].intent.type, 'resume-reconciliation');
  });
}

test('current v2 and every prior v1 Skill operation enter through the Tool management owner', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-version-pair-'));
  const current = invokeTool({ version: 2, requestId: 'current', caller: 'skill', operation: 'status', input: {} }, home);
  const priorLocate = invokeTool({ version: 1, operation: 'locate', input: { cwd: home, home } }, home);
  const known = new Set(['locate', 'inspect', 'inspect-source', 'compare', 'plan', 'apply-plan', 'recover']);

  assert.equal(current.status, 0, current.stderr);
  assert.equal(priorLocate.status, 0, priorLocate.stderr);
  assert.equal(JSON.parse(current.stdout).version, 2);
  assert.equal(JSON.parse(priorLocate.stdout).version, 1);
  assert.equal(JSON.parse(priorLocate.stdout).operation, 'locate');
  assert.deepEqual(new Set(TOOL_COMPATIBILITY.priorProtocolBridge.operations), known);
  assert.equal(TOOL_COMPATIBILITY.priorProtocolBridge.lastToolProtocolVersion, 2);
  assert.equal(TOOL_COMPATIBILITY.priorProtocolBridge.removeWhenToolProtocolVersionReaches, 3);
});

test('malformed v2 requests have the same error through in-process and child-process Adapters', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-malformed-pair-'));
  const requestValue = { version: 2, operation: 'status', input: {} };
  const inProcess = createInProcessAdapter({ managementOptions: { home } });
  const child = createChildProcessAdapter({
    command: process.execPath, args: [tool], cwd: repositoryRoot, env: { ...process.env, HOME: home },
  });
  assert.deepEqual(await child.execute(requestValue), await inProcess.execute(requestValue));
});

for (const [name, requestValue] of [
  ['missing protocol version', { operation: 'locate', input: {} }],
  ['unsupported protocol version', { version: 99, operation: 'locate', input: {} }],
]) {
  test(`${name} has the same Tool error through in-process and child-process Adapters`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'caddie-version-error-pair-'));
    const inProcess = createInProcessAdapter({ managementOptions: { home } });
    const child = createChildProcessAdapter({
      command: process.execPath, args: [tool], cwd: repositoryRoot, env: { ...process.env, HOME: home },
    });
    const expected = await inProcess.execute(requestValue);
    assert.equal(expected.version, 1);
    assert.equal(expected.ok, false);
    assert.equal(expected.error.code, 'unsupported-protocol-version');
    assert.deepEqual(await child.execute(requestValue), expected);
  });
}

test('unknown v2 operations reach the management validation path', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-unknown-v2-'));
  const adapter = createChildProcessAdapter({
    command: process.execPath, args: [tool], cwd: repositoryRoot, env: { ...process.env, HOME: home },
  });
  const response = await adapter.execute({ version: 2, requestId: 'unknown', caller: 'app', operation: 'unknown', input: {} });
  assert.equal(response.version, 2);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unsupported-operation');
});

test('the protocol 1 lane rejects unknown requests, plan kinds, extensions, and raw Harness writes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-lane-'));
  const cases = [
    [{ version: 1, operation: 'future-operation', input: {} }, 'unsupported-operation'],
    [{ version: 1, operation: 'plan', input: { kind: 'future-kind', operations: [] } }, 'unsupported-legacy-plan-kind'],
    [{
      version: 1, operation: 'plan', input: {
        kind: 'reconcile', operations: [{ type: 'future-operation' }],
      },
    }, 'unsupported-legacy-operation-kind'],
    [{
      version: 1, operation: 'plan', input: {
        kind: 'reconcile', operations: [{ type: 'write-harness-settings' }],
      },
    }, 'internal-plan-field'],
    [{ version: 1, operation: 'locate', input: {}, extension: true }, 'legacy-request-extension'],
  ];
  for (const [requestValue, expectedCode] of cases) {
    const result = invokeTool(requestValue, home);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, expectedCode);
  }
});

test('the protocol 1 lane rejects an extra plan input field before planning', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-input-field-'));
  const result = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      kind: 'reconcile',
      scope: { id: 'user', root: home },
      operations: [],
      futureField: true,
    },
  }, home);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-input-field');
});

test('the protocol 1 lane rejects an extra raw operation field before planning', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-operation-field-'));
  const result = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      kind: 'reconcile',
      scope: { id: 'user', root: home },
      operations: [{
        type: 'write-ledger',
        path: path.join(home, '.agents', '.caddie', 'ledger.json'),
        content: '{"version":1,"entries":[]}\n',
        expected: { state: 'absent' },
        futureField: true,
      }],
    },
  }, home);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-operation-field');
});

test('the protocol 1 lane rejects extra nested scope and expected fields', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-nested-field-'));
  const scopeResult = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      kind: 'reconcile',
      scope: { id: 'user', root: home, futureField: true },
      operations: [],
    },
  }, home);
  assert.equal(scopeResult.status, 1);
  assert.equal(JSON.parse(scopeResult.stdout).error.code, 'legacy-plan-input-field');

  const expectedResult = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      kind: 'reconcile',
      scope: { id: 'user', root: home },
      operations: [{
        type: 'write-ledger',
        path: path.join(home, '.agents', '.caddie', 'ledger.json'),
        content: '{"version":1,"entries":[]}\n',
        expected: { state: 'absent', futureField: true },
      }],
    },
  }, home);
  assert.equal(expectedResult.status, 1);
  assert.equal(JSON.parse(expectedResult.stdout).error.code, 'legacy-plan-operation-field');
});

test('the protocol 1 lane rejects an Adoption candidate extension', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-candidate-field-'));
  const result = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      workflow: 'adoption',
      scopeRoot: home,
      scope: { id: 'user', root: home },
      candidates: [{ name: 'fixture', sourcePath: home, futureField: true }],
    },
  }, home);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-input-field');
});

test('the protocol 1 lane rejects a Skill Enablement selection extension', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-selection-field-'));
  const result = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      workflow: 'skill-enablement',
      scope: { id: 'user', root: home },
      selection: { source: 'authored', path: 'fixture', futureField: true },
      enabled: false,
    },
  }, home);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-input-field');
});

test('the protocol 1 lane rejects Adoption Ledger extensions at every object level', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-ledger-field-'));
  const base = {
    version: 1,
    operation: 'plan',
    input: {
      workflow: 'adoption',
      scopeRoot: home,
      scope: { id: 'user', root: home },
      candidates: [],
    },
  };
  const ledgers = [
    { version: 1, entries: [], futureField: true },
    { version: 1, entries: [{ name: 'fixture', path: home, fingerprint: 'digest', futureField: true }] },
    {
      version: 1,
      entries: [],
      harnessSettings: [{
        harness: 'claude', skill: 'fixture', settingsPath: home, key: 'fixture', value: 'off', futureField: true,
      }],
    },
  ];
  for (const ledger of ledgers) {
    const result = invokeTool({ ...base, input: { ...base.input, ledger } }, home);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-input-field');
  }
});

test('the protocol 1 lane accepts the frozen Adoption finding field', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-proposal-finding-'));
  const result = invokeTool({
    version: 1,
    operation: 'plan',
    input: {
      workflow: 'adoption',
      scopeRoot: home,
      scope: { id: 'user', root: home },
      candidates: [],
      proposal: {
        entries: [{
          name: 'fixture',
          installedPath: path.join(home, '.agents', 'skills', 'fixture'),
          classification: 'invalid-skill',
          preselected: false,
          preserved: true,
          findings: [{ code: 'skill-name-invalid', field: 'name' }],
        }],
        legacy: { present: false },
        mutationsPerformed: false,
      },
    },
  }, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('the protocol 1 lane rejects every nested Adoption proposal evidence extension', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-legacy-proposal-evidence-'));
  const fingerprint = () => ({
    algorithm: 'sha256-tree-v1', digest: 'digest', complete: true,
    fileCount: 0, byteCount: 0, findings: [],
  });
  const proposal = () => ({
    scopeRoot: home,
    entries: [{
      name: 'fixture', installedPath: home, classification: 'exact', preselected: true, preserved: true,
      findings: [], legacyEvidence: null, extensionFields: [],
      installedFingerprint: fingerprint(), sourceFingerprint: fingerprint(),
      sourceId: 'authored', selectedPath: 'fixture',
    }],
    legacy: { present: false, fingerprint: fingerprint(), evidenceOnly: true, removalRecommended: false },
    mutationsPerformed: false,
  });
  const cases = [
    (value) => { value.entries[0].installedFingerprint.futureField = true; },
    (value) => { value.entries[0].installedFingerprint.findings.push({ code: 'missing-path', path: '.', operation: 'fingerprint', futureField: true }); },
    (value) => { value.entries[0].sourceFingerprint.futureField = true; },
    (value) => { value.entries[0].sourceFingerprint.findings.push({ code: 'missing-path', path: '.', operation: 'fingerprint', futureField: true }); },
    (value) => { value.legacy.fingerprint.futureField = true; },
    (value) => { value.legacy.fingerprint.findings.push({ code: 'missing-path', path: '.', operation: 'fingerprint', futureField: true }); },
    (value) => { value.entries[0].findings.push({ code: 'skill-name-invalid', field: 'name', futureField: true }); },
    (value) => {
      value.entries[0].legacyEvidence = {
        source: 'source', sourceType: 'github', sourceUrl: 'https://example.test/source',
        skillPath: 'skills/fixture', skillFolderHash: 'digest', futureField: true,
      };
    },
  ];
  for (const extend of cases) {
    const value = proposal();
    extend(value);
    const result = invokeTool({
      version: 1,
      operation: 'plan',
      input: {
        workflow: 'adoption', scopeRoot: home, scope: { id: 'user', root: home },
        candidates: [], proposal: value,
      },
    }, home);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'legacy-plan-input-field');
  }
});

test('Tool stdin rejects invalid JSON with one JSON response and no stdout diagnostics', async () => {
  const result = spawnSync(process.execPath, [tool], { cwd: repositoryRoot, input: '{partial', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'invalid-json');
});

test('child-process Adapter keeps the operation limits and stop timings fixed by the Interface', () => {
  assert.deepEqual(OPERATION_LIMITS_MS, { status: 5_000, cycle: 120_000, act: 5_000 });
  assert.equal(STOP_GRACE_MS, 10_000);
  assert.equal(RETRY_DELAY_MS, 10_000);
});

for (const fault of [
  { name: 'invalid JSON', body: `process.stdout.write('not-json');`, code: 'child-invalid-json' },
  { name: 'partial output', body: `process.stdout.write('{"ok":');`, code: 'child-invalid-json' },
  { name: 'empty output', body: '', code: 'child-incomplete-output' },
]) {
  test(`child-process Adapter reports ${fault.name} with bounded process facts`, async () => {
    const helper = await helperScript(fault.body);
    const adapter = createChildProcessAdapter({ command: process.execPath, args: [helper] });
    await assert.rejects(adapter.execute(request('status', {}, 'fault')), (error) => {
      assert.equal(error instanceof ChildProcessAdapterError, true);
      assert.equal(error.code, fault.code);
      assert.equal(Object.hasOwn(error.details, 'stderr'), true);
      return true;
    });
  });
}

test('child-process Adapter rejects a nonzero exit paired with a success envelope', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-nonzero-envelope-'));
  const response = await createInProcessAdapter({ managementOptions: { home } }).execute(request('status', {}, 'nonzero'));
  const helper = await helperScript(`process.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exitCode = 7;`);
  const adapter = createChildProcessAdapter({ command: process.execPath, args: [helper] });
  await assert.rejects(adapter.execute(request('status', {}, 'nonzero')), { code: 'child-nonzero-exit' });
});

test('child-process Adapter rejects a response for another request', async () => {
  const helper = await helperScript(`
    process.stdin.resume();
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({
      version: 2, ok: true, requestId: 'wrong', operation: 'status', result: { snapshot: {} },
    })));
  `);
  const adapter = createChildProcessAdapter({ command: process.execPath, args: [helper] });
  await assert.rejects(adapter.execute(request('status', {}, 'expected')), { code: 'child-request-mismatch' });
});

test('child-process Adapter accepts diagnostics on stderr without mixing them into JSON', async () => {
  const helper = await helperScript(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stderr.write('bounded diagnostic\\n');
      process.stdout.write(JSON.stringify({
        version: 2, ok: false, requestId: 'stderr', operation: 'status',
        error: { code: 'test-fault', message: 'Test fault', disposition: 'bug' },
      }));
    });
  `);
  const adapter = createChildProcessAdapter({ command: process.execPath, args: [helper] });
  const response = await adapter.execute(request('status', {}, 'stderr'));
  assert.equal(response.ok, false);
  assert.equal(response.requestId, 'stderr');
});

for (const streamName of ['stdout', 'stderr']) {
  test(`child-process Adapter bounds ${streamName} while streaming and stops the child`, async () => {
    let child;
    const adapter = createChildProcessAdapter({
      command: 'injected-overflow-child',
      spawn: () => { child = overflowChild(streamName); return child; },
      maxStdoutBytes: 16,
      maxStderrBytes: 16,
    });
    await assert.rejects(adapter.execute(request('status', {}, 'overflow')), {
      code: `child-${streamName}-overflow`,
    });
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
  });
}

test('child-process Adapter handles async stdin failure, stops the child, and cleans listeners', async () => {
  const child = inputFailureChild();
  const adapter = createChildProcessAdapter({ command: 'injected-input-child', spawn: () => child });
  await assert.rejects(adapter.execute(request('status', {}, 'input-fault')), {
    code: 'child-input-failed',
  });
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.stdin.listenerCount('error'), 0);
  assert.equal(child.listenerCount('close'), 0);
});

test('child-process Adapter deeply rejects malformed success and error envelopes', async () => {
  const cases = [
    {
      response: { version: 2, ok: true, requestId: 'deep', operation: 'status', result: { snapshot: {} } },
      code: 'child-invalid-response',
    },
    {
      response: {
        version: 2, ok: false, requestId: 'deep', operation: 'status',
        error: { code: 'bad', message: 'Bad', disposition: 'invented' },
      },
      code: 'child-invalid-response',
    },
  ];
  for (const candidate of cases) {
    const helper = await helperScript(`process.stdout.write(${JSON.stringify(JSON.stringify(candidate.response))});`);
    const adapter = createChildProcessAdapter({ command: process.execPath, args: [helper] });
    await assert.rejects(adapter.execute(request('status', {}, 'deep')), { code: candidate.code });
  }
});

test('child-process Adapter asks a timed-out child to stop, waits, forces stop, and retries once', async () => {
  const helper = await helperScript(`
    process.on('SIGTERM', () => {});
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  const delays = [];
  const adapter = createChildProcessAdapter({
    command: process.execPath,
    args: [helper],
    limits: { status: 100 },
    stopGraceMs: 20,
    retryDelayMs: 10_000,
    delay: async (ms) => { delays.push(ms); },
  });
  await assert.rejects(adapter.execute(request('status', {}, 'timeout')), (error) => {
    assert.equal(error.code, 'child-timeout');
    assert.equal(error.details.forcedStop, true);
    return true;
  });
  assert.deepEqual(delays, [10_000]);
});

test('child-process Adapter retries a timeout once and returns the second complete response', async () => {
  let attempts = 0;
  const adapter = createChildProcessAdapter({
    command: 'injected-test-child',
    spawn: () => fakeChild(++attempts),
    setTimer: immediateTimer,
    clearTimer: (timer) => { timer.cancelled = true; },
    delay: async () => {},
  });
  const response = await adapter.execute(request('status', {}, 'retry'));
  assert.equal(response.ok, false);
  assert.equal(response.requestId, 'retry');
  assert.equal(attempts, 2);
});

test('a real timed-out act retry reuses its durable management receipt without a second effect', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'caddie-durable-retry-'));
  const stateRoot = path.join(home, '.agents', '.caddie');
  await mkdir(stateRoot, { recursive: true });
  const attemptPath = path.join(home, 'attempt');
  const managementUrl = pathToFileURL(path.join(repositoryRoot, 'skills', 'caddie', 'tool', 'src', 'management', 'index.mjs')).href;
  const helper = await helperScript(`
    import { readFile, writeFile } from 'node:fs/promises';
    import { createManagementModule } from ${JSON.stringify(managementUrl)};
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = await createManagementModule({ home: ${JSON.stringify(home)} }).execute(request);
    let prior = false;
    try { prior = (await readFile(${JSON.stringify(attemptPath)}, 'utf8')) === 'done'; } catch {}
    if (!prior) {
      await writeFile(${JSON.stringify(attemptPath)}, 'done');
      setInterval(() => {}, 1000);
    } else {
      process.stdout.write(JSON.stringify(result));
    }
  `);
  const delays = [];
  const adapter = createChildProcessAdapter({
    command: process.execPath,
    args: [helper],
    limits: { act: 800 },
    delay: async (ms) => { delays.push(ms); },
  });
  const act = request('act', {
    idempotencyId: 'durable-retry-id', form: 'request', intent: { type: 'resume-reconciliation' },
  }, 'durable-retry-request');
  const response = await adapter.execute(act);
  const state = await readManagementState(path.join(stateRoot, 'management-v2.json'));
  assert.equal(response.ok, true);
  assert.deepEqual(delays, [10_000]);
  assert.equal(state.receipts.filter((item) => item.id === 'durable-retry-id').length, 1);
  assert.equal(state.pendingActions.filter((item) => item.intent.type === 'resume-reconciliation').length, 1);
});

function request(operation, input, requestId) {
  return { version: 2, requestId, caller: 'app', operation, input };
}

function invokeTool(requestValue, home) {
  return spawnSync(process.execPath, [tool], {
    cwd: repositoryRoot,
    input: JSON.stringify(requestValue),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

async function helperScript(body) {
  const directory = await mkdtemp(path.join(tmpdir(), 'caddie-child-helper-'));
  const file = path.join(directory, 'helper.mjs');
  await writeFile(file, body);
  return file;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fakeChild(attempt) {
  const child = new EventEmitter();
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.stdin = {
    end() {
      if (attempt !== 2) return;
      child.stdout.emit('data', JSON.stringify({
        version: 2, ok: false, requestId: 'retry', operation: 'status',
        error: { code: 'test-fault', message: 'Test fault', disposition: 'bug' },
      }));
      child.emit('close', 0, null);
    },
  };
  child.kill = (signal) => {
    if (attempt === 1 && signal === 'SIGTERM') child.emit('close', null, signal);
    return true;
  };
  return child;
}

function overflowChild(streamName) {
  const child = new EventEmitter();
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.stdin = new EventEmitter();
  child.signals = [];
  child.stdin.end = () => child[streamName].emit('data', 'x'.repeat(32));
  child.kill = (signal) => {
    child.signals.push(signal);
    child.emit('close', null, signal);
    return true;
  };
  return child;
}

function inputFailureChild() {
  const child = new EventEmitter();
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.stdin = new EventEmitter();
  child.signals = [];
  child.stdin.end = () => child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
  child.kill = (signal) => {
    child.signals.push(signal);
    child.emit('close', null, signal);
    return true;
  };
  return child;
}

function fakeStream() {
  const stream = new EventEmitter();
  stream.setEncoding = () => {};
  return stream;
}

function immediateTimer(callback) {
  const timer = { cancelled: false };
  queueMicrotask(() => { if (!timer.cancelled) callback(); });
  return timer;
}
