import { recomputeEnemySeparation } from "../src/ai/enemy-crowd-movement.js";
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

testOverlappingEnemiesReceiveStableOppositeDirections();
testBossKeepsPriority();
testSeparationCannotPushOutsideMap();
testSeparationCannotPushIntoObstacle();
testSeparationCannotReversePathProgress();

console.log("enemy crowd movement tests passed");
