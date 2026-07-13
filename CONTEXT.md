# SreeStack

SreeStack defines and reproduces a curated environment of authored and third-party agent skills.

## Language

**Skill Environment Manager**:
The deterministic part of SreeStack that maintains a declared skill environment.
_Avoid_: Installer, package manager

**SreeStack Operator**:
The agent-facing skill that interprets user intent and guides changes to a SreeStack environment.
_Avoid_: Meta skill, manager skill

**Stack Repository**:
A Git repository that declares a user's global skill environment and contains the skills they author.
_Avoid_: Dotfiles repository, skills folder

**User Stack**:
The skills a user makes available across repositories through their user-scoped Stack Manifest.
_Avoid_: Global Stack, user skills, default install

**Project Stack**:
A project's committed declaration of skills that supplement the User Stack.
_Avoid_: Local skills, project install

**Effective Stack**:
The resolved combination of the User Stack and a project's opted-in Project Stack.
_Avoid_: Merged skills, active install

**Migration Proposal**:
An evidence-backed, reviewable interpretation of upstream skill changes that has not yet altered the declared or installed environment.
_Avoid_: Automatic migration, update

**Operator Bootstrap**:
The minimal one-time action that makes the SreeStack Operator available to a user's agent harness.
_Avoid_: Installation workflow, setup wizard

**Agent App**:
A system whose primary user interface is an agent skill, supported by deterministic tools and durable repository artifacts.
_Avoid_: CLI application, interactive installer

**Caddie**:
The standalone Agent App that manages skill lifecycles and placements across a Stack Repository and its managed projects.
_Avoid_: Skill package manager, Caddie CLI

**Migration Record**:
A durable narrative artifact explaining an accepted interpretation of upstream skill changes, referenced by structured SreeStack state when needed.
_Avoid_: Migration log, changelog entry

**Stack Manifest**:
A versioned `caddie.json` declaration of desired skill state at either user or project scope.
_Avoid_: Configuration file, skills list

**Resolution Lock**:
A generated `caddie.lock` record of the exact sources and skill content resolved from a Stack Manifest.
_Avoid_: Install state, cache index

**Canonical Installation**:
The complete skill directories exposed to harnesses under a scope's `.agents/skills`; user-level entries are materialized, while Git-backed project-owned skills may live there in place.
_Avoid_: Source of truth, skill cache

**In-place Skill**:
A Git-backed, project-owned skill whose committed authoring source is also its directory in the project's Canonical Installation.
_Avoid_: Local copy, unmanaged skill

**Materialized Skill**:
A complete Caddie-owned skill directory copied from a declared source into a Canonical Installation.
_Avoid_: Vendored skill, symlinked skill

**Change Set**:
One approved Caddie outcome coordinated across one or more owning repositories and published in dependency-ordered waves when required.
_Avoid_: Umbrella PR, batch update

**Change Sandbox**:
An isolated temporary copy used to prepare an approved content change when the owning directory is not Git-backed.
_Avoid_: Worktree, backup
