'use strict';

const YAML = require('../vendor/yaml.cjs');

const STANDARD_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

function parseSkillMetadata(content) {
  if (typeof content !== 'string') throw new TypeError('SKILL.md content must be a string');
  const frontmatter = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!frontmatter) return result(false, null, null, [{ code: 'skill-frontmatter-missing' }]);

  let fields;
  try {
    const document = YAML.parseDocument(frontmatter[1], { schema: 'core', uniqueKeys: true });
    if (document.errors.length > 0) return result(true, null, null, [{ code: 'skill-frontmatter-yaml-invalid' }]);
    fields = document.toJS();
  } catch {
    return result(true, null, null, [{ code: 'skill-frontmatter-yaml-invalid' }]);
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return result(true, null, null, [{ code: 'skill-frontmatter-yaml-invalid' }]);
  }

  const name = stringField(fields.name);
  const description = stringField(fields.description);
  const findings = [];
  if (!name) findings.push({ code: 'skill-name-missing' });
  if (!description) findings.push({ code: 'skill-description-missing' });
  if ((name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) || name?.length > 64) {
    findings.push({ code: 'skill-name-invalid', field: 'name' });
  }
  if (description?.length > 1024) findings.push({ code: 'skill-description-invalid', field: 'description' });
  if (fields.compatibility !== undefined
    && (!stringField(fields.compatibility) || fields.compatibility.length > 500)) {
    findings.push({ code: 'skill-compatibility-invalid', field: 'compatibility' });
  }
  if (fields.license !== undefined && !stringField(fields.license)) {
    findings.push({ code: 'skill-license-invalid', field: 'license' });
  }
  if (fields['allowed-tools'] !== undefined && !stringField(fields['allowed-tools'])) {
    findings.push({ code: 'skill-allowed-tools-invalid', field: 'allowed-tools' });
  }
  if (fields.metadata !== undefined && !stringMap(fields.metadata)) {
    findings.push({ code: 'skill-metadata-invalid', field: 'metadata' });
  }
  for (const field of Object.keys(fields).filter((field) => !STANDARD_FIELDS.has(field)).sort()) {
    findings.push({ code: 'skill-frontmatter-field-nonstandard', field });
  }
  return result(true, name, description, findings);
}

function result(frontmatterPresent, name, description, standardFindings) {
  return { frontmatterPresent, name, description, standardFindings };
}

function stringField(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'string');
}

module.exports = { parseSkillMetadata };
