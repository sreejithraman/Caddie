'use strict';

function parseSkillMetadata(content) {
  if (typeof content !== 'string') throw new TypeError('SKILL.md content must be a string');
  const frontmatter = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!frontmatter) return { frontmatterPresent: false, name: null, description: null };

  const fields = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/);
    if (!match) continue;
    fields[match[1]] = unquote(match[2].trim());
  }
  return {
    frontmatterPresent: true,
    name: nonEmpty(fields.name),
    description: nonEmpty(fields.description),
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
