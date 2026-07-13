# Define product and repository boundaries

Type: grilling
Status: resolved
Blocked by:

## Question

What responsibilities and durable artifacts belong respectively to the reusable Skill Manager repository, a user's Stack Repository, and an opted-in managed project?

## Answer

Caddie is a separate, standalone skill repository. Its `SKILL.md` is the agent-facing product, and its bundled scripts provide deterministic Git, validation, resolution, inspection, and reconciliation operations. It does not begin as a human-facing CLI, service, daemon, or multi-package application.

A Stack Repository contains the user's User Stack declaration, reusable and experimental skills they own, selected pinned upstream skills, and any durable semantic decisions. SreeStack is the first real Stack Repository managed by Caddie. It is a state and ownership boundary, not a UI boundary: Caddie may be invoked from any repository and still inspect or manage the wider registered portfolio. The working directory supplies the default focus.

An opted-in managed project commits its Project Stack declaration and owns only skills coupled to that project's domain or tooling. Reusable skills may remain owned by the Stack Repository even when initially enabled for one project. Caddie manages skill lifecycle, provenance, placement, rendering, updates, and retirement. When an approved management outcome requires creating or editing skill content, Caddie invokes the configured skill-authoring workflow and then manages its result.

Machine-specific discovery, such as the path to a user's Stack Repository and registered projects, may live outside Git; its exact shape remains for the declared-state and bootstrap tickets. Implementation should begin in a separate Caddie repository rather than temporarily placing Caddie under SreeStack. Repository creation waits until the Wayfinder map reaches its specification destination.
