import { cp, lstat, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { invalid } from './errors.mjs';

export async function prepareChangeSandbox(options) {
  const source = path.resolve(required(options.source, 'source'));
  if (typeof options.author !== 'function') throw invalid('author-required', 'A focused author function is required');
  if (typeof options.validate !== 'function') throw invalid('validation-required', 'A parent-owned validation function is required');
  const root = options.workspaceRoot
    ? path.resolve(options.workspaceRoot)
    : await mkdtemp(path.join(tmpdir(), 'caddie-sandboxes-'));
  await mkdir(root, { recursive: true });
  const directory = path.join(root, required(options.slug, 'slug'));
  const before = await inventory(source);
  await cp(source, directory, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
  await options.author({ directory, source });
  await options.validate({ directory, source });
  const after = await inventory(directory);
  const operations = diffInventories(before.files, after.files);
  if (!operations.length) throw invalid('empty-change', 'Authoring produced no focused change', { source });
  return {
    kind: 'sandbox',
    source,
    directory,
    sourceFingerprint: before.fingerprint,
    resultFingerprint: after.fingerprint,
    applyPlan: { version: 1, source, precondition: { fingerprint: before.fingerprint }, operations },
  };
}

async function inventory(root) {
  const files = new Map();
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isSymbolicLink()) {
        const stat = await lstat(absolute);
        files.set(relative, { kind: 'symlink', target: await import('node:fs/promises').then((fs) => fs.readlink(absolute)), mode: stat.mode & 0o777 });
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        const stat = await lstat(absolute);
        files.set(relative, { kind: 'file', sha256: createHash('sha256').update(content).digest('hex'), mode: stat.mode & 0o777 });
      }
    }
  }
  await visit(root);
  const serialized = JSON.stringify([...files.entries()]);
  return { files, fingerprint: createHash('sha256').update(serialized).digest('hex') };
}

function diffInventories(before, after) {
  const operations = [];
  for (const [file, state] of after) {
    if (JSON.stringify(before.get(file)) !== JSON.stringify(state)) operations.push({ type: 'write', path: file, ...state });
  }
  for (const file of before.keys()) if (!after.has(file)) operations.push({ type: 'delete', path: file });
  return operations.sort((a, b) => a.path.localeCompare(b.path));
}

function required(value, name) {
  if (typeof value !== 'string' || !value) throw invalid(`${name}-required`, `${name} is required`);
  return value;
}
