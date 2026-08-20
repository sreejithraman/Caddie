# Caddie

Caddie manages agent skills across a user's shared environment and registered projects while preserving ownership, provenance, and local work.

This repository context defines the domain language for designing, implementing, and reviewing Caddie.

## Product

**Caddie**:
The Agent App as a whole, combining a conversational skill, deterministic tooling, and durable skill-management state.
_Avoid_: Skill package manager, Caddie CLI

**Caddie Skill**:
The conversational agent interface that understands user intent and skill semantics, presents choices, and invokes the app-owned Caddie Tool through the Tool Launch Record.
_Avoid_: Operator, meta skill, manager skill

**Caddie Tool**:
The deterministic engine, shipped with the Caddie Mac App, that gathers evidence and executes exact operations for the Caddie Skill and app.
_Avoid_: Installer, package manager, CLI

**Tool Launch Record**:
A versioned app-owned binding to the active and last-good private Node and Caddie Tool artifacts that the Caddie Skill and Mac App may execute.
_Avoid_: PATH setting, launcher script, app preference

**Caddie Mac App**:
The required native macOS menu bar app that owns Caddie installation, release activation, local event triggers, status, attention, and notifications while directing deterministic work to the Caddie Tool.
_Avoid_: Caddie desktop app, daemon, Caddie Core

**Caddie Release**:
A signed compatible set containing the Caddie Mac App, its private Node runtime, the Caddie Tool, and the source Caddie Skill that the Tool reconciles into User Skills. Homebrew, direct download, and app updates use the same release.
_Avoid_: Independent component update, Tool package, Skill release

**Agent Harness**:
An application or runtime that discovers skills and hosts agent work, such as Codex or Claude Code.
_Avoid_: Agent, model, skill

**Agent Handoff**:
An explicit user action that opens unresolved Attention in a chosen Agent Harness with a filled request and an exact readable work folder for review and action.
_Avoid_: Agent launch, account link, autonomous repair

**Bootstrap**:
The preservation-first first launch that activates a compatible Tool and makes the Caddie Skill available while adopting any existing Caddie state in place.
_Avoid_: Setup wizard, installation workflow, repair command

**App Removal**:
Stopping and removing the Caddie Mac App and its login item while preserving the Caddie Skill, last-good Tool, managed skills, and every user or project Caddie State Root.
_Avoid_: Unmanagement, Caddie erasure, uninstalling skills

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
The skills Caddie makes available for a particular project after combining user and project scope. A same-named Project Skill shadows its User Skill; Caddie retains evidence of both selections.
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

**Caddie State Root**:
The fixed directory containing a scope's Caddie Manifest, Caddie Lock, Caddie Ledger, and recovery state: `~/.agents/.caddie` for User Skills and `<project>/.agents/.caddie` for Project Skills.
_Avoid_: Configuration home, Skills Repository

**Caddie Registry**:
The user-scoped record of Registered Projects stored in the User Caddie State Root.
_Avoid_: Machine configuration, project manifest

**Skill Source**:
A named local or remote origin from which Caddie can select skills.
_Avoid_: Package, registry

**Skill Selection**:
A choice of one skill directory from a Skill Source for inclusion at a scope.
_Avoid_: Dependency, package install

**Skill Enablement**:
The Caddie Manifest declaration controlling whether a Skill Selection is exposed by Agent Harnesses. Omitted and `true` mean enabled; `false` retains the selection and installation while requesting harness-native disablement.
_Avoid_: Uninstall, deselection, invocation policy

**Invocation Policy**:
An optional cross-harness declaration on a Skill Selection that controls whether
an Agent Harness may choose the skill implicitly. `user-only` keeps explicit
user invocation available while disabling implicit model invocation.
_Avoid_: Claude flag, Codex flag, trigger override

**Lineage**:
The declared or inferred semantic ancestry between a skill and one or more originating skills.
_Avoid_: Copy history, fork metadata

## Installation and ownership

**Canonical Skills Directory**:
The cross-client skill root containing complete directories: `~/.agents/skills` for User Skills and `<project>/.agents/skills` for Project Skills.
_Avoid_: Source repository, skill cache

**In-place Skill**:
A project-owned skill whose authoring location is also its location in the project's Canonical Skills Directory.
_Avoid_: Materialized Skill, unmanaged skill

**Materialized Skill**:
A complete skill directory Caddie copies from a Skill Source into a Canonical Skills Directory and owns there.
_Avoid_: In-place Skill, vendored skill, symlinked skill

**Caddie Ledger**:
The machine-local record of Materialized Skills, harness-specific links, and harness settings Caddie owns, including their last reconciled state.
_Avoid_: Caddie Lock, manifest, inventory

**Unmatched Ownership**:
Caddie Ledger ownership that has no matching current Skill Selection.
_Avoid_: Orphaned ownership, stale installation

**Adoption**:
The preservation-first process of bringing an existing skill installation under Caddie ownership.
_Avoid_: Import, reinstall, takeover

**Unmanagement**:
The process of ending Caddie ownership while preserving installed skills and harness access by default.
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

**Skill Rename**:
An explicit, one-to-one replacement of a Skill Selection that keeps its semantic identity under a new name within the same scope.
_Avoid_: Skill migration, inferred rename

## Change execution

**Reconciliation Authorization**:
A standing user grant that lets Caddie reconcile one User Skill without requesting approval for each eligible source change.
_Avoid_: Blanket approval, auto-update toggle

**Observation Hint**:
An app, file-system, or user event that tells Caddie to inspect relevant state without treating the event itself as evidence of a change.
_Avoid_: Source event, change proof, update trigger

**Local Source Inspection**:
A read-only assessment of registered local Skill Sources and related managed state. It may use local Git evidence but never contacts a remote or changes a repository.
_Avoid_: Poll, sync, fetch

**Attention**:
A durable record that Caddie could not complete or prove promised work for one Skill Selection, Skill Source, or its own runtime. A relevant state change or user review must resolve it.
_Avoid_: Alert, notification, generic error, pending update

**Ready Work**:
An exact eligible Caddie change that waits only for required user approval.
_Avoid_: Attention, blocked work, automatic update

**Activity**:
A bounded recent record of verified Caddie work or proof-based resolution that requires no user action.
_Avoid_: Attention, audit log, notification

**Reconciliation Pause**:
A user-requested or safety-triggered stop on all standing-authorized reconciliation. Inspection and explicitly approved Caddie work remain available.
_Avoid_: Removing Reconciliation Authorization, quitting Caddie, pausing app updates

**Release Verification Record**:
A bounded, private-data-safe account of the checks and observed results that qualify one exact signed Caddie Release to reconcile live User Skills.
_Avoid_: Test log, release notes, general approval

**Caddie Snapshot**:
A bounded Caddie Tool view of inspected skill state, Ready work, Attention, Activity, and freshness for callers to display or reason about.
_Avoid_: Dashboard state, app cache, Caddie Manifest

**Caddie Plan**:
An immutable proposal of exact effects and required conditions that can be approved for execution.
_Avoid_: Migration Proposal, shell script, intent
