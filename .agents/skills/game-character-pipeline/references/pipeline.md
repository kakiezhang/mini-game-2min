# Asset pipeline

## Determine the current stage

Use this sequence and resume at the first missing or invalid artifact:

| Stage | Expected artifact |
| --- | --- |
| Four-view source | `<slug>_four_only_45mod.png` |
| Split references | `<slug>_front.png`, `<slug>_left_front.png`, `<slug>_right_front.png`, `<slug>_back.png` |
| Hunyuan export | `<slug>.glb` |
| Mixamo upload | `<slug>_for_mixamo.fbx` |
| Mixamo download | `<slug>_walk.fbx` |
| Blender animation export | `<slug>_walk.glb` |
| Runtime asset | `<slug>_walk_1k_meshopt.glb` |

Inspect an artifact before trusting its name. If a user supplies an equivalent file under another name, confirm its contents and continue without forcing a rename unless the standardized name will prevent ambiguity.

## Four-view prompt and split

When writing an image prompt, inspect `four_only_45mod.png` and the latest approved character reference. Preserve the game's stylized low-poly proportions, materials, lighting, and visual density while expressing the new character concept. Ask for:

- exactly four full-body figures on one horizontal canvas;
- front, left-front 45 degrees, right-front 45 degrees, and back in that order;
- the same character, clothing, colors, proportions, and scale in every view;
- a relaxed symmetrical riggable stance, separated limbs, visible hands and feet;
- a plain light background, even studio lighting, and no text, labels, props, floor clutter, or cropped body parts.

Provide the prompt only when the user asks for a prompt. Generate an image only when explicitly requested.

The established source canvas is `1376x768`, with `400x768` crops centered evenly across it. Run:

```bash
.agents/skills/game-character-pipeline/scripts/split_four_view.sh <slug>_four_only_45mod.png <slug>
```

Then inspect all four outputs visually. Reject adjacent-character slivers, clipped limbs, mismatched views, or inconsistent backgrounds before sending anything to Hunyuan.

## Hunyuan checkpoint

Upload the four split references in semantic order and select the `50K` model geometry option. The existing player source has about 49,958 triangles and the Bug source about 50,000, so `50K` is the established game target. Export GLB as `<slug>.glb`.

Check that the output contains a textured mesh and is visually consistent before conversion. Large raw GLBs are expected intermediate artifacts and should remain ignored.

Convert it for Mixamo with Blender:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python .agents/skills/game-character-pipeline/scripts/convert_character.py -- \
  glb-to-fbx <slug>.glb <slug>_for_mixamo.fbx
```

If Blender lives elsewhere, locate its executable instead of modifying the script.

## Mixamo checkpoint

Upload `<slug>_for_mixamo.fbx`, complete the chin, wrist, elbow, knee, and groin markers, and verify the automatic rig preview. Select the Walk animation with:

- `In Place`: enabled;
- format: `FBX Binary`;
- skin: `With Skin` for the first self-contained animated model.

Download as `<slug>_walk.fbx`. Additional clips use `Without Skin` and the existing repository script `scripts/merge_character_animations.py` with the original skinned Walk FBX as their base. The final runtime GLB remains self-contained with one mesh/rig and multiple clips. For additional-clip rest-pose differences or wrist deformation, read [角色动画调优经验](../../../../docs/角色动画调优经验.md) and use the current multi-clip export command in the project README; the single-Walk conversion below does not preserve those additional clips or their corrections.

## Convert and optimize

Convert the Mixamo FBX and normalize the clip name:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python .agents/skills/game-character-pipeline/scripts/convert_character.py -- \
  fbx-to-glb <slug>_walk.fbx <slug>_walk.glb --animation-name Walk
```

Optimize it:

```bash
.agents/skills/game-character-pipeline/scripts/optimize_character.sh \
  <slug>_walk.glb <slug>_walk_1k_meshopt.glb
```

The optimization script pins glTF-Transform CLI 4.5.0, converts textures to WebP at a maximum of 1024 px, applies Meshopt, and prints an inspection report. It may need network approval when the pinned CLI is not cached locally.

Before integration, confirm:

- at least one skinned mesh and a skeleton exist;
- the report contains a `Walk` animation with nonzero duration;
- the animation does not translate the character across the ground;
- textures are WebP and no larger than 1024 px;
- Meshopt-compressed output loads successfully;
- triangle count remains near the selected Hunyuan target;
- the optimized size is materially below the raw animated GLB. Around 0.5-1.5 MB is a useful expectation for current characters, not a hard limit.
