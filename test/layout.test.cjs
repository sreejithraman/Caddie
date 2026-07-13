'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  runtimeUserCoordinationRoot,
  scopeMutationStateRoot,
  stateRoot,
} = require('../skills/caddie/tool/src/layout');

test('scope mutation state uses the canonical scope state root', () => {
  const scopeRoot = path.join(path.sep, 'tmp', 'project', '..', 'project');
  assert.equal(
    scopeMutationStateRoot(scopeRoot),
    stateRoot({ root: scopeRoot }),
  );
});

test('runtime user coordination state is anchored under the runtime home', () => {
  const home = path.join(path.sep, 'tmp', 'home', '..', 'home');
  assert.equal(
    runtimeUserCoordinationRoot(home),
    path.join(path.resolve(home), '.agents', '.caddie'),
  );
});
