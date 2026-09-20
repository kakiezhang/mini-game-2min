import {
  REGULAR_ENEMY_ACTIVE_LIMITS,
  type EnemyKind,
  type RegularEnemyKind,
} from "../config.js";

export type SpawnWeights = Record<RegularEnemyKind, number>;
export type EnemyKindCounts = Record<EnemyKind, number>;

const REGULAR_ENEMY_KINDS: readonly RegularEnemyKind[] = ["bug", "changeRequest", "meeting"];

export function countActiveEnemyKinds(activeEnemies: Iterable<{ kind: EnemyKind }>): EnemyKindCounts {
  const counts: EnemyKindCounts = {
    bug: 0,
    changeRequest: 0,
    meeting: 0,
    boss: 0,
  };
  for (const enemy of activeEnemies) counts[enemy.kind] += 1;
  return counts;
}

export function pickAvailableSpawnKind(
  weights: SpawnWeights,
  activeEnemies: Iterable<{ kind: EnemyKind }>,
  random: () => number,
): RegularEnemyKind | undefined {
  const activeCounts = countActiveEnemyKinds(activeEnemies);

  const availableKinds = REGULAR_ENEMY_KINDS.filter((kind) => (
    activeCounts[kind] < REGULAR_ENEMY_ACTIVE_LIMITS[kind] && weights[kind] > 0
  ));
  const totalWeight = availableKinds.reduce((total, kind) => total + weights[kind], 0);
  if (totalWeight <= 0) return undefined;

  let roll = random() * totalWeight;
  for (const kind of availableKinds) {
    roll -= weights[kind];
    if (roll < 0) return kind;
  }
  return availableKinds.at(-1);
}
