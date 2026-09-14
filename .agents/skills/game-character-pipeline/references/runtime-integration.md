# Runtime integration

Follow the current code structure rather than recreating character-specific loaders.

## Register the asset

1. Add an explicit negated rule for the optimized root-level GLB in `.gitignore`; keep broad `*.glb` and `*.fbx` ignores for intermediate artifacts.
2. Add a config entry to `src/characters/catalog.ts` using `new URL("../../<slug>_walk_1k_meshopt.glb", import.meta.url).href`.
3. Set `height` from the intended in-game silhouette, not from the source model's native units.
4. Match the `Walk` clip with `/walk/i`. Use `idlePose` to freeze a reasonable point of Walk until a true Idle clip exists. Use `facingOffset` only after observing an actual orientation error.
5. Preload the config before gameplay and construct it through the shared `CharacterAssetStore`. Do not add a new GLTF loader or animation mixer per enemy type.
6. Replace only the target enemy's procedural visual branch. Preserve unrelated enemy visuals.

Update `src/config.ts` separately for collision radius, health, speed, and damage. A character can be visually short but have a wide collision circle; choose these values from gameplay and in-game inspection.

## Validate

Run `npm run build` and `git diff --check`. Then verify in the running game:

- model faces its movement direction;
- feet rest on the floor and the target height looks right beside the player;
- Walk plays only while moving and the frozen idle pose is acceptable;
- several copies animate independently without resetting one another;
- hit flashes affect only the hit instance;
- walls, bullets, contact damage, health bars, separation, and navigation still use the configured collision circle;
- no raw model or source image was accidentally staged;
- the optimized GLB is present in the production build output.

Report the source and optimized file sizes, triangle count, animation names/durations, chosen visual height and collision radius, build result, and anything still requiring the user's visual approval.
