# Caddie

Caddie manages agent skills across a user's shared environment and registered projects while preserving ownership, provenance, and local work.

## Product

**Caddie**:
The Agent App as a whole, combining a conversational skill, deterministic tooling, and durable skill-management state.
_Avoid_: Skill package manager, Caddie CLI

**Caddie Skill**:
The conversational agent interface that understands user intent and skill semantics, presents choices, and directs Caddie operations.
_Avoid_: Operator, meta skill, manager skill

**Caddie Tool**:
The deterministic engine the Caddie Skill uses to gather evidence and execute exact operations.
_Avoid_: Installer, package manager, CLI

**Bootstrap**:
The one-time action that makes the Caddie Skill available and hands its installation into normal Caddie self-management.
_Avoid_: Setup wizard, installation workflow

## Skills and projects

**Skills Repository**:
A Git repository containing one or more agent skills for authoring, distribution, or both.
_Avoid_: Stack Repository, package registry, skills folder

**Registered Project**:
A project Caddie knows about and can include in focused or bird's-eye inspection. Registration does not imply that the project declares Project Skills.
_Avoid_: Portfolio entry, tracked repository

**User Skills**:
The skills a user makes available across projects through a user-scoped Caddie Manifest.
_Avoid_: User Stack, global skills, default install

**Project Skills**:
The skills a project adds to User Skills through its project-scoped Caddie Manifest.
_Avoid_: Project Stack, local skills, project install

**Available Skills**:
The skills Caddie makes available for a particular project after combining user and project scope.
_Avoid_: Effective Stack, merged skills, installed skills

**Bird's-eye View**:
A live Caddie assessment spanning User Skills and all Registered Projects, regardless of the project from which Caddie is invoked.
_Avoid_: Portfolio, dashboard, snapshot

## Declared and resolved state

**Caddie Manifest**:
A versioned declaration of desired skill sources and selections at user or project scope.
_Avoid_: Configuration file, skills list

**Caddie Lock**:
A generated record of the exact external source revisions resolved for a Caddie Manifest.
_Avoid_: Install state, cache index

**Skill Source**:
A named local or remote origin from which Caddie can select skills.
_Avoid_: Package, registry

**Skill Selection**:
A choice of one skill directory from a Skill Source for inclusion at a scope.
_Avoid_: Dependency, package install

**Lineage**:
The declared or inferred semantic ancestry between a skill and one or more originating skills.
_Avoid_: Copy history, fork metadata

## Installation and ownership

**Canonical Skills Directory**:
The complete skill directories for a scope that Caddie makes available to supported agents.
_Avoid_: Source repository, skill cache

**In-place Skill**:
A project-owned skill whose authoring location is also its location in the project's Canonical Skills Directory.
_Avoid_: Materialized Skill, unmanaged skill

**Materialized Skill**:
A complete skill directory Caddie copies from a Skill Source into a Canonical Skills Directory and owns there.
_Avoid_: In-place Skill, vendored skill, symlinked skill

**Caddie Ledger**:
The machine-local record of Materialized Skills and agent links Caddie owns, including their last reconciled state.
_Avoid_: Caddie Lock, manifest, inventory

**Adoption**:
The preservation-first process of bringing an existing skill installation under Caddie ownership.
_Avoid_: Import, reinstall, takeover

**Unmanagement**:
The process of ending Caddie ownership while preserving installed skills and agent access by default.
_Avoid_: Uninstall, delete, cleanup

## Change interpretation

**Upstream Change**:
A change in a selected skill's source after the currently resolved revision.
_Avoid_: Drift, local modification

**Drift**:
A change in a Materialized Skill since Caddie last reconciled it that is not explained by its source.
_Avoid_: Upstream Change, update

**Divergence**:
The state in which a Skill Source and its Materialized Skill have changed differently since their last reconciliation.
_Avoid_: Drift, merge conflict

**Migration Proposal**:
An evidence-backed interpretation of an upstream identity or behavior change that presents choices without changing managed state.
_Avoid_: Caddie Plan, automatic migration, update

**Migration Record**:
A durable narrative explaining an accepted semantic interpretation that would be expensive to reconstruct.
_Avoid_: Migration log, changelog entry

## Change execution

**Caddie Plan**:
An immutable proposal of exact effects and required conditions that can be approved for execution.
_Avoid_: Migration Proposal, shell script, intent

**Change Set**:
One approved Caddie outcome coordinated across one or more owning repositories.
_Avoid_: Caddie Plan, umbrella PR, batch update

**Change Sandbox**:
An isolated temporary copy used to prepare an approved content change when its owning location is not Git-backed.
_Avoid_: Worktree, backup
