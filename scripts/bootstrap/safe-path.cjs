const fs = require('node:fs');
const path = require('node:path');

function assertSafeAncestorChain(anchor, candidate) {
  const resolvedAnchor = path.resolve(anchor);
  const candidateParent = path.dirname(path.resolve(candidate));
  const relative = path.relative(resolvedAnchor, candidateParent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Bootstrap destination escapes its fixed root: ${candidate}`);
  }

  // A populated path can hide a symlink in an ancestor even when lstat on the
  // final parent reports a directory. Walk from the fixed anchor explicitly.
  let current = resolvedAnchor;
  const anchorParts = [];
  while (!fs.lstatSync(current, { throwIfNoEntry: false })) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Bootstrap cannot resolve a real ancestor for: ${anchor}`);
    }
    anchorParts.push(path.basename(current));
    current = parent;
  }
  assertRealDirectory(current);
  for (const segment of [...anchorParts.reverse(), ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat) assertRealDirectory(current, stat);
  }
}

function assertRealDirectory(candidate, stat = fs.lstatSync(candidate)) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Bootstrap requires a real directory parent: ${candidate}`);
  }
}

module.exports = { assertSafeAncestorChain };
