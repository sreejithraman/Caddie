#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function fingerprintDirectory(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${relative}\0`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) hash.update(fs.readFileSync(absolute));
      else fail(`Unsupported entry in Caddie Skill: ${relative}`);
    }
  };
  visit(root);
  return `sha256:${hash.digest('hex')}`;
}

const [sourceRoot, commit, repository] = process.argv.slice(2);
if (!sourceRoot || !/^[0-9a-f]{40}$/i.test(commit || '') || !repository) {
  fail('Usage: bootstrap.cjs <source-root> <exact-commit> <repository>');
}

const sourceSkill = path.join(path.resolve(sourceRoot), '.agents', 'skills', 'caddie');
const skillFile = path.join(sourceSkill, 'SKILL.md');
if (!fs.existsSync(skillFile) || !/^---[\s\S]*?\nname:\s*caddie\s*$/m.test(fs.readFileSync(skillFile, 'utf8'))) {
  fail('The pinned source does not contain a valid Caddie Skill.');
}

const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const caddieHome = path.join(configHome, 'caddie');
const userHome = path.join(caddieHome, 'user');
const canonical = path.join(userHome, '.agents', 'skills');
const destination = path.join(canonical, 'caddie');
const claude = path.join(userHome, '.claude');

for (const protectedPath of [
  path.join(userHome, 'caddie.json'),
  path.join(userHome, 'caddie.lock'),
  destination,
]) {
  if (fs.existsSync(protectedPath)) fail(`Bootstrap preserves existing state: ${protectedPath}`);
}

fs.mkdirSync(canonical, { recursive: true });
fs.cpSync(sourceSkill, destination, { recursive: true, errorOnExist: true, force: false });
fs.mkdirSync(claude, { recursive: true });
const exposure = path.join(claude, 'skills');
if (fs.existsSync(exposure)) fail(`Bootstrap preserves existing harness exposure: ${exposure}`);
fs.symlinkSync('../.agents/skills', exposure, 'dir');

const source = { type: 'git', url: repository, ref: commit };
writeJson(path.join(userHome, 'caddie.json'), {
  version: 1,
  scope: 'user',
  sources: { caddie: source },
  selections: [{ source: 'caddie', path: '.agents/skills/caddie' }],
});
writeJson(path.join(userHome, 'caddie.lock'), {
  version: 1,
  sources: { caddie: { url: repository, commit } },
});
writeJson(path.join(userHome, '.agents', '.caddie', 'ledger.json'), {
  version: 1,
  materialized: {
    caddie: {
      source: 'caddie',
      selectedPath: '.agents/skills/caddie',
      fingerprint: fingerprintDirectory(destination),
    },
  },
  exposures: { claude: '.claude/skills' },
});
writeJson(path.join(caddieHome, 'config.json'), {
  version: 1,
  userManifest: path.join(userHome, 'caddie.json'),
  registeredProjects: [],
});

process.stdout.write(`${userHome}\n`);

