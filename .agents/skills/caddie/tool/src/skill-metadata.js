'use strict';

function parseSkillMetadata(content) {
  if (typeof content !== 'string') throw new TypeError('SKILL.md content must be a string');
  const frontmatter = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!frontmatter) return {
    frontmatterPresent: false,
    name: null,
    description: null,
    standardFindings: [{ code: 'skill-frontmatter-missing' }],
  };

  const fields = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!match) continue;
    fields[match[1]] = unquote(match[2].trim());
  }
  const name = nonEmpty(fields.name);
  const description = nonEmpty(fields.description);
  const standardFindings = [];
  if (!name) standardFindings.push({ code: 'skill-name-missing' });
  if (!description) standardFindings.push({ code: 'skill-description-missing' });
  if ((name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) || name?.length > 64) {
    standardFindings.push({ code: 'skill-name-invalid', field: 'name' });
  }
  if (description?.length > 1024) standardFindings.push({ code: 'skill-description-invalid', field: 'description' });
  const standardFields = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (const field of Object.keys(fields).filter((field) => !standardFields.has(field)).sort()) {
    standardFindings.push({ code: 'skill-frontmatter-field-nonstandard', field });
  }
  return {
    frontmatterPresent: true,
    name,
    description,
    standardFindings,
  };
}

function unquote(value) {
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

module.exports = { parseSkillMetadata };
