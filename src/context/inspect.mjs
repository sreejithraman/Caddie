import { locate } from './locate.mjs';
import { parseManifest } from '../manifest/parse-manifest.mjs';
import { resolveSelections } from '../manifest/resolve-selections.mjs';
import { invalid } from '../protocol/errors.mjs';

export async function inspect(input, runtime = {}) {
  const context = await locate(input, runtime);
  const scopes = { user: scopeEvidence(context.user), project: scopeEvidence(context.project) };
  const availableSkills = [];

  for (const scope of ['user', 'project']) {
    const located = context[scope];
    if (located.status !== 'found') continue;
    let manifest;
    try {
      manifest = await parseManifest(located.manifestPath, scope);
    } catch (error) {
      if (error?.code !== 'unsupported-manifest-version') throw error;
      scopes[scope] = {
        status: 'unsupported',
        manifestPath: located.manifestPath,
        ...error.details,
      };
      context.coverage.status = 'partial';
      context.coverage.issues.push({
        scope,
        code: error.code,
        path: located.manifestPath,
        supported: error.details.supported,
        received: error.details.received,
      });
      continue;
    }
    const skills = await resolveSelections(manifest);
    scopes[scope] = {
      status: 'inspected',
      manifestPath: manifest.manifestPath,
      manifestVersion: manifest.manifestVersion,
      skills,
    };
    availableSkills.push(...skills);
  }

  const byName = new Map();
  for (const skill of availableSkills) {
    const previous = byName.get(skill.name);
    if (previous) {
      throw invalid('skill-name-collision', `Available Skill name collision: ${skill.name}`, {
        name: skill.name,
        selections: [previous, skill],
      });
    }
    byName.set(skill.name, skill);
  }

  const result = {
    focus: { cwd: input.cwd ?? runtime.cwd ?? process.cwd(), projectRoot: context.project.root },
    scopes,
    availableSkills,
    registry: context.registry,
    coverage: context.coverage,
  };
  if (input.birdseye === true) result.birdseye = await inspectBirdseye(input, runtime, context);
  return result;
}

function scopeEvidence(located) {
  return { status: 'missing', manifestPath: located.manifestPath };
}

async function inspectBirdseye(input, runtime, context) {
  const focusedRoot = context.project.root;
  const roots = [...context.registry.registeredProjects];
  roots.sort((left, right) => {
    if (left === focusedRoot) return -1;
    if (right === focusedRoot) return 1;
    return left.localeCompare(right);
  });
  const projects = [];
  for (const root of roots) {
    const evidence = await inspect({ ...input, cwd: root, projectManifestPath: undefined, birdseye: false }, runtime);
    projects.push({
      root,
      focus: root === focusedRoot,
      scopes: evidence.scopes,
      availableSkills: evidence.availableSkills,
      coverage: evidence.coverage,
    });
  }
  return {
    projects,
    usageEvidence: 'not-inspected',
    coverage: {
      status: projects.some((project) => project.coverage.status !== 'complete') ? 'partial' : 'complete',
      issues: projects.flatMap((project) => project.coverage.issues.map((issue) => ({ root: project.root, ...issue }))),
    },
  };
}
