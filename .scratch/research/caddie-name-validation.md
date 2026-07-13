# Caddie name validation

Checked 2026-07-12. This is preliminary naming diligence, not legal advice or a comprehensive trademark clearance search.

## Recommendation

**Replace `Caddie` as the unqualified public product and repository name.** The name has a direct, active collision: [`Portauw/caddie`](https://github.com/Portauw/caddie) describes itself as a “Skill profile manager for AI coding agents” and manages skills across Claude Code, OpenCode, and other harnesses. It was created 2026-03-18 and pushed as recently as 2026-06-16 when checked. This is the same audience, vocabulary, and core job as the proposed product, so qualification in documentation would not cure repository, command, or search confusion.

If preserving the metaphor matters, **`Stackcaddie`** is the best provisional qualified candidate found in this pass. Use the product/repository spelling `stackcaddie`, a skill directory/name such as `stackcaddie`, and—if Node bootstrap packaging is chosen—a scoped package such as `@<owner>/stackcaddie` rather than relying on an unscoped package. Do not reserve or publish anything until the product owner chooses the name and a proper legal clearance is performed.

## Blocking conflicts

- **Exact category collision:** [`github.com/Portauw/caddie`](https://github.com/Portauw/caddie) is an active public skill-profile manager for AI coding agents. Its public description and launch material describe repositories, a namespaced skill inventory, profiles, project bindings, and symlinking selected skills into place. This makes unqualified `Caddie` misleading even if a particular GitHub organization could create a repository with that name.
- **Bootstrap namespaces already occupied:** exact unscoped [`npm:caddie`](https://www.npmjs.com/package/caddie), [`PyPI:caddie`](https://pypi.org/project/caddie/), and [`RubyGems:caddie`](https://rubygems.org/gems/caddie) exist. Their products are unrelated, but commands such as `npx caddie` or `pipx install caddie` cannot identify this project.

## Ordinary name noise

- GitHub's exact/name search contains many unrelated `caddie` repositories (golf, causal inference, bots, and data tools). That noise alone would be manageable; the same-category `Portauw/caddie` result is not.
- General search is crowded by golf products and multiple AI products: [Caddie GTM Agent](https://www.caddieagent.ai/), [Caddie AI agile assistant](https://www.caddieagent.com/), [Kreo Caddie](https://www.kreo.net/), and [Tiber Caddie AI](https://www.tibersolutions.com/products/caddie-ai). “Caddie AI” therefore has poor distinctiveness and searchability.
- Adjacent agent-skill tooling is already dense and plainly named, including [`jtianling/skills-manager`](https://github.com/jtianling/skills-manager), [`luongnv89/asm`](https://github.com/luongnv89/asm), and [SkillsGate](https://skillsgate.ai/). A distinctive qualified name is more useful than another generic “skill manager” label.

## Exact namespaces checked

| Namespace/query | Result on 2026-07-12 |
|---|---|
| GitHub repositories, [`caddie in:name`](https://github.com/search?q=caddie+in%3Aname&type=repositories) | Many results; direct category collision at `Portauw/caddie` |
| npm unscoped [`caddie`](https://registry.npmjs.org/caddie) | Occupied; web framework, latest reported as `0.3.1` |
| PyPI [`caddie`](https://pypi.org/pypi/caddie/json) | Occupied; causal-inference package, `0.1.6` |
| RubyGems [`caddie`](https://rubygems.org/api/v1/gems/caddie.json) | Occupied; market-data Rails engine, `0.2.5` |
| GitHub repositories, [`stackcaddie in:name`](https://github.com/search?q=stackcaddie+in%3Aname&type=repositories) | 0 repositories via GitHub API |
| npm unscoped [`stackcaddie`](https://registry.npmjs.org/stackcaddie) | HTTP 404 |
| PyPI [`stackcaddie`](https://pypi.org/pypi/stackcaddie/json) | HTTP 404 |

Registry 404s and zero search results are observations, not reservations or guarantees of availability. npm name normalization and future changes also mean availability must be rechecked immediately before publication.

## Trademark boundary

The term has substantial software-related trademark noise, including a registered **CADDY** mark for access-server software (USPTO serial 87484266, surfaced through [Justia's record](https://trademarks.justia.com/874/84/caddy-87484266.html)). That record is not, by itself, a conclusion that this product infringes or cannot register its name. The direct marketplace conflict is already enough to reject unqualified `Caddie` without making a legal claim.

The [USPTO explains](https://www.uspto.gov/trademarks/search/federal-trademark-searching) that similarity and related goods/services both matter, and that a federal database search is only one part of comprehensive clearance. Before adopting `Stackcaddie` or any replacement commercially, search federal and state records, common-law internet use, confusing spellings (including `caddy`), and relevant international markets with qualified counsel.

## Practical naming options

1. **Preferred provisional path:** rename the product and repository to `stackcaddie`; use a scoped bootstrap namespace such as `@<owner>/stackcaddie` if a package is needed.
2. **Safer long-term path:** generate and clear a more distinctive coined name, then keep “your stack’s caddie” only as positioning copy.
3. **Do not use:** public repo `caddie`, binary/command `caddie`, unscoped packages named `caddie`, or “Caddie AI.”

`Stackcaddie` passed only the narrow GitHub/npm/PyPI checks above. It still needs ecosystem-wide and legal clearance before final adoption.
