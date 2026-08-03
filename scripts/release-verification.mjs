#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { arch, platform } from 'node:process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import jsoncParser from 'jsonc-parser';

export const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

const ROOT_KEYS = Object.freeze([
  'schema', 'recordVersion', 'recordStatus', 'generatedAt', 'generatedBy', 'workflowRunURL',
  'source', 'environment', 'release', 'checks', 'qualification',
]);
const SOURCE_KEYS = Object.freeze(['commit', 'clean']);
const ENVIRONMENT_KEYS = Object.freeze(['platform', 'architecture', 'macOSVersion', 'nodeVersion', 'swiftVersion']);
const RELEASE_KEYS = Object.freeze([
  'releaseID', 'appVersion', 'toolVersion', 'toolFingerprint', 'nodeVersion',
  'nodeFingerprint', 'skillVersion', 'skillFingerprint', 'toolProtocolVersion',
  'supportedSkillProtocolVersions', 'minimumStateFormatVersion',
  'maximumStateFormatVersion', 'signedArtifactSHA256', 'appcastEntryURL',
]);
const CHECK_KEYS = Object.freeze(['id', 'kind', 'status', 'reason']);
const QUALIFICATION_KEYS = Object.freeze(['liveUserReconciliationEligible', 'blockers']);

export const AUTOMATED_CHECKS = Object.freeze([
  Object.freeze({
    id: 'repository-node-tests',
    executable: 'npm',
    arguments: ['test'],
    timeoutMs: 10 * 60 * 1000,
  }),
  Object.freeze({
    id: 'swift-package-tests',
    executable: 'swift',
    arguments: ['test', '--disable-sandbox', '--package-path', 'app/CaddieReleaseRuntime'],
    timeoutMs: 10 * 60 * 1000,
  }),
  Object.freeze({
    id: 'development-app-build',
    executable: 'scripts/build-caddie-menu-app.sh',
    arguments: ['--development'],
    timeoutMs: 5 * 60 * 1000,
  }),
]);

export const HUMAN_CHECK_IDS = Object.freeze([
  'installed-codex',
  'installed-claude',
  'state-fixtures',
  'prior-release-pairings',
  'fault-injection',
  'developer-id-signature',
  'hardened-runtime',
  'notarization',
  'stapling',
  'sparkle-signature',
  'sparkle-prior-update',
  'homebrew-install',
  'disk-image-install',
  'login-and-folder-access',
  'tool-fallback',
  'app-removal-reinstall',
  'observe-only-live',
  'authorized-clean-update',
  'unsafe-update-blocked',
  'notification-and-handoff',
  'macos-13',
]);

const EMPTY_RELEASE = Object.freeze({
  releaseID: null,
  appVersion: null,
  toolVersion: null,
  toolFingerprint: null,
  nodeVersion: null,
  nodeFingerprint: null,
  skillVersion: null,
  skillFingerprint: null,
  toolProtocolVersion: null,
  supportedSkillProtocolVersions: Object.freeze([]),
  minimumStateFormatVersion: null,
  maximumStateFormatVersion: null,
  signedArtifactSHA256: null,
  appcastEntryURL: null,
});

export class VerificationRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerificationRecordError';
  }
}

export function templateRecord() {
  return makeRecord({
    generatedAt: null,
    generatedBy: 'template',
    workflowRunURL: null,
    source: { commit: null, clean: null },
    environment: { platform: null, architecture: null, macOSVersion: null, nodeVersion: null, swiftVersion: null },
    automatedResults: new Map(AUTOMATED_CHECKS.map(({ id }) => [id, 'not-run'])),
  });
}

export async function collectMacDraft({ facts, commandRunner, repositoryInspector }) {
  if (facts.source.clean !== true) fail('source must be clean before automated checks');
  const automatedResults = new Map();
  for (const check of AUTOMATED_CHECKS) {
    const result = await commandRunner(check);
    oneOf(result, ['passed', 'command-failed', 'command-timed-out'], `automated check ${check.id} returned an invalid result`);
    automatedResults.set(check.id, result);
  }
  const finalSource = await repositoryInspector();
  if (finalSource.commit !== facts.source.commit || finalSource.clean !== true) {
    fail('source changed during automated checks');
  }
  const record = makeRecord({ ...facts, automatedResults });
  validateRecord(record);
  return record;
}

function makeRecord({ generatedAt, generatedBy, workflowRunURL, source, environment, automatedResults }) {
  const checks = [
    ...AUTOMATED_CHECKS.map(({ id }) => {
      const result = automatedResults.get(id);
      const status = ['command-failed', 'command-timed-out'].includes(result) ? 'failed' : result;
      return {
        id,
        kind: 'automated',
        status,
        reason: status === 'failed' ? result : status === 'not-run' ? 'template-not-run' : null,
      };
    }),
    ...HUMAN_CHECK_IDS.map((id) => ({
      id,
      kind: 'human',
      status: 'not-run',
      reason: 'human-proof-required',
    })),
  ];
  return {
    schema: 'caddie-release-verification-draft-v1',
    recordVersion: 1,
    recordStatus: 'draft',
    generatedAt,
    generatedBy,
    workflowRunURL,
    source,
    environment,
    release: structuredClone(EMPTY_RELEASE),
    checks,
    qualification: {
      liveUserReconciliationEligible: false,
      blockers: expectedBlockers({ source, checks }),
    },
  };
}

export function validateRecord(record) {
  exactObject(record, ROOT_KEYS, 'record');
  equal(record.schema, 'caddie-release-verification-draft-v1', 'schema is invalid');
  equal(record.recordVersion, 1, 'recordVersion is invalid');
  equal(record.recordStatus, 'draft', 'recordStatus must remain draft');
  oneOf(record.generatedBy, ['template', 'local-macos', 'github-actions'], 'generatedBy is invalid');

  if (record.generatedBy === 'template') {
    equal(record.generatedAt, null, 'template generatedAt must be null');
  } else {
    validTimestamp(record.generatedAt, 'generatedAt');
  }
  if (record.generatedBy === 'github-actions') {
    match(record.workflowRunURL, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/, 'workflowRunURL is invalid');
  } else {
    equal(record.workflowRunURL, null, 'workflowRunURL must be null outside GitHub Actions');
  }

  exactObject(record.source, SOURCE_KEYS, 'source');
  exactObject(record.environment, ENVIRONMENT_KEYS, 'environment');
  if (record.generatedBy === 'template') {
    equal(record.source.commit, null, 'template source commit must be null');
    equal(record.source.clean, null, 'template source clean must be null');
    for (const key of ENVIRONMENT_KEYS) equal(record.environment[key], null, `template environment ${key} must be null`);
  } else {
    match(record.source.commit, /^[0-9a-f]{40}$/, 'source commit is invalid');
    requireType(record.source.clean, 'boolean', 'source clean must be a boolean');
    equal(record.environment.platform, 'macos', 'verification platform must be macOS');
    oneOf(record.environment.architecture, ['arm64', 'x86_64'], 'environment architecture is invalid');
    match(record.environment.macOSVersion, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/, 'macOS version is invalid');
    match(record.environment.nodeVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/, 'Node version is invalid');
    match(record.environment.swiftVersion, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/, 'Swift version is invalid');
  }

  exactObject(record.release, RELEASE_KEYS, 'release');
  for (const key of RELEASE_KEYS.filter((key) => key !== 'supportedSkillProtocolVersions')) {
    equal(record.release[key], null, `draft release ${key} must be null`);
  }
  if (!Array.isArray(record.release.supportedSkillProtocolVersions)
    || record.release.supportedSkillProtocolVersions.length !== 0) {
    fail('draft supportedSkillProtocolVersions must be empty');
  }

  if (!Array.isArray(record.checks) || record.checks.length !== AUTOMATED_CHECKS.length + HUMAN_CHECK_IDS.length) {
    fail('checks must contain the exact draft check set');
  }
  const expectedChecks = [
    ...AUTOMATED_CHECKS.map((check) => ({ ...check, kind: 'automated' })),
    ...HUMAN_CHECK_IDS.map((id) => ({ id, kind: 'human' })),
  ];
  record.checks.forEach((check, index) => validateCheck(check, expectedChecks[index], record.generatedBy));

  exactObject(record.qualification, QUALIFICATION_KEYS, 'qualification');
  equal(record.qualification.liveUserReconciliationEligible, false, 'draft cannot qualify live reconciliation');
  const blockers = expectedBlockers(record);
  if (JSON.stringify(record.qualification.blockers) !== JSON.stringify(blockers)) {
    fail('qualification blockers do not match the draft evidence');
  }
  return record;
}

function validateCheck(check, expected, generatedBy) {
  exactObject(check, CHECK_KEYS, `check ${expected.id}`);
  equal(check.id, expected.id, `check ${expected.id} is missing or out of order`);
  equal(check.kind, expected.kind, `check ${expected.id} kind is invalid`);
  if (expected.kind === 'human') {
    equal(check.status, 'not-run', `human check ${expected.id} must remain not-run`);
    equal(check.reason, 'human-proof-required', `human check ${expected.id} reason is invalid`);
    return;
  }
  if (generatedBy === 'template') {
    equal(check.status, 'not-run', `template check ${expected.id} must remain not-run`);
    equal(check.reason, 'template-not-run', `template check ${expected.id} reason is invalid`);
    return;
  }
  oneOf(check.status, ['passed', 'failed'], `automated check ${expected.id} status is invalid`);
  if (check.status === 'failed') {
    oneOf(check.reason, ['command-failed', 'command-timed-out'], `automated check ${expected.id} reason is invalid`);
  } else {
    equal(check.reason, null, `automated check ${expected.id} reason is invalid`);
  }
}

function expectedBlockers({ source, checks }) {
  const blockers = [];
  if (source.commit === null) blockers.push('source-not-collected');
  else if (source.clean !== true) blockers.push('source-not-clean');
  const automated = checks.filter(({ kind }) => kind === 'automated');
  if (automated.some(({ status }) => status === 'not-run')) blockers.push('automated-checks-not-run');
  if (automated.some(({ status }) => status === 'failed')) blockers.push('automated-check-failed');
  blockers.push('signed-release-not-supplied', 'human-proof-not-run');
  return blockers;
}

async function realMacFacts(generatedBy) {
  if (platform !== 'darwin') fail('verify:mac requires macOS');
  const architecture = arch === 'x64' ? 'x86_64' : arch;
  oneOf(architecture, ['arm64', 'x86_64'], 'this Mac architecture is unsupported');
  const source = repositorySnapshot();
  const swift = requiredOutput('swift', ['--version'], 'cannot read the Swift version', REPOSITORY_ROOT);
  const swiftVersion = /Apple Swift version ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(swift)?.[1];
  if (!swiftVersion) fail('Swift version output is unsupported');
  const macOSVersion = requiredOutput('sw_vers', ['-productVersion'], 'cannot read the macOS version', REPOSITORY_ROOT);
  match(macOSVersion, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/, 'macOS version is invalid');
  return {
    generatedAt: new Date().toISOString(),
    generatedBy,
    workflowRunURL: generatedBy === 'github-actions' ? githubWorkflowRunURL(process.env) : null,
    source,
    environment: {
      platform: 'macos',
      architecture,
      macOSVersion,
      nodeVersion: process.versions.node,
      swiftVersion,
    },
  };
}

export async function runPublicCheck({ id, executable, arguments: args, timeoutMs }, runner = spawn) {
  const environment = id === 'swift-package-tests' ? {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: path.join(tmpdir(), 'caddie-verification-clang-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: path.join(tmpdir(), 'caddie-verification-swift-cache'),
  } : process.env;
  return new Promise((resolve) => {
    let child;
    try {
      child = runner(executable, args, {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
        env: environment,
        detached: true,
      });
    } catch {
      resolve('command-failed');
      return;
    }

    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.once('error', () => finish('command-failed'));
    child.once('exit', (code) => finish(timedOut ? 'command-timed-out' : code === 0 ? 'passed' : 'command-failed'));
  });
}

function requiredOutput(executable, args, message, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) fail(message);
  return result.stdout.trim();
}

export function repositorySnapshot(repositoryRoot = REPOSITORY_ROOT, runner = spawnSync) {
  const run = (args, message) => {
    const result = runner('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
    if (result.status !== 0) fail(message);
    return result.stdout.trim();
  };
  const topLevel = run(['rev-parse', '--show-toplevel'], 'cannot find the verifier repository');
  if (realpathSync(topLevel) !== realpathSync(repositoryRoot)) fail('verifier repository root is invalid');
  const commit = run(['rev-parse', 'HEAD'], 'cannot read the source commit');
  match(commit, /^[0-9a-f]{40}$/, 'source commit is invalid');
  const indexEntries = run(['ls-files', '-v'], 'cannot inspect Git index flags');
  const hasHiddenEntry = indexEntries.split('\n').some((line) => {
    const tag = line[0];
    return tag === 'S' || (tag >= 'a' && tag <= 'z');
  });
  if (hasHiddenEntry) fail('source has hidden Git index flags');
  const status = run(['status', '--porcelain=v1', '--untracked-files=all'], 'cannot inspect source cleanliness');
  return { commit, clean: status.length === 0 };
}

function githubWorkflowRunURL(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const runID = environment.GITHUB_RUN_ID;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[0-9]+$/.test(runID ?? '')) {
    fail('GitHub Actions run identity is invalid');
  }
  return `https://github.com/${repository}/actions/runs/${runID}`;
}

function rejectDuplicateObjectKeys(text) {
  const errors = [];
  const tree = jsoncParser.parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length > 0) return;
  const inspect = (node) => {
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (keys.has(key)) fail('record has duplicate JSON object keys');
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) inspect(child);
  };
  inspect(tree);
}

export function validateRecordText(text) {
  rejectDuplicateObjectKeys(text);
  return validateRecord(JSON.parse(text));
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has missing or unknown fields`);
}

function validTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} is invalid`);
  }
}

function requireType(value, type, message) {
  if (typeof value !== type) fail(message);
}

function match(value, expression, message) {
  if (typeof value !== 'string' || !expression.test(value)) fail(message);
}

function oneOf(value, choices, message) {
  if (!choices.includes(value)) fail(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) fail(message);
}

function fail(message) {
  throw new VerificationRecordError(message);
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1 || args.indexOf(name, index + 1) >= 0) fail(`${name} is required exactly once`);
  return args[index + 1];
}

async function main(args) {
  const [operation, ...rest] = args;
  if (operation === 'validate') {
    if (rest.length !== 1) fail('Usage: release-verification.mjs validate <record.json>');
    validateRecordText(await readFile(rest[0], 'utf8'));
    process.stdout.write('Release Verification draft is valid.\n');
    return;
  }
  if (operation === 'mac') {
    const output = argumentValue(rest, '--output');
    const generatedBy = rest.includes('--github-actions') ? 'github-actions' : 'local-macos';
    const allowed = new Set(['--output', output, '--github-actions']);
    if (rest.some((value) => !allowed.has(value))) fail('Usage: release-verification.mjs mac --output <record.json> [--github-actions]');
    const record = await collectMacDraft({
      facts: await realMacFacts(generatedBy),
      commandRunner: runPublicCheck,
      repositoryInspector: repositorySnapshot,
    });
    await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write('Wrote the Release Verification draft; it remains ineligible for live reconciliation.\n');
    if (record.checks.some(({ kind, status }) => kind === 'automated' && status !== 'passed')) process.exitCode = 1;
    return;
  }
  fail('Usage: release-verification.mjs <mac|validate>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
