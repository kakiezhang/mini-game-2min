import {
  ENEMY_OVERLAP_ITERATIONS,
  recomputeEnemySeparation,
  resolveEnemyOverlaps,
} from "../src/ai/enemy-crowd-movement.js";
import { getEnemyMovementDirection } from "../src/ai/enemy-movement-recovery.js";
import { createEnemyAiRuntime } from "../src/ai/enemy-ai-runtime.js";
import { NavigationWorld } from "../src/navigation.js";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertNear = (actual: number, expected: number, message: string) => {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
};

const testOverlappingEnemiesReceiveStableOppositeDirections = () => {
  const first = createEnemyAiRuntime(1, "bug", 100, 100, 0);
  const second = createEnemyAiRuntime(2, "bug", 100, 100, 0);

  recomputeEnemySeparation([first, second]);
  const firstDirection = { x: first.separationX, z: first.separationZ };

  assert(Math.hypot(first.separationX, first.separationZ) > 0.49, "overlapping enemies should receive a push");
  assertNear(first.separationX, -second.separationX, "equal enemies should separate in opposite X directions");
  assertNear(first.separationZ, -second.separationZ, "equal enemies should separate in opposite Z directions");

  recomputeEnemySeparation([second, first]);
  assertNear(first.separationX, firstDirection.x, "overlap direction should not depend on iteration order");
  assertNear(first.separationZ, firstDirection.z, "stable overlap direction should be deterministic");
};

const testBossKeepsPriority = () => {
  const regular = createEnemyAiRuntime(3, "changeRequest", 200, 200, 0);
  const boss = createEnemyAiRuntime(4, "boss", 200, 200, 0);

  recomputeEnemySeparation([regular, boss]);

  assert(Math.hypot(regular.separationX, regular.separationZ) > 0.99, "regular enemies should fully yield to a boss");
  assertNear(boss.separationX, 0, "a boss should not be displaced by soft separation");
  assertNear(boss.separationZ, 0, "boss separation should remain zero");
};

const testSeparationCannotPushOutsideMap = () => {
  const navigation = new NavigationWorld(400, 400);
  const runtime = createEnemyAiRuntime(5, "bug", 36, 100, 0);
  runtime.state = "patrolMove";

  const direction = getEnemyMovementDirection(runtime, navigation, {
    now: 0.1,
    x: 36,
    z: 100,
    targetX: 36,
    targetZ: 300,
    flowTargetX: 36,
    flowTargetZ: 300,
    radius: 36,
    separationX: -4,
    separationZ: 0,
  });

  assert(direction.x >= -0.000001, "separation should not steer an enemy outside the map");
  assert(direction.z > 0.9, "filtering an unsafe separation component should preserve path progress");
};

const testSeparationCannotPushIntoObstacle = () => {
  const navigation = new NavigationWorld(400, 400);
  navigation.addObstacle(200, 200, 40, 200);
  const runtime = createEnemyAiRuntime(7, "changeRequest", 163, 200, 0);
  runtime.state = "chase";

  const direction = getEnemyMovementDirection(runtime, navigation, {
    now: 0.1,
    x: 163,
    z: 200,
    targetX: 163,
    targetZ: 350,
    flowTargetX: 163,
    flowTargetZ: 350,
    radius: 17,
    separationX: 4,
    separationZ: 0,
  });

  assert(direction.x <= 0.000001, "separation should not steer an enemy into furniture");
  assert(direction.z > 0.5, "obstacle filtering should retain forward movement along the wall");
};

const testSeparationCannotReversePathProgress = () => {
  const navigation = new NavigationWorld(400, 400);
  const runtime = createEnemyAiRuntime(6, "bug", 100, 100, 0);
  runtime.state = "patrolMove";

  const direction = getEnemyMovementDirection(runtime, navigation, {
    now: 0.1,
    x: 100,
    z: 100,
    targetX: 300,
    targetZ: 100,
    flowTargetX: 300,
    flowTargetZ: 100,
    radius: 36,
    separationX: -10,
    separationZ: 0,
  });

  assert(direction.x > 0.4, "even a large opposing separation force should retain forward progress");
};

const testHardOverlapCorrectionSeparatesRegularEnemies = () => {
  const navigation = new NavigationWorld(400, 400);
  const first = createEnemyAiRuntime(10, "bug", 100, 200, 0);
  const second = createEnemyAiRuntime(11, "bug", 150, 200, 0);

  const resolution = resolveEnemyOverlaps([first, second], navigation);

  assertEqual(ENEMY_OVERLAP_ITERATIONS, 2, "hard correction should remain bounded to two iterations");
  assert(resolution.overlapPairs > 0, "an overlapping pair should be corrected");
  assert(first.currentX < 100, "the first regular enemy should move away from the pair center");
  assert(second.currentX > 150, "the second regular enemy should move away from the pair center");
  assertNear(100 - first.currentX, second.currentX - 150, "regular enemies should share correction equally");
  assertEqual(resolution.remainingOverlapPairs, 0, "a modest overlap should be fully resolved in one frame");
};

const testHardOverlapCorrectionUsesStableDirection = () => {
  const navigation = new NavigationWorld(400, 400);
  const first = createEnemyAiRuntime(12, "changeRequest", 200, 200, 0);
  const second = createEnemyAiRuntime(13, "changeRequest", 200, 200, 0);
  const reversedFirst = createEnemyAiRuntime(12, "changeRequest", 200, 200, 0);
  const reversedSecond = createEnemyAiRuntime(13, "changeRequest", 200, 200, 0);

  resolveEnemyOverlaps([first, second], navigation);
  resolveEnemyOverlaps([reversedSecond, reversedFirst], navigation);

  assertNear(first.currentX, reversedFirst.currentX, "hard overlap direction should ignore iteration order");
  assertNear(first.currentZ, reversedFirst.currentZ, "hard overlap direction should be stable on Z");
  assertNear(second.currentX, reversedSecond.currentX, "the paired correction should remain deterministic");
  assertNear(second.currentZ, reversedSecond.currentZ, "the paired Z correction should remain deterministic");
};

const testHardOverlapCorrectionPreservesBossPriority = () => {
  const navigation = new NavigationWorld(400, 400);
  const regular = createEnemyAiRuntime(14, "changeRequest", 180, 200, 0);
  const boss = createEnemyAiRuntime(15, "boss", 200, 200, 0);

  resolveEnemyOverlaps([regular, boss], navigation);

  assert(regular.currentX < 180, "the regular enemy should yield to the boss");
  assertNear(boss.currentX, 200, "the boss should keep its X position");
  assertNear(boss.currentZ, 200, "the boss should keep its Z position");
};

const testHardOverlapCorrectionRespectsStaticCollision = () => {
  const navigation = new NavigationWorld(400, 400);
  navigation.addObstacle(200, 200, 40, 200);
  const first = createEnemyAiRuntime(16, "bug", 136, 200, 0);
  const second = createEnemyAiRuntime(17, "bug", 120, 200, 0);

  resolveEnemyOverlaps([first, second], navigation);

  assert(navigation.canOccupy(first.currentX, first.currentZ, 36), "hard correction must not enter an obstacle");
  assert(navigation.canOccupy(second.currentX, second.currentZ, 36), "the paired enemy must stay collision-safe");
  assert(first.currentX <= 144.000001, "the wall-facing enemy should remain outside the wall");
};

const testHardOverlapCorrectionCannotPushOutsideMap = () => {
  const navigation = new NavigationWorld(400, 400);
  const first = createEnemyAiRuntime(18, "bug", 36, 100, 0);
  const second = createEnemyAiRuntime(19, "bug", 36, 100, 0);

  resolveEnemyOverlaps([first, second], navigation);

  assert(first.currentX >= 36, "hard correction must keep the first enemy inside the map");
  assert(second.currentX >= 36, "hard correction must keep the second enemy inside the map");
  assert(navigation.canOccupy(first.currentX, first.currentZ, 36), "the first corrected position should be occupiable");
  assert(navigation.canOccupy(second.currentX, second.currentZ, 36), "the second corrected position should be occupiable");
};

const testHardOverlapCorrectionAllowsShallowContact = () => {
  const navigation = new NavigationWorld(400, 400);
  const first = createEnemyAiRuntime(20, "bug", 100, 200, 0);
  const second = createEnemyAiRuntime(21, "bug", 170, 200, 0);

  const resolution = resolveEnemyOverlaps([first, second], navigation);

  assertEqual(resolution.overlapPairs, 0, "shallow contact should not trigger hard correction");
  assertNear(first.currentX, 100, "shallow contact should not move the first enemy");
  assertNear(second.currentX, 170, "shallow contact should not move the second enemy");
};

const testHardOverlapCorrectionPreservesForwardProgress = () => {
  const navigation = new NavigationWorld(400, 400);
  const trailing = createEnemyAiRuntime(22, "bug", 100, 200, 0);
  const leading = createEnemyAiRuntime(23, "bug", 150, 200, 0);
  trailing.desiredVelocityX = 1;
  leading.desiredVelocityX = 1;

  const resolution = resolveEnemyOverlaps([trailing, leading], navigation);

  assertNear(trailing.currentX, 100, "hard correction must not push a moving enemy backward");
  assert(leading.currentX > 150, "the leading enemy may move forward to create room");
  assert(resolution.forwardProgressConstraints > 0, "forward-progress filtering should be observable");
};

const testHardOverlapCorrectionYieldsToRecovery = () => {
  const navigation = new NavigationWorld(400, 400);
  const recovering = createEnemyAiRuntime(24, "bug", 100, 200, 0);
  const other = createEnemyAiRuntime(25, "bug", 150, 200, 0);
  recovering.state = "stuckRecovery";

  const resolution = resolveEnemyOverlaps([recovering, other], navigation);

  assertNear(recovering.currentX, 100, "hard correction must not displace a recovering enemy");
  assert(other.currentX > 150, "a regular enemy should yield to a recovering enemy");
  assert(resolution.recoveryPriorityPairs > 0, "recovery-priority pairs should be observable");
};

const testHardOverlapCorrectionGivesTwoRecoveringEnemiesRightOfWay = () => {
  const navigation = new NavigationWorld(400, 400);
  const first = createEnemyAiRuntime(26, "bug", 100, 200, 0);
  const second = createEnemyAiRuntime(27, "bug", 150, 200, 0);
  first.state = "stuckRecovery";
  second.state = "stuckRecovery";

  const resolution = resolveEnemyOverlaps([first, second], navigation);

  assertNear(first.currentX, 100, "the lower-id recovering enemy should retain right of way");
  assert(second.currentX > 150, "the yielding recovering enemy should be separated from the pair");
  assert(resolution.dualRecoveryYieldPairs > 0, "dual-recovery yielding should be observable");
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

testOverlappingEnemiesReceiveStableOppositeDirections();
testBossKeepsPriority();
testSeparationCannotPushOutsideMap();
testSeparationCannotPushIntoObstacle();
testSeparationCannotReversePathProgress();
testHardOverlapCorrectionSeparatesRegularEnemies();
testHardOverlapCorrectionUsesStableDirection();
testHardOverlapCorrectionPreservesBossPriority();
testHardOverlapCorrectionRespectsStaticCollision();
testHardOverlapCorrectionCannotPushOutsideMap();
testHardOverlapCorrectionAllowsShallowContact();
testHardOverlapCorrectionPreservesForwardProgress();
testHardOverlapCorrectionYieldsToRecovery();
testHardOverlapCorrectionGivesTwoRecoveringEnemiesRightOfWay();

console.log("enemy crowd movement tests passed");
