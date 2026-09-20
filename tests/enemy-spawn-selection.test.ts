import { countActiveEnemyKinds, pickAvailableSpawnKind } from "../src/ai/enemy-spawn-selection.js";
import { GAME, REGULAR_ENEMY_ACTIVE_LIMITS, type EnemyKind } from "../src/config.js";

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const enemies = (...kinds: EnemyKind[]) => kinds.map((kind) => ({ kind }));

const testConfiguredLimits = () => {
  assertEqual(REGULAR_ENEMY_ACTIVE_LIMITS.bug, 5, "bug active limit");
  assertEqual(REGULAR_ENEMY_ACTIVE_LIMITS.changeRequest, 4, "change request active limit");
  assertEqual(REGULAR_ENEMY_ACTIVE_LIMITS.meeting, 3, "meeting active limit");
  assertEqual(GAME.maxEnemies, 13, "total enemy limit should include one boss slot");
};

const testActiveKindCounts = () => {
  const counts = countActiveEnemyKinds(enemies("bug", "bug", "changeRequest", "meeting", "boss"));
  assertEqual(counts.bug, 2, "bug count");
  assertEqual(counts.changeRequest, 1, "change request count");
  assertEqual(counts.meeting, 1, "meeting count");
  assertEqual(counts.boss, 1, "boss count");
};

const testFullKindsAreExcluded = () => {
  const kind = pickAvailableSpawnKind(
    { bug: 75, changeRequest: 25, meeting: 0 },
    enemies("bug", "bug", "bug", "bug", "bug"),
    () => 0,
  );
  assertEqual(kind, "changeRequest", "a full bug group must not receive another bug");
};

const testLockedStageStopsAtAvailableCaps = () => {
  const kind = pickAvailableSpawnKind(
    { bug: 100, changeRequest: 0, meeting: 0 },
    enemies("bug", "bug", "bug", "bug", "bug"),
    () => 0.5,
  );
  assertEqual(kind, undefined, "spawning should pause when every weighted kind is full");
};

const testOnlyUnderLimitKindIsSelected = () => {
  const kind = pickAvailableSpawnKind(
    { bug: 45, changeRequest: 35, meeting: 20 },
    enemies(
      "bug", "bug", "bug", "bug", "bug",
      "changeRequest", "changeRequest", "changeRequest", "changeRequest",
      "meeting", "meeting",
      "boss",
    ),
    () => 0,
  );
  assertEqual(kind, "meeting", "the remaining meeting slot should be filled");
};

const testWeightedSelectionAmongAvailableKinds = () => {
  const activeEnemies: Array<{ kind: EnemyKind }> = [];
  const weights = { bug: 55, changeRequest: 30, meeting: 15 };
  assertEqual(pickAvailableSpawnKind(weights, activeEnemies, () => 0), "bug", "low roll should select bug");
  assertEqual(
    pickAvailableSpawnKind(weights, activeEnemies, () => 0.7),
    "changeRequest",
    "middle roll should select change request",
  );
  assertEqual(
    pickAvailableSpawnKind(weights, activeEnemies, () => 0.95),
    "meeting",
    "high roll should select meeting",
  );
};

testConfiguredLimits();
testActiveKindCounts();
testFullKindsAreExcluded();
testLockedStageStopsAtAvailableCaps();
testOnlyUnderLimitKindIsSelected();
testWeightedSelectionAmongAvailableKinds();

console.log("enemy spawn selection tests passed");
