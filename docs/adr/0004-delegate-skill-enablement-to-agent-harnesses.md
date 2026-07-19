# ADR 0004: Delegate Skill Enablement to Agent Harnesses

## Status

Accepted

## Context

Users need to keep a Skill Selection installed and updateable while temporarily preventing Agent Harnesses from exposing it. Codex and Claude Code already provide native availability controls, but their configuration shapes and scopes differ. Mirroring every harness-specific mode in the Caddie Manifest would make Caddie responsible for invocation policy it does not own.

## Decision

Each Skill Selection may declare one optional boolean, `enabled`. Omission is equivalent to `true`.

When `enabled` is `false`, Caddie retains the selection, resolution, materialization, and compatibility exposure, then delegates disablement to native harness configuration. Codex receives a path-bound `[[skills.config]]` entry with `enabled = false`. Claude Code receives `skillOverrides[<name>] = "off"` in user or project settings as appropriate.

When `enabled` is `true`, Caddie imposes no disablement and removes only the native settings recorded as Caddie-owned in the Caddie Ledger. Existing external settings are preserved; collisions and changes to owned settings require review and replanning. Caddie does not normalize richer harness-specific invocation modes.

## Consequences

A selected skill can be disabled without becoming absent or stale. The Caddie Manifest stays portable and intentionally less expressive than individual harness configuration. Availability is ultimately interpreted by each harness, so harness restart or reload behavior remains native to that harness. Caddie must maintain small, ownership-aware adapters for supported harness settings.
