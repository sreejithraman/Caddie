import { createManagementModule, ManagementError } from '../management/index.mjs';
import { ManagementStateError } from '../management/formats.mjs';

export function createInProcessAdapter(options = {}) {
  const management = options.management ?? createManagementModule({
    ...(options.managementOptions ?? {}),
    legacyRuntime: options.legacyRuntime,
  });
  return Object.freeze({
    execute: (request) => execute(request, management),
    executeRaw: (rawRequest) => executeRaw(rawRequest, management),
  });
}

async function execute(request, management) {
  if (request?.version !== 2) return legacyResult(management, JSON.stringify(request) ?? 'undefined');
  return executeCurrent(request, management);
}

async function executeRaw(rawRequest, management) {
  let request;
  try { request = JSON.parse(rawRequest); } catch { return legacyResult(management, rawRequest); }
  return execute(request, management);
}

async function executeCurrent(request, management) {
  try {
    return await management.execute(request);
  } catch (error) {
    return errorResponse(request, error);
  }
}

async function legacyResult(management, rawRequest) {
  return (await management.executeLegacy(rawRequest)).response;
}

function errorResponse(request, cause) {
  const error = normaliseError(cause);
  return {
    version: 2,
    ok: false,
    requestId: typeof request?.requestId === 'string' ? request.requestId : null,
    operation: typeof request?.operation === 'string' ? request.operation : null,
    error,
  };
}

function normaliseError(cause) {
  if (cause instanceof ManagementError || cause instanceof ManagementStateError) {
    return withoutUndefined({
      code: cause.code,
      message: cause.message,
      disposition: cause.disposition ?? 'needs-user',
      details: cause.details,
    });
  }
  if (cause?.code === 'EACCES' || cause?.code === 'EPERM') {
    return { code: 'permission-denied', message: cause.message, disposition: 'needs-permission' };
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
