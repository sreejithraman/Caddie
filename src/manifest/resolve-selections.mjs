import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { invalid } from '../protocol/errors.mjs';

export async function resolveSelections(manifest) {
  const resolved = [];
  for (const selection of manifest.skills) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
      throw invalid('invalid-skill-selection', 'Every Skill Selection must be an object', { manifestPath: manifest.manifestPath });
    }
    const source = manifest.sources[selection.source];
    if (!source) {
      throw invalid('unknown-source', `Unknown Skill Source: ${String(selection.source)}`, {
        manifestPath: manifest.manifestPath, source: selection.source ?? null,
      });
    }
    if (typeof selection.path !== 'string' || !selection.path) {
      throw invalid('invalid-selection-path', 'Every Skill Selection must have a path', { manifestPath: manifest.manifestPath });
    }
    const skillPath = path.resolve(source.path, selection.path);
    const relative = path.relative(source.path, skillPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw invalid('selection-outside-source', 'Skill Selection path escapes its Skill Source', {
        manifestPath: manifest.manifestPath, source: source.name, path: selection.path,
      });
    }
    const skillFile = path.join(skillPath, 'SKILL.md');
    let content;
    try {
      content = await readFile(skillFile, 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT') {
        throw invalid('skill-file-missing', `Selected skill has no SKILL.md: ${skillPath}`, { skillPath });
      }
      throw cause;
    }
    const name = extractSkillName(content, skillFile);
    resolved.push({
      name,
      scope: manifest.scope,
      source: source.name,
      selectedPath: selection.path,
      skillPath,
      skillFile,
    });
  }
  return resolved;
}

export function extractSkillName(content, skillFile = 'SKILL.md') {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!frontmatter) throw invalid('skill-frontmatter-missing', `SKILL.md has no YAML frontmatter: ${skillFile}`, { skillFile });
  const nameLine = frontmatter[1].split(/\r?\n/).find((line) => /^name\s*:/.test(line));
  if (!nameLine) throw invalid('skill-name-missing', `SKILL.md frontmatter has no name: ${skillFile}`, { skillFile });
  let name = nameLine.replace(/^name\s*:\s*/, '').trim();
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) name = name.slice(1, -1);
  if (!name) throw invalid('skill-name-missing', `SKILL.md frontmatter has an empty name: ${skillFile}`, { skillFile });
  return name;
}
