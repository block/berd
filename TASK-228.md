# Issue #228 — Recency-based model ordering in the picker

## Goal
Models the user picks rise in the model picker's ordering, learned from actual
use (reporter explicitly approved learned ordering). Current-model-pin and
provider grouping behavior are preserved. No settings UI, no sync, no manual
ordering.

## Design
- New module `src/features/chat/lib/modelRecency.ts` (pattern mirrors
  `src/features/settings/lib/autoArchivePreference.ts`):
  - localStorage key `berd:model-recency-v1`, JSON object keyed by
    `agentId/providerId/modelId` → epoch ms of last selection.
  - `recordModelSelection(agentId, model: {id, providerId?})` — upsert
    timestamp, prune to newest 50 entries, dispatch change event.
  - `useModelRecency(): ModelRecencyMap` via `useSyncExternalStore`
    (subscribe to change event + `storage`); SSR snapshot = empty map.
  - `getModelRecencyRank(map, agentId, model)` → timestamp or null, accepting
    both exact `providerId` key and legacy/providerless keys
    (`agentId//modelId`, any `agentId/*/modelId`).
  - All storage access try/catch; corrupt JSON treated as empty.
- `AgentModelPickerLists.tsx`:
  - `RecommendedModelList` reads `useModelRecency()`, passes map into
    `sortModels`; comparator order becomes: current pin → recency (never-used
    last) → provider label → sortOrder → display name.
  - Recommended shortlist gains recently-used models (`RECENT_MODEL_LIMIT = 3`,
    deduped) ahead of harness recommendations, preserving the
    current-model prepend.
- `AgentModelPicker.tsx`: `handleModelSelect` records selection via
  `recordModelSelection(selectedAgentId, model)` before `onModelChange`.
  (Single chokepoint — covers ChatInputToolbar and GlobalComposerPill paths.)

## Files
1. NEW `src/features/chat/lib/modelRecency.ts`
2. NEW `src/features/chat/lib/__tests__/modelRecency.test.ts`
3. EDIT `src/features/chat/ui/AgentModelPickerLists.tsx`
4. EDIT `src/features/chat/ui/AgentModelPicker.tsx`
5. EDIT `src/features/chat/ui/__tests__/AgentModelPicker.test.tsx` (add cases)

## Validation
`pnpm vitest run` on touched tests, `just check`, `just test`.
