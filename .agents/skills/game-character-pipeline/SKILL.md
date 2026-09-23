---
name: game-character-pipeline
description: Prepare and integrate animated 3D characters for this mini-game using its established four-view, Hunyuan, Mixamo, Blender, and 1K WebP/Meshopt GLB workflow. Use for character image prompts and naming, view splitting, model conversion or optimization, animation merging and deformation diagnosis, pipeline artifact checks, and replacing procedural game characters; do not use for unrelated 3D props or gameplay-only work.
---

# Game Character Pipeline

Work from the repository root and continue from the latest valid artifact instead of restarting completed stages. Inspect filenames and model metadata before deciding what the user must do next.

Use a short lowercase character slug such as `bug` or `ppt`. Preserve existing player exceptions (`four_only_45mod.png` and `ksman_*`) rather than renaming them mechanically.

## Route the work

- Read [references/pipeline.md](references/pipeline.md) when preparing prompts, splitting views, using Hunyuan or Mixamo, converting files, or optimizing a model.
- Read [references/runtime-integration.md](references/runtime-integration.md) only when the optimized GLB is ready to be registered or validated in the game.
- Read the project case note [角色动画调优经验](../../../docs/角色动画调优经验.md) when merging additional clips or diagnosing wrist pinching, forearm twist, or similar skinning deformation. It records the Shoot wrist case, reproducible export option, and regression checks. Establish whether source poses, retargeting, compression, or skinning caused the symptom before applying a correction; the case's 50% twist sharing is asset-specific.

## Invariants

- Generate one horizontal four-view image in this order: front, left-front 45 degrees, right-front 45 degrees, back.
- Use Hunyuan's `50K` geometry option unless the user deliberately chooses a different quality target.
- For the first self-contained Walk model, Mixamo uses `In Place` and downloads `FBX Binary` with `With Skin`.
- Ship only the optimized `<slug>_walk_1k_meshopt.glb`; keep large intermediate PNG, GLB, and FBX artifacts ignored unless the user asks to track them.
- Preserve the animation name `Walk`, cap textures at 1024 px in WebP, and use Meshopt compression.
- Treat visual height and collision radius as separate gameplay choices. Do not infer one directly from the other.

Hunyuan and Mixamo are manual checkpoints unless the user explicitly authorizes browser interaction. At a checkpoint, state the exact upload/download settings and the expected next filename, then stop that stage without claiming completion.

Do not mark the character complete until the optimized model loads, its animation is recognized, multiple instances behave independently when applicable, `npm run build` passes, and the user has a clear in-game visual verification step.
