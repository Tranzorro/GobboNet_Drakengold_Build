# Session continuity memory

## What was happening
Long-running chats were depending on a single rolling summary and a few system blocks. That kept prompt size manageable, but it could still forget key facts, lose continuity across reloads, and allow the model to describe physically impossible sightlines because the prompt had no explicit geometry guardrail.

## What changed
- Added a per-thread `sessionMemory` list that is persisted with the rest of the thread state and survives reloads in the existing IndexedDB/localStorage pipeline.
- Automatically extracted continuity facts from recent turns and injected them into the prompt alongside the existing lore summary so the model keeps important details across a long session without blowing the active context.
- Added a spatial-awareness rule block to guide the model to prefer physically plausible anatomy, body position, and line-of-sight, while avoiding redundant mentions of impossible viewing constraints.
- Kept the existing lore compression and retrieval flow intact so the single-loaded-model setup still works without breaking the current project behavior.

## Tests
- `node tests/test-lore-compression.mjs`
- `node tests/test-lore-prompt.mjs`
