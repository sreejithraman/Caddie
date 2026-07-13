import { locate } from '../context/locate.mjs';
import { inspect } from '../context/inspect.mjs';
import { DISPOSITIONS, ToolError, invalid } from './errors.mjs';

export const PROTOCOL_VERSION = 1;

export async function runTool(rawRequest, runtime = {}) {
  let operation = null;
  try {
    if (!rawRequest.trim()) throw invalid('empty-request', 'Expected one JSON request on standard input');

    let request;
    try {
      request = JSON.parse(rawRequest);
    } catch {
      throw invalid('invalid-json', 'Request is not valid JSON');
    }
    if (!request || Array.isArray(request) || typeof request !== 'object') {
      throw invalid('invalid-request', 'Request must be a JSON object');
    }
    operation = typeof request.operation === 'string' ? request.operation : null;
    const requestVersion = request.version ?? request.protocolVersion;
    if (requestVersion !== PROTOCOL_VERSION) {
      throw invalid('unsupported-protocol-version', `Unsupported protocol version: ${String(requestVersion)}`, {
        supported: [PROTOCOL_VERSION],
        received: requestVersion ?? null,
      });
    }
    if (!operation) throw invalid('missing-operation', 'Request operation must be a non-empty string');
    const input = request.input ?? {};
    if (!input || Array.isArray(input) || typeof input !== 'object') {
      throw invalid('invalid-input', 'Request input must be a JSON object');
    }

    const handlers = { locate, inspect, ...(runtime.operations ?? {}) };
    const handler = handlers[operation];
    if (!handler) {
      throw invalid('unsupported-operation', `Unsupported operation: ${operation}`, {
        supported: Object.keys(handlers),
      });
    }

    const operationResult = await handler(input, runtime);
    const { coverage = { status: 'complete', issues: [] }, ...result } = operationResult;
    return {
      exitCode: 0,
      response: {
        version: PROTOCOL_VERSION,
        ok: true,
        operation,
        result,
        coverage,
      },
    };
  } catch (cause) {
    const error = normaliseError(cause);
    return {
      exitCode: 1,
      response: {
        version: PROTOCOL_VERSION,
        ok: false,
        operation,
        error,
      },
    };
  }
}

function normaliseError(cause) {
  if (cause instanceof ToolError && DISPOSITIONS.includes(cause.disposition)) {
    return withoutUndefined({
      code: cause.code,
      message: cause.message,
      disposition: cause.disposition,
      details: cause.details,
    });
  }
  if (cause?.code === 'EACCES' || cause?.code === 'EPERM') {
    return {
      code: 'permission-denied',
      message: cause.message,
      disposition: 'needs-permission',
    };
  }
  return {
    code: 'internal-error',
    message: 'The Caddie Tool encountered an unexpected error',
    disposition: 'bug',
  };
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
