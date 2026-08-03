export const MANAGEMENT_PROTOCOL_VERSION = 2;
export const MANAGEMENT_OPERATIONS = Object.freeze(['status', 'cycle', 'act']);
export const CYCLE_MODES = Object.freeze(['observe-only', 'authorized-user-reconciliation']);
export const ACT_FORMS = Object.freeze(['request', 'invoke', 'report-effect']);

export class ManagementError extends Error {
  constructor(code, message, disposition = 'invalid', details = {}) {
    super(message);
    this.name = 'ManagementError';
    this.code = code;
    this.disposition = disposition;
    this.details = details;
  }
}

export function validateManagementRequest(request) {
  if (!plainObject(request)) throw new ManagementError('invalid-request', 'Management request must be an object');
  exactKeys(request, ['version', 'requestId', 'caller', 'operation', 'input'], 'request');
  if (request.version !== MANAGEMENT_PROTOCOL_VERSION) {
    throw new ManagementError('unsupported-protocol-version', `Unsupported management protocol version: ${String(request.version)}`, 'invalid', {
      supported: [MANAGEMENT_PROTOCOL_VERSION], received: request.version ?? null,
    });
  }
  boundedString(request.requestId, 'requestId', 128);
  if (!['app', 'skill'].includes(request.caller)) throw new ManagementError('invalid-caller', 'Caller must be app or skill');
  if (!MANAGEMENT_OPERATIONS.includes(request.operation)) throw new ManagementError('unsupported-operation', 'Operation must be status, cycle, or act');
  if (!plainObject(request.input)) throw new ManagementError('invalid-input', 'Operation input must be an object');
  if (request.operation === 'status') validateStatus(request.input);
  else if (request.operation === 'cycle') validateCycle(request.input);
  else validateAct(request.input);
  return structuredClone(request);
}

function validateStatus(input) {
  exactKeys(input, ['continuationToken'], 'status input', true);
  if (input.continuationToken !== undefined) boundedString(input.continuationToken, 'continuationToken', 4096);
}

function validateCycle(input) {
  exactKeys(input, ['idempotencyId', 'mode', 'hint', 'subjectIds', 'refreshProjects'], 'cycle input', true);
  boundedString(input.idempotencyId, 'idempotencyId', 128);
  if (!CYCLE_MODES.includes(input.mode)) throw new ManagementError('invalid-cycle-mode', 'Cycle mode is not supported');
  if (input.hint !== undefined) {
    if (!plainObject(input.hint)) throw new ManagementError('invalid-observation-hint', 'Observation Hint must be an object');
    if (JSON.stringify(input.hint).length > 4096) throw new ManagementError('observation-hint-too-large', 'Observation Hint is too large');
  }
  if (input.subjectIds !== undefined
    && (!Array.isArray(input.subjectIds) || input.subjectIds.length > 100
      || input.subjectIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 512))) {
    throw new ManagementError('invalid-subject-ids', 'Subject IDs must be a bounded string array');
  }
  if (input.refreshProjects !== undefined && typeof input.refreshProjects !== 'boolean') {
    throw new ManagementError('invalid-refresh-projects', 'refreshProjects must be true or false');
  }
}

function validateAct(input) {
  exactKeys(input, ['idempotencyId', 'form', 'intent', 'actionId', 'approval', 'effectId', 'outcome'], 'act input', true);
  boundedString(input.idempotencyId, 'idempotencyId', 128);
  if (!ACT_FORMS.includes(input.form)) throw new ManagementError('invalid-act-form', 'Act form is not supported');
  if (input.form === 'request') validateIntent(input.intent);
  else if (input.form === 'invoke') {
    boundedString(input.actionId, 'actionId', 128);
    if (input.approval !== 'explicit') throw new ManagementError('approval-required', 'Exact explicit approval is required', 'needs-user');
  } else {
    boundedString(input.effectId, 'effectId', 128);
    if (!['delivered', 'failed', 'unavailable', 'opened'].includes(input.outcome)) {
      throw new ManagementError('invalid-effect-outcome', 'Outside effect outcome is not supported');
    }
  }
}

function validateIntent(intent) {
  if (!plainObject(intent)) throw new ManagementError('invalid-intent', 'Act request requires domain intent');
  const shapes = {
    'authorize-reconciliation': ['type', 'selectionId'],
    'revoke-reconciliation': ['type', 'selectionId'],
    'update-selection': ['type', 'selectionId'],
    'resume-reconciliation': ['type'],
    retry: ['type', 'attentionId'],
    'agent-handoff': ['type', 'attentionId', 'provider'],
  };
  if (!Object.hasOwn(shapes, intent.type)) throw new ManagementError('unsupported-intent', 'Domain intent is not supported');
  exactKeys(intent, shapes[intent.type], `${intent.type} intent`);
  if (intent.selectionId !== undefined) boundedString(intent.selectionId, 'selectionId', 512);
  if (intent.attentionId !== undefined) boundedString(intent.attentionId, 'attentionId', 128);
  if (intent.provider !== undefined && !['codex', 'claude'].includes(intent.provider)) {
    throw new ManagementError('invalid-agent-provider', 'Agent provider must be codex or claude');
  }
}

function exactKeys(value, allowed, label, optional = false) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new ManagementError('unknown-field', `${label} has unknown fields`, 'invalid', { fields: extras });
  if (!optional) {
    const missing = allowed.filter((key) => !Object.hasOwn(value, key));
    if (missing.length) throw new ManagementError('missing-field', `${label} is missing fields`, 'invalid', { fields: missing });
  }
}

function boundedString(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ManagementError('invalid-string', `${label} must be a bounded non-empty string`);
  }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
