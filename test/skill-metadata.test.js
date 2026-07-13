'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSkillMetadata } = require('../.agents/skills/caddie/tool/src/skill-metadata');

test('one metadata parser handles LF, CRLF, and quoted values consistently', () => {
  assert.deepEqual(parseSkillMetadata('---\nname: plain\ndescription: text\n---\n'), {
    frontmatterPresent: true,
    name: 'plain',
    description: 'text',
    standardFindings: [],
  });
  assert.deepEqual(parseSkillMetadata('---\r\nname: "quoted-skill"\r\ndescription: \'quoted text\'\r\n---\r\n'), {
    frontmatterPresent: true,
    name: 'quoted-skill',
    description: 'quoted text',
    standardFindings: [],
  });
  assert.deepEqual(parseSkillMetadata('No frontmatter.'), {
    frontmatterPresent: false,
    name: null,
    description: null,
    standardFindings: [{ code: 'skill-frontmatter-missing' }],
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
        { code: 'skill-frontmatter-field-nonstandard', field: 'owner' },
      ],
    },
  );
});
