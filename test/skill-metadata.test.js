'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSkillMetadata } = require('../skills/caddie/tool/src/skill-metadata');

test('one metadata parser handles LF, CRLF, and quoted values consistently', () => {
  assert.deepEqual(parseSkillMetadata('---\nname: plain\ndescription: text\n---\n'), {
    frontmatterPresent: true,
    name: 'plain',
    description: 'text',
    standardFindings: [],
    extensionFields: [],
  });
  assert.deepEqual(parseSkillMetadata('---\r\nname: "quoted-skill"\r\ndescription: \'quoted text\'\r\n---\r\n'), {
    frontmatterPresent: true,
    name: 'quoted-skill',
    description: 'quoted text',
    standardFindings: [],
    extensionFields: [],
  });
  assert.deepEqual(parseSkillMetadata('No frontmatter.'), {
    frontmatterPresent: false,
    name: null,
    description: null,
    standardFindings: [{ code: 'skill-frontmatter-missing' }],
    extensionFields: [],
  });
});

test('metadata diagnostics follow the Agent Skills frontmatter contract', () => {
  assert.deepEqual(
    parseSkillMetadata('---\nname: Bad_Name\nowner: someone\n---\n'),
    {
      frontmatterPresent: true,
      name: 'Bad_Name',
      description: null,
      standardFindings: [
        { code: 'skill-description-missing' },
        { code: 'skill-name-invalid', field: 'name' },
      ],
      extensionFields: ['owner'],
    },
  );
});

test('metadata uses YAML semantics for folded text, comments, and nested metadata', () => {
  assert.deepEqual(parseSkillMetadata(`---
name: yaml-skill # a YAML comment
description: >
  Use this skill when
  YAML matters.
metadata:
  author: Sree
---
`), {
    frontmatterPresent: true,
    name: 'yaml-skill',
    description: 'Use this skill when YAML matters.\n',
    standardFindings: [],
    extensionFields: [],
  });
});

test('client-specific extension fields are preserved without invalidating standard metadata', () => {
  assert.deepEqual(parseSkillMetadata(`---
name: extended-skill
description: Compatible upstream skill.
argument-hint: "<target>"
disable-model-invocation: true
---
`), {
    frontmatterPresent: true,
    name: 'extended-skill',
    description: 'Compatible upstream skill.',
    standardFindings: [],
    extensionFields: ['argument-hint', 'disable-model-invocation'],
  });
});

test('required and optional text fields reject whitespace-only YAML strings', () => {
  assert.deepEqual(
    parseSkillMetadata('---\nname: whitespace\ndescription: "   "\ncompatibility: "  "\n---\n').standardFindings,
    [
      { code: 'skill-description-missing' },
      { code: 'skill-compatibility-invalid', field: 'compatibility' },
    ],
  );
});
