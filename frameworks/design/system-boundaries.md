# System Boundaries

- Prefer smaller, focused units with one clear responsibility and a stable interface.
- A good boundary lets another engineer understand what a unit does without reading its internals.
- If two concerns can evolve independently, they should probably not live in the same unit.
- When working inside an existing codebase, follow established patterns unless the local boundary is already clearly harmful to the task.
- Improve only the area needed to support the current goal. Do not propose unrelated cleanup.
