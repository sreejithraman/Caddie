# Validate the Caddie name

Type: research
Status: resolved
Blocked by: 02

## Question

Is Caddie a viable public name across relevant Git hosting, package ecosystems, search results, trademarks, and adjacent agent tooling, and what repository and bootstrap names should follow from it?

## Answer

No: replace unqualified **Caddie** as the public name. An active [`Portauw/caddie`](https://github.com/Portauw/caddie) already performs essentially the same job—managing skill profiles and placement across AI coding agents—while the exact unscoped npm, PyPI, and RubyGems names are also occupied. This is a blocking identity and search conflict, not merely unrelated name noise.

Use **`stackcaddie`** only as a provisional qualified replacement: it had no GitHub repository-name result and returned 404 for the exact npm and PyPI namespaces when checked, but it remains unreserved and has not received legal clearance. If bootstrap eventually uses npm, prefer a scoped name such as `@<owner>/stackcaddie`.

Research and exact namespaces checked: [Caddie name validation](../research/caddie-name-validation.md).

## Owner decision

Keep **Caddie** as the unqualified product, repository, skill, and local configuration namespace despite the documented collision. Revisit only if concrete user confusion or interoperability problems emerge.
