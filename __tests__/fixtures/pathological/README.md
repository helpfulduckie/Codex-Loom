# The pathological fixture

These six projects are intentionally invalid. Their committed snapshot freezes the diagnostic code, severity, file, message, and order that each produces.

- `card-collision/` checks duplicate card names and conflicting card types.
- `placement/` checks placement, placeholder, component, and limit diagnostics after loading succeeds.
- `schema/` checks invalid configuration shapes that abort during loading.
- `snapshot-mismatch/` checks manifest/configuration and manifest/disk disagreement.
- `snapshot-corrupt/` checks a frozen file changed after its manifest was written; this error aborts before compilation.
- `unread-fields/` checks body fields no template reads, including per-item deduplication across branches.

## Execution boundaries

The projects are separate because failures occur at different compiler layers. A load error aborts before later diagnostics can run, while `placement/`, `snapshot-mismatch/`, and `unread-fields/` must compile far enough to expose their checks.

## Editing rules

- Author fixture changes from the intended behavior, not the implementation.
- Keep each deliberate mistake identifiable by the diagnostic it should raise.
- Do not turn a pathological project into an example or update its snapshot merely to match a compiler regression.
- Put item-schema errors in their unit tests: an item-level load error would prevent the fixture's later diagnostic stream from running.
