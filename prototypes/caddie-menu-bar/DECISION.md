# Caddie menu bar prototype decision

## Question

What is the smallest menu bar view that makes skill state, updates, active work, attention, sync controls, update policy, and agent review clear?

## Decision

Use Variant C, **Source view**, as the product direction.

The menu starts with registered sources. Each source shows its branch, skill count, state, and next action. Project Skills stay separate and read-only. Automatic update policy stays visible at the bottom. A blocked skill can open the user-led Codex or Claude handoff.

The other variants remain on this throwaway branch as the source record for the choice.
