import { spawn as nodeSpawn } from 'node:child_process';
import { validateManagementSnapshot } from '../management/formats.mjs';

export const OPERATION_LIMITS_MS = Object.freeze({ status: 5_000, cycle: 120_000, act: 5_000 });
export const STOP_GRACE_MS = 10_000;
export const RETRY_DELAY_MS = 10_000;
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;

const DISPOSITIONS = new Set(['retry', 'replan', 'needs-user', 'needs-permission', 'invalid', 'bug']);

export class ChildProcessAdapterError extends Error {
  constructor(code, message, disposition = 'retry', details = {}) {
    super(message);
    this.name = 'ChildProcessAdapterError';
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

export function createChildProcessAdapter(options) {
  if (!options?.command) throw new TypeError('child-process Adapter command is required');
  const runtime = {
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    env: options.env,
    spawn: options.spawn ?? nodeSpawn,
    limits: { ...OPERATION_LIMITS_MS, ...options.limits },
    stopGraceMs: options.stopGraceMs ?? STOP_GRACE_MS,
    retryDelayMs: options.retryDelayMs ?? RETRY_DELAY_MS,
    maxStdoutBytes: options.maxStdoutBytes ?? MAX_STDOUT_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? MAX_STDERR_BYTES,
    delay: options.delay ?? delay,
    setTimer: options.setTimer ?? setTimeout,
    clearTimer: options.clearTimer ?? clearTimeout,
  };
  return Object.freeze({ execute: (request) => execute(request, runtime) });
}

async function execute(request, runtime) {
  const timeoutMs = runtime.limits[request?.operation] ?? OPERATION_LIMITS_MS.status;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await runAttempt(request, timeoutMs, runtime);
    } catch (error) {
      if (error?.code !== 'child-timeout' || attempt === 2) throw error;
      await runtime.delay(runtime.retryDelayMs);
    }
  }
  throw new ChildProcessAdapterError('child-timeout', 'Caddie Tool timed out');
}

function runAttempt(request, timeoutMs, runtime) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = runtime.spawn(runtime.command, runtime.args, {
        cwd: runtime.cwd,
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new ChildProcessAdapterError('child-launch-failed', 'Caddie Tool could not start', 'retry', faultDetails(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let forcedStop = false;
    let pendingFault = null;
    let stopTimer;
    const timeoutTimer = runtime.setTimer(onTimeout, timeoutMs);

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdin?.once?.('error', onInputError);
    child.once('error', onChildError);
    child.once('close', onClose);

    try {
      child.stdin.end(`${JSON.stringify(request)}\n`);
    } catch (error) {
      onInputError(error);
    }

    function onStdout(chunk) {
      const bytes = Buffer.byteLength(chunk);
      stdoutBytes += bytes;
      if (stdoutBytes > runtime.maxStdoutBytes) {
        if (!pendingFault) pendingFault = new ChildProcessAdapterError(
          'child-stdout-overflow', 'Caddie Tool returned too much output', 'bug', { limitBytes: runtime.maxStdoutBytes },
        );
        requestStop();
        return;
      }
      stdout += chunk;
    }

    function onStderr(chunk) {
      const bytes = Buffer.byteLength(chunk);
      stderrBytes += bytes;
      if (stderrBytes > runtime.maxStderrBytes) {
        if (!pendingFault) pendingFault = new ChildProcessAdapterError(
          'child-stderr-overflow', 'Caddie Tool returned too many diagnostics', 'bug', { limitBytes: runtime.maxStderrBytes },
        );
        requestStop();
        return;
      }
      stderr += chunk;
    }

    function onInputError(error) {
      if (!pendingFault) pendingFault = new ChildProcessAdapterError(
        'child-input-failed', 'Caddie Tool request could not be sent', 'retry', faultDetails(error),
      );
      requestStop();
    }

    function onChildError(error) {
      finish(() => reject(new ChildProcessAdapterError(
        'child-launch-failed', 'Caddie Tool could not start', 'retry', { ...faultDetails(error), stderr: bounded(stderr) },
      )));
    }

    function onTimeout() {
      timedOut = true;
      requestStop();
    }

    function requestStop() {
      runtime.clearTimer(timeoutTimer);
      if (stopTimer === undefined) {
        stopTimer = runtime.setTimer(() => {
          forcedStop = true;
          child.kill('SIGKILL');
        }, runtime.stopGraceMs);
      }
      child.kill('SIGTERM');
    }

    function onClose(code, signal) {
      finish(() => {
        if (pendingFault) {
          reject(withProcessFacts(pendingFault, { code, signal, stderr, forcedStop }));
          return;
        }
        if (timedOut) {
          reject(new ChildProcessAdapterError('child-timeout', 'Caddie Tool timed out', 'retry', {
            timeoutMs, forcedStop, signal: signal ?? null, stderr: bounded(stderr),
          }));
          return;
        }
        let response;
        try {
          response = parseResponse(stdout, request);
        } catch (error) {
          reject(new ChildProcessAdapterError(error.code, error.message, 'bug', {
            exitCode: code, signal: signal ?? null, stderr: bounded(stderr), stdout: bounded(stdout),
          }));
          return;
        }
        if (code !== 0 && response.ok !== false) {
          reject(new ChildProcessAdapterError('child-nonzero-exit', 'Caddie Tool stopped with an error', 'bug', {
            exitCode: code, signal: signal ?? null, stderr: bounded(stderr),
          }));
          return;
        }
        resolve(response);
      });
    }

    function finish(action) {
      if (settled) return;
      settled = true;
      runtime.clearTimer(timeoutTimer);
      if (stopTimer !== undefined) runtime.clearTimer(stopTimer);
      child.stdout?.off?.('data', onStdout);
      child.stderr?.off?.('data', onStderr);
      child.stdin?.off?.('error', onInputError);
      child.off?.('error', onChildError);
      child.off?.('close', onClose);
      action();
    }
  });
}

function parseResponse(stdout, request) {
  const text = stdout.trim();
  if (!text) throw protocolFault('child-incomplete-output', 'Caddie Tool returned no complete JSON response');
  let response;
  try { response = JSON.parse(text); } catch {
    throw protocolFault('child-invalid-json', 'Caddie Tool returned invalid or partial JSON');
  }
  validateResponse(response, request);
  return response;
}

function validateResponse(response, request) {
  if (!plainObject(response) || typeof response.ok !== 'boolean') {
    throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid response envelope');
  }
  const current = response.version === 2;
  const required = current
    ? ['version', 'ok', 'requestId', 'operation', response.ok ? 'result' : 'error']
    : ['version', 'ok', 'operation', response.ok ? 'result' : 'error'];
  if (!exactKeys(response, required)) throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid response envelope');
  if ([1, 2].includes(request.version) && response.version !== request.version) {
    throw protocolFault('child-version-mismatch', 'Caddie Tool returned a response for another protocol version');
  }
  if (typeof request.operation === 'string' && response.operation !== request.operation) {
    throw protocolFault('child-operation-mismatch', 'Caddie Tool returned a response for another operation');
  }
  if (current && typeof request.requestId === 'string' && response.requestId !== request.requestId) {
    throw protocolFault('child-request-mismatch', 'Caddie Tool returned a response for another request');
  }
  if (current && response.requestId !== null && typeof response.requestId !== 'string') {
    throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid request ID');
  }
  if (response.operation !== null && typeof response.operation !== 'string') {
    throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid operation');
  }
  if (response.ok) validateSuccess(response, current);
  else validateError(response.error);
  validateBoundedJson(response);
}

function validateSuccess(response, current) {
  if (!plainObject(response.result)) throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid result');
  if (current) {
    if (!exactKeys(response.result, ['snapshot'])) throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid result');
    try { validateManagementSnapshot(response.result.snapshot); } catch {
      throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid Snapshot');
    }
    return;
  }
  if (!plainObject(response.coverage) || !exactKeys(response.coverage, ['status', 'issues'])
    || !['complete', 'partial'].includes(response.coverage.status)
    || !Array.isArray(response.coverage.issues)) {
    throw protocolFault('child-invalid-response', 'Caddie Tool returned invalid coverage');
  }
}

function validateError(error) {
  if (!plainObject(error) || !exactKeys(error, ['code', 'message', 'disposition'], ['details'])
    || typeof error.code !== 'string' || error.code.length === 0 || error.code.length > 128
    || typeof error.message !== 'string' || error.message.length === 0 || error.message.length > 4096
    || !DISPOSITIONS.has(error.disposition)
    || (error.details !== undefined && !plainObject(error.details))) {
    throw protocolFault('child-invalid-response', 'Caddie Tool returned an invalid error');
  }
}

function validateBoundedJson(value, depth = 0) {
  if (depth > 24) throw protocolFault('child-invalid-response', 'Caddie Tool response is nested too deeply');
  if (typeof value === 'string' && value.length > MAX_STDOUT_BYTES) {
    throw protocolFault('child-invalid-response', 'Caddie Tool response contains an overlong string');
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) throw protocolFault('child-invalid-response', 'Caddie Tool response contains an overlong list');
    value.forEach((item) => validateBoundedJson(item, depth + 1));
  } else if (plainObject(value)) {
    if (Object.keys(value).length > 500) throw protocolFault('child-invalid-response', 'Caddie Tool response contains too many fields');
    Object.values(value).forEach((item) => validateBoundedJson(item, depth + 1));
  }
}

function withProcessFacts(error, { code, signal, stderr, forcedStop }) {
  error.details = {
    ...error.details, exitCode: code, signal: signal ?? null, stderr: bounded(stderr), forcedStop,
  };
  return error;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional, ...(value.version === 1 && value.ok ? ['coverage'] : [])]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function protocolFault(code, message) { return Object.assign(new Error(message), { code }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function faultDetails(error) { return { cause: error?.code ?? error?.message ?? String(error) }; }
function bounded(value) { return value.slice(0, 4096); }
