# Release Verification drafts

`record.structure.schema.json` checks the JSON shape only. It cannot prove a release or allow live User Skill reconciliation.

Run `npm run verify:record -- <record.json>` to apply the authoritative draft rules. Those rules keep every record in draft status and keep live reconciliation ineligible.
