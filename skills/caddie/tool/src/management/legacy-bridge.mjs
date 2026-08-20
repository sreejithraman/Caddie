import { runTool } from '../protocol/run-tool.mjs';
import { extendedOperations } from '../protocol/operations.mjs';

export const LEGACY_OPERATIONS = Object.freeze([
  'locate', 'inspect', 'inspect-source', 'compare', 'plan', 'apply-plan', 'recover',
]);

const LEGACY_OPERATION_SET = new Set(LEGACY_OPERATIONS);
const LEGACY_PLAN_INPUT_SCHEMAS = deepFreeze({
  'kind:reconcile': ['home', 'configHome', 'kind', 'scope', 'operations'],
  'kind:cleanup': ['home', 'configHome', 'kind', 'scope', 'operations'],
  'workflow:adoption': [
    'home', 'configHome', 'workflow', 'scopeRoot', 'candidates', 'scope', 'ensureClaude',
    'legacyLockPath', 'proposal', 'ledger', 'ledgerExpected',
  ],
  'workflow:skill-enablement': ['home', 'configHome', 'workflow', 'scope', 'selection', 'enabled'],
  'workflow:skill-rename': [
    'home', 'configHome', 'workflow', 'scope', 'renames', 'manifest', 'materializations',
  ],
  'workflow:unmanagement': [
    'home', 'configHome', 'workflow', 'scope', 'ledgerFingerprint', 'registry', 'skillPaths',
    'removeClaudeExposure', 'removeHarnessExposure',
  ],
  'workflow:cleanup': [
    'home', 'configHome', 'workflow', 'scope', 'skillPaths', 'removeClaudeExposure', 'removeHarnessExposure',
  ],
  'workflow:state-migration': ['home', 'configHome', 'workflow'],
  'workflow:legacy-manager-cleanup': ['home', 'configHome', 'workflow'],
});
const LEGACY_RAW_OPERATION_SCHEMAS = deepFreeze({
  'materialize-skill': [
    'type', 'name', 'sourcePath', 'destinationPath', 'sourceFingerprint', 'expectedDestination',
    'sourceId', 'selectedPath', 'sourceCleanup',
  ],
  'ensure-harness-exposure': [
    'type', 'harness', 'linkPath', 'targetPath', 'targetFingerprint', 'expected',
  ],
  'write-manifest': ['type', 'path', 'content', 'expected'],
  'write-lock': ['type', 'path', 'content', 'expected'],
  'write-ledger': ['type', 'path', 'content', 'expected'],
  'cleanup-preserved-skill': ['type', 'path', 'expected'],
  'cleanup-exposure': ['type', 'harness', 'path', 'expected'],
});
const LEGACY_SCOPE_FIELDS = Object.freeze(['id', 'root']);
const LEGACY_EXPECTED_SCHEMAS = deepFreeze({
  absent: ['state'],
  fingerprint: ['state', 'fingerprint'],
  file: ['state', 'fingerprint'],
  symlink: ['state', 'target'],
});
const LEGACY_SOURCE_CLEANUP_FIELDS = Object.freeze(['root', 'token']);
const LEGACY_REGISTRY_FIELDS = Object.freeze(['path', 'currentFingerprint', 'nextContent']);
const LEGACY_ADOPTION_CANDIDATE_FIELDS = Object.freeze([
  'name', 'sourcePath', 'sourceId', 'selectedPath', 'sourceFingerprint',
]);
const LEGACY_SELECTION_FIELDS = Object.freeze(['source', 'path']);
const LEGACY_RENAME_FIELDS = Object.freeze(['from', 'to']);
const LEGACY_RENAME_IDENTITY_FIELDS = Object.freeze(['name', 'source', 'path']);
const LEGACY_RENAME_MATERIALIZATION_FIELDS = Object.freeze([
  'name', 'sourceId', 'selectedPath', 'sourcePath', 'sourceFingerprint', 'sourceCleanup',
]);
const LEGACY_MANIFEST_FIELDS = Object.freeze([
  'manifestVersion', 'version', 'scope', 'sources', 'skills', 'selections',
]);
const LEGACY_MANIFEST_SOURCE_FIELDS = Object.freeze(['name', 'id', 'type', 'path', 'url', 'ref']);
const LEGACY_MANIFEST_SELECTION_FIELDS = Object.freeze([
  'source', 'path', 'enabled', 'derivedFrom', 'migrationRecord', 'invocation',
]);
const LEGACY_LEDGER_FIELDS = Object.freeze(['version', 'scopeId', 'entries', 'harnessLinks', 'harnessSettings']);
const LEGACY_LEDGER_ENTRY_FIELDS = Object.freeze([
  'name', 'path', 'fingerprint', 'sourceId', 'source', 'selectedPath', 'adopted',
]);
const LEGACY_HARNESS_SETTING_FIELDS = Object.freeze([
  'harness', 'skill', 'settingsPath', 'key', 'value', 'containerCreated',
]);
const LEGACY_FINGERPRINT_FIELDS = Object.freeze([
  'algorithm', 'digest', 'complete', 'fileCount', 'byteCount', 'findings',
]);
const LEGACY_FINGERPRINT_FINDING_FIELDS = Object.freeze(['code', 'path', 'operation']);
const LEGACY_ADOPTION_PROPOSAL_FIELDS = Object.freeze(['scopeRoot', 'entries', 'legacy', 'mutationsPerformed']);
const LEGACY_ADOPTION_ENTRY_FIELDS = Object.freeze([
  'name', 'installedPath', 'classification', 'preselected', 'preserved', 'findings',
  'legacyEvidence', 'extensionFields', 'installedFingerprint', 'sourceFingerprint', 'sourceId', 'selectedPath',
]);
const LEGACY_ADOPTION_FINDING_FIELDS = Object.freeze(['code', 'field']);
const LEGACY_ADOPTION_LEGACY_FIELDS = Object.freeze([
  'present', 'path', 'fingerprint', 'parseError', 'evidenceOnly', 'removalRecommended',
]);
const LEGACY_ADOPTION_LEGACY_EVIDENCE_FIELDS = Object.freeze([
  'source', 'sourceType', 'sourceUrl', 'skillPath', 'skillFolderHash',
]);

export function createLegacyBridge(options = {}) {
  const runtime = { env: options.env, operations: options.operations ?? extendedOperations };
  return Object.freeze({ execute: (rawRequest) => execute(rawRequest, runtime) });
}

async function execute(rawRequest, runtime) {
  let request;
  try { request = JSON.parse(rawRequest); } catch { return runTool(rawRequest, runtime); }
  if (request?.version !== 1) return runTool(rawRequest, runtime);
  if (!plainObject(request) || !exactKeys(request, ['version', 'operation', 'input'])) {
    return rejection(request, 'legacy-request-extension', 'Protocol 1 requests may use only version, operation, and input');
  }
  if (!LEGACY_OPERATION_SET.has(request.operation)) {
    return rejection(request, 'unsupported-operation', `Unsupported protocol 1 operation: ${String(request.operation)}`, {
      supported: LEGACY_OPERATIONS,
    });
  }
  if (request.operation === 'plan') {
    const fault = validateLegacyPlan(request.input);
    if (fault) return rejection(request, fault.code, fault.message, fault.details);
  }
  return runTool(rawRequest, runtime);
}

function validateLegacyPlan(input) {
  if (!plainObject(input)) return null;
  if (Object.hasOwn(input, 'intent')) {
    return { code: 'internal-plan-field', message: 'Skill Enablement intent and harness settings operations are derived by Caddie' };
  }
  const form = input.workflow === undefined ? `kind:${String(input.kind)}` : `workflow:${String(input.workflow)}`;
  const inputFields = LEGACY_PLAN_INPUT_SCHEMAS[form];
  if (!inputFields || (input.workflow !== undefined && input.kind !== undefined)) {
    return { code: 'unsupported-legacy-plan-kind', message: 'Protocol 1 plan kind is not supported' };
  }
  const inputField = unknownField(input, inputFields);
  if (inputField) {
    return {
      code: 'legacy-plan-input-field',
      message: `Protocol 1 plan input field is not supported: ${inputField}`,
      details: { field: inputField, form },
    };
  }
  const scopeFault = validateNestedFields(
    input.scope, LEGACY_SCOPE_FIELDS, 'scope', form, 'legacy-plan-input-field',
  );
  if (scopeFault) return scopeFault;
  const ledgerExpectedFault = validateExpected(
    input.ledgerExpected, 'ledgerExpected', form, 'legacy-plan-input-field',
  );
  if (ledgerExpectedFault) return ledgerExpectedFault;
  if (plainObject(input.registry)) {
    const registryFault = validateNestedFields(
      input.registry, LEGACY_REGISTRY_FIELDS, 'registry', form, 'legacy-plan-input-field',
    );
    if (registryFault) return registryFault;
  }
  const workflowFault = validateWorkflowNestedInput(input);
  if (workflowFault) return workflowFault;
  if (input.workflow !== undefined) return null;
  if (!Array.isArray(input.operations)) return null;
  for (const operation of input.operations) {
    if (operation?.type === 'write-harness-settings') {
      return { code: 'internal-plan-field', message: 'Skill Enablement intent and harness settings operations are derived by Caddie' };
    }
    const operationFields = LEGACY_RAW_OPERATION_SCHEMAS[operation?.type];
    if (!operationFields) {
      return {
        code: 'unsupported-legacy-operation-kind',
        message: `Protocol 1 plan operation is not supported: ${String(operation?.type)}`,
      };
    }
    const operationField = unknownField(operation, operationFields);
    if (operationField) {
      return {
        code: 'legacy-plan-operation-field',
        message: `Protocol 1 raw plan operation field is not supported: ${operationField}`,
        details: { field: operationField, type: operation.type },
      };
    }
    const expectedKey = operation.type === 'materialize-skill' ? 'expectedDestination' : 'expected';
    const expectedFault = validateExpected(operation[expectedKey], expectedKey, operation.type);
    if (expectedFault) return expectedFault;
    if (plainObject(operation.sourceCleanup)) {
      const cleanupFault = validateNestedFields(
        operation.sourceCleanup, LEGACY_SOURCE_CLEANUP_FIELDS, 'sourceCleanup', operation.type,
      );
      if (cleanupFault) return cleanupFault;
    }
  }
  return null;
}

function validateWorkflowNestedInput(input) {
  if (input.workflow === 'adoption') {
    const candidateFault = validateObjectArray(
      input.candidates, LEGACY_ADOPTION_CANDIDATE_FIELDS, 'candidates', input.workflow,
    );
    if (candidateFault) return candidateFault;
    const ledgerFault = validateLedger(input.ledger, input.workflow);
    if (ledgerFault) return ledgerFault;
    return validateAdoptionProposal(input.proposal, input.workflow);
  }
  if (input.workflow === 'skill-enablement') {
    if (plainObject(input.selection) && Object.hasOwn(input.selection, 'name')) {
      return {
        code: 'invalid-enablement-selection',
        message: 'Skill Enablement requires exact source and path',
      };
    }
    return validateNestedFields(
      input.selection, LEGACY_SELECTION_FIELDS, 'selection', input.workflow, 'legacy-plan-input-field',
    );
  }
  if (input.workflow === 'skill-rename') return validateSkillRenameInput(input);
  return null;
}

function validateSkillRenameInput(input) {
  const pairFault = validateObjectArray(
    input.renames, LEGACY_RENAME_FIELDS, 'renames', input.workflow,
  );
  if (pairFault) return pairFault;
  for (let index = 0; index < (input.renames?.length ?? 0); index += 1) {
    for (const side of ['from', 'to']) {
      const identityFault = validateNestedFields(
        input.renames[index]?.[side], LEGACY_RENAME_IDENTITY_FIELDS,
        `renames[${index}].${side}`, input.workflow, 'legacy-plan-input-field',
      );
      if (identityFault) return identityFault;
    }
  }
  const materializationFault = validateObjectArray(
    input.materializations, LEGACY_RENAME_MATERIALIZATION_FIELDS, 'materializations', input.workflow,
  );
  if (materializationFault) return materializationFault;
  for (let index = 0; index < (input.materializations?.length ?? 0); index += 1) {
    const cleanupFault = validateNestedFields(
      input.materializations[index]?.sourceCleanup, LEGACY_SOURCE_CLEANUP_FIELDS,
      `materializations[${index}].sourceCleanup`, input.workflow, 'legacy-plan-input-field',
    );
    if (cleanupFault) return cleanupFault;
  }
  return validateRenameManifest(input.manifest, input.workflow);
}

function validateRenameManifest(manifest, owner) {
  const manifestFault = validateNestedFields(
    manifest, LEGACY_MANIFEST_FIELDS, 'manifest', owner, 'legacy-plan-input-field',
  );
  if (manifestFault || !plainObject(manifest)) return manifestFault;
  const sources = Array.isArray(manifest.sources) ? manifest.sources : Object.values(manifest.sources ?? {});
  const sourceFault = validateObjectArray(
    sources, LEGACY_MANIFEST_SOURCE_FIELDS, 'manifest.sources', owner,
  );
  if (sourceFault) return sourceFault;
  const selections = manifest.skills ?? manifest.selections;
  const selectionFault = validateObjectArray(
    selections, LEGACY_MANIFEST_SELECTION_FIELDS, 'manifest.selections', owner,
  );
  if (selectionFault) return selectionFault;
  for (let index = 0; index < (selections?.length ?? 0); index += 1) {
    const lineageFault = validateObjectArray(
      selections[index]?.derivedFrom, LEGACY_SELECTION_FIELDS,
      `manifest.selections[${index}].derivedFrom`, owner,
    );
    if (lineageFault) return lineageFault;
  }
  return null;
}

function validateLedger(ledger, owner) {
  const ledgerFault = validateNestedFields(
    ledger, LEGACY_LEDGER_FIELDS, 'ledger', owner, 'legacy-plan-input-field',
  );
  if (ledgerFault) return ledgerFault;
  if (!plainObject(ledger)) return null;
  const entryFault = validateObjectArray(
    ledger.entries, LEGACY_LEDGER_ENTRY_FIELDS, 'ledger.entries', owner,
  );
  if (entryFault) return entryFault;
  for (let index = 0; index < (ledger.entries?.length ?? 0); index += 1) {
    const fingerprint = ledger.entries[index]?.fingerprint;
    const fingerprintFault = validateFingerprint(
      fingerprint, `ledger.entries[${index}].fingerprint`, owner,
    );
    if (fingerprintFault) return fingerprintFault;
  }
  return validateObjectArray(
    ledger.harnessSettings, LEGACY_HARNESS_SETTING_FIELDS, 'ledger.harnessSettings', owner,
  );
}

function validateAdoptionProposal(proposal, owner) {
  const proposalFault = validateNestedFields(
    proposal, LEGACY_ADOPTION_PROPOSAL_FIELDS, 'proposal', owner, 'legacy-plan-input-field',
  );
  if (proposalFault || !plainObject(proposal)) return proposalFault;
  const entryFault = validateObjectArray(
    proposal.entries, LEGACY_ADOPTION_ENTRY_FIELDS, 'proposal.entries', owner,
  );
  if (entryFault) return entryFault;
  const legacyFault = validateNestedFields(
    proposal.legacy, LEGACY_ADOPTION_LEGACY_FIELDS, 'proposal.legacy', owner, 'legacy-plan-input-field',
  );
  if (legacyFault) return legacyFault;
  const legacyFingerprintFault = validateFingerprint(
    proposal.legacy?.fingerprint, 'proposal.legacy.fingerprint', owner,
  );
  if (legacyFingerprintFault) return legacyFingerprintFault;
  for (let index = 0; index < (proposal.entries?.length ?? 0); index += 1) {
    const entry = proposal.entries[index];
    for (const field of ['installedFingerprint', 'sourceFingerprint']) {
      const fingerprintFault = validateFingerprint(
        entry?.[field], `proposal.entries[${index}].${field}`, owner,
      );
      if (fingerprintFault) return fingerprintFault;
    }
    const findingFault = validateObjectArray(
      entry?.findings, LEGACY_ADOPTION_FINDING_FIELDS, `proposal.entries[${index}].findings`, owner,
    );
    if (findingFault) return findingFault;
    const evidenceFault = validateNestedFields(
      entry?.legacyEvidence, LEGACY_ADOPTION_LEGACY_EVIDENCE_FIELDS,
      `proposal.entries[${index}].legacyEvidence`, owner, 'legacy-plan-input-field',
    );
    if (evidenceFault) return evidenceFault;
  }
  return null;
}

function validateFingerprint(fingerprint, label, owner) {
  const fingerprintFault = validateNestedFields(
    fingerprint, LEGACY_FINGERPRINT_FIELDS, label, owner, 'legacy-plan-input-field',
  );
  if (fingerprintFault || !plainObject(fingerprint)) return fingerprintFault;
  return validateObjectArray(
    fingerprint.findings, LEGACY_FINGERPRINT_FINDING_FIELDS, `${label}.findings`, owner,
  );
}

function validateObjectArray(value, fields, label, owner) {
  if (!Array.isArray(value)) return null;
  for (let index = 0; index < value.length; index += 1) {
    const fault = validateNestedFields(
      value[index], fields, `${label}[${index}]`, owner, 'legacy-plan-input-field',
    );
    if (fault) return fault;
  }
  return null;
}

function validateExpected(expected, label, owner, code) {
  if (!plainObject(expected) || !LEGACY_EXPECTED_SCHEMAS[expected.state]) return null;
  return validateNestedFields(expected, LEGACY_EXPECTED_SCHEMAS[expected.state], label, owner, code);
}

function validateNestedFields(value, fields, label, owner, code = 'legacy-plan-operation-field') {
  if (!plainObject(value)) return null;
  const field = unknownField(value, fields);
  if (!field) return null;
  return {
    code,
    message: `Protocol 1 ${label} field is not supported: ${field}`,
    details: { field: `${label}.${field}`, owner },
  };
}

function rejection(request, code, message, details) {
  return {
    exitCode: 1,
    response: {
      version: 1,
      ok: false,
      operation: typeof request?.operation === 'string' ? request.operation : null,
      error: { code, message, disposition: 'invalid', ...(details === undefined ? {} : { details }) },
    },
  };
}

function exactKeys(value, required) {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key));
}

function unknownField(value, allowed) {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
