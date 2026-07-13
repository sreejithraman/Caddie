# Design agent tool contracts

Type: grilling
Status: resolved
Blocked by: 03, 04, 05

## Question

What private deterministic operations, structured inputs and outputs, dry-run guarantees, authorization boundaries, and failure semantics does the Operator require from the Manager?

## Answer

Caddie exposes one agent-only Node entrypoint backed by internal modules. Its v1 operations are `locate`, `inspect`, `inspect-source`, `compare`, `plan`, `apply-plan`, and `recover`. Requests are versioned JSON on stdin; every operation emits exactly one versioned JSON envelope on stdout, uses exit status consistently, and reserves stderr for diagnostics. Stable error dispositions are `retry`, `replan`, `needs_user`, `needs_permission`, `invalid`, and `bug`.

Read, fetch, and analysis operations are autonomous. Caddie fetches current upstream metadata when freshness matters, changing only its disposable cache; network failure degrades to locked/local evidence with explicit staleness. Results include coverage metadata so inaccessible projects, permissions, or sources produce qualified partial findings rather than discarding useful evidence. Large results are bounded and prioritized, with stable pagination and hashed references to full deterministic evidence in the disposable cache.

Scripts return reproducible facts and candidate comparisons: paths, names, commits, hashes, fingerprints, references, diffs, and similarity evidence. Caddie's agent instructions own semantic interpretation such as rename, split, merge, changed purpose, lineage, or reusable improvement. Skill content is read and understood as the artifact being managed; when an approved outcome requires content changes, Caddie invokes the configured skill-authoring workflow—preferably in a focused subagent when available—then inspects and manages the result. Subagents are an optional isolation and focus mechanism, not a required runtime or sole trust boundary.

Every filesystem or Git mutation uses two phases. `plan` creates an immutable, content-addressed plan containing exact effects, preconditions, and postconditions. After user approval, `apply-plan` may execute only that exact plan, revalidates all preconditions, performs the scope transaction, and verifies postconditions. `recover` only inspects interrupted state and creates an exact finish-or-rollback plan; it does not mutate directly. The Operator receives no arbitrary low-level delete or move operation.

Approval binds to immutable commits, tree fingerprints, and content hashes. A remote branch advancing does not invalidate an approved exact plan, but changed local state, unavailable or mismatched content, incompatible protocol/tool versions, or changed Git preconditions return `replan`. Requests, results, manifests, locks, and plans carry explicit compatible versions; persistent format migration itself requires an approved plan.
