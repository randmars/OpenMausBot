# DEV-3388 OMB organization cutover

`dev-3388-org-v1.json` is a proposal manifest. It changes only these bot fields when explicitly applied:

- `section`
- `orgRole`
- `crossSectionPeers` (with the request-only acknowledgement `acknowledgePeerScope: true`)

It does not change names, descriptions, workspace instructions, `modelSelection`, approval grants, integrations, routines, groups, messages, or history. `Artie`, `Sui`, `Clod`, and the supervisor display names are preserved through manifest aliases; IDs remain the identity and rollback key.

The manifest records the runtime boundary: direct OMB Codex coordination-only read-only enforcement is verified in `server/drivers/codex.ts`; Hermes Agent v0.20.5 native coordination enforcement is unsupported and must fail closed. The optional direct-Codex profile patch is recorded separately under the canonical `org-workstream` artifact and requires an authorized isolated smoke proof. No command in this package changes a live model/provider.

## Read-only snapshot and dry run

Run from the OMB worktree. The command performs GETs only and writes review artifacts only when the two output flags are supplied:

```sh
node scripts/org-cutover.mjs \
  --manifest docs/org-cutover/dev-3388-org-v1.json \
  --base-url http://127.0.0.1:8799 \
  --snapshot /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-live-snapshot.json \
  --receipt /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-dry-run-receipt.json
```

The snapshot includes the targeted bot restore fields, model selections, approval/integration summaries, all routine IDs and enabled states, provider instance availability, model checks, busy blockers, and the `retiredRoutinesPreserved` receipt. It contains no credentials.

## Apply and rollback

Apply is intentionally opt-in and must follow the authorized review. The tool refuses to apply while any targeted bot is busy, snapshots before the first PATCH, verifies each response field, and leaves a receipt with restart still marked `not-run`:

```sh
node scripts/org-cutover.mjs \
  --manifest docs/org-cutover/dev-3388-org-v1.json \
  --base-url http://127.0.0.1:8799 \
  --snapshot /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-live-snapshot.json \
  --receipt /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-apply-receipt.json \
  --apply
```

Rollback uses the snapshot and is dry-run by default. It restores only the fields captured in `botSnapshots`; it never removes routines or history:

```sh
node scripts/org-cutover.mjs \
  --rollback /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-live-snapshot.json \
  --base-url http://127.0.0.1:8799 \
  --receipt /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-rollback-receipt.json

# Only after the rollback itself is approved:
node scripts/org-cutover.mjs \
  --rollback /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-workstream/omb-live-snapshot.json \
  --base-url http://127.0.0.1:8799 \
  --receipt /home/randy/src/hellm/.scratch/delivery-flow-repair-2026-09-06/org-cutover/org-rollback-apply-receipt.json \
  --apply
```

## Restart receipt

The mapped service is the user unit `openmausbot.service`, working from `/home/randy/Projects/OpenMausBot` via `/home/randy/.config/openmausbot/run.sh`. Do not restart companion, VM viewers, Hermes, or every user unit. After a separately approved apply, the exact restart and verification are:

```sh
systemctl --user restart openmausbot.service
systemctl --user show openmausbot.service --property=ActiveState,SubState,MainPID --no-pager
curl -fsS http://127.0.0.1:8799/api/health
```

The apply receipt records the command and verification command but never runs either one.

## Current overlap and readiness blockers

The bounded live read on 2026-09-07 found 14 routines: 11 enabled and 3 disabled. The active dispatcher overlapping the future hive controller is `c8503bdf-0b88-4251-87f4-eb207abf6948` (`Triage dispatch sweep (15 min)`, enabled, bot `66bc99b7-5f54-4932-bc84-7693a417db90`). The older duplicates remain disabled and are preserved: `5538f668-c595-4e3c-bc5b-a174d75672ab` and `f2dfea5d-c996-4e64-b9ba-8d4ede6b3fa2`. `331c48f1-ef2f-4d41-919d-40d54d9e0fb1` is the separate enabled Finish Merged→Done reconciliation routine and is not changed by this cutover. The exact IDs and schedule state are retained in the snapshot.

The deployed service currently returns no `section`, `orgRole`, or `crossSectionPeers` fields and reports Lynn busy. Therefore the current run is a dry-run/readiness artifact only. No apply or restart is ready until the updated OMB binary is deployed through its approved path and Lynn is idle.

Current role model checks requiring an authorized smoke proof before any fallback route is used:

- Missy and Lynn currently use `hermes / hermes-default`; Hermes native coordination enforcement is unsupported.
- Foundation, Product, Personal, Bestmates, Travel, Scuttlebutt, and Cotery also use Hermes defaults and require the same capability decision if assigned coordination-only roles.
- Roi and Sui use Claude; Artie uses direct Codex. Existing driver tests cover native restrictions, but a live post-cutover smoke proof is still required after the updated service is running.
- The proposed fallback is direct OMB Codex with `gpt-5.6-luna`, preserving each bot ID/history. It is recorded only as a requirement; the manifest and tool never select it.

No retired routine is removed, re-enabled, or rewritten. A narrow current organization-routing overlay is appended at prompt-build time for coordination roles; it preserves each bot's soul, transcript, description, workspace instructions, and history. The overlay is routing context only: native driver and backend capability checks enforce permissions.
