'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSkillMetadata } = require('../.agents/skills/caddie/tool/src/skill-metadata');

test('one metadata parser handles LF, CRLF, and quoted values consistently', () => {
  assert.deepEqual(parseSkillMetadata('---\nname: plain\ndescription: text\n---\n'), {
    frontmatterPresent: true,
    name: 'plain',
    description: 'text',
  });
  assert.deepEqual(parseSkillMetadata('---\r\nname: "quoted-skill"\r\ndescription: \'quoted text\'\r\n---\r\n'), {
    frontmatterPresent: true,
    name: 'quoted-skill',
    description: 'quoted text',
  });
  assert.deepEqual(parseSkillMetadata('No frontmatter.'), {
    frontmatterPresent: false,
    name: null,
    description: null,
  });
});
