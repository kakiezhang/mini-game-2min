import {
  classifyEnemyMovementFailureCause,
  EnemyMovementFailureEvidence,
  getEnemyCrowdYieldDirection,
  shouldEnemyYieldToBlocker,
} from "../src/ai/enemy-movement-failure.js";
import { createEnemyAiRuntime } from "../src/ai/enemy-ai-runtime.js";
import type { EnemyMovementDirection, EnemySteeringSample } from "../src/ai/enemy-movement-recovery.js";
import { NavigationWorld } from "../src/navigation.js";

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sample: EnemySteeringSample = {
  now: 1,
  x: 100,
  z: 100,
  targetX: 300,
  targetZ: 100,
  flowTargetX: 300,
  flowTargetZ: 100,
  radius: 36,
  separationX: 0,
  separationZ: 0,
};

const movingDirection: EnemyMovementDirection = {
  x: 1,
  z: 0,
  baseX: 1,
  baseZ: 0,
  safeX: 1,
  safeZ: 0,
};

const testFailureCauseClassification = () => {
  const navigation = new NavigationWorld(500, 500);
  const runtime = createEnemyAiRuntime(1, "bug", 100, 100, 0);
  runtime.state = "chase";
  runtime.approachSlotFailure = "invalid";

  assertEqual(
    classifyEnemyMovementFailureCause(runtime, navigation, sample, movingDirection, [runtime]),
    "invalidSlot",
    "an invalid combat slot should take classification priority",
  );

  runtime.approachSlotFailure = "none";
  navigation.addObstacle(300, 100, 40, 40);
  assertEqual(
    classifyEnemyMovementFailureCause(runtime, navigation, sample, movingDirection, [runtime]),
    "blockedWaypoint",
    "an occupied local target should be classified as a blocked waypoint",
  );
};

const testFlowCrowdAndStaticCauses = () => {
  const navigation = new NavigationWorld(500, 500);
  const runtime = createEnemyAiRuntime(2, "bug", 100, 100, 0);
  runtime.state = "patrolMove";

  assertEqual(
    classifyEnemyMovementFailureCause(runtime, navigation, sample, {
      ...movingDirection,
      x: 0,
      baseX: 0,
      safeX: 0,
    }, [runtime]),
    "noFlowDirection",
    "a missing base direction should be classified as a flow failure",
  );

  const blocker = createEnemyAiRuntime(3, "meeting", 150, 100, 0);
  assertEqual(
    classifyEnemyMovementFailureCause(runtime, navigation, sample, movingDirection, [runtime, blocker]),
    "crowdBlocked",
    "an enemy occupying the forward corridor should be classified as crowd blocking",
  );

  assertEqual(
    classifyEnemyMovementFailureCause(runtime, navigation, sample, {
      ...movingDirection,
      x: 0,
      safeX: 0,
    }, [runtime]),
    "staticCollision",
    "a base direction removed by collision projection should be classified as static collision",
  );
};

const testEvidenceUsesTheDominantCause = () => {
  const evidence = new EnemyMovementFailureEvidence();
  evidence.record(4, "staticCollision");
  evidence.record(4, "crowdBlocked");
  evidence.record(4, "crowdBlocked");
  assertEqual(evidence.peek(4), "crowdBlocked", "the sampling window should retain its dominant cause");

  evidence.reset(4);
  assertEqual(evidence.peek(4), "unclassified", "reset should begin a clean sampling window");
};

const testDualRecoveryUsesStableRightOfWay = () => {
  const navigation = new NavigationWorld(500, 500);
  const priority = createEnemyAiRuntime(5, "meeting", 100, 100, 0);
  const yielding = createEnemyAiRuntime(6, "bug", 150, 100, 0);
  priority.state = "stuckRecovery";
  priority.failureCause = "crowdBlocked";
  yielding.state = "stuckRecovery";
  yielding.failureCause = "crowdBlocked";

  assertEqual(shouldEnemyYieldToBlocker(priority, yielding), false, "the lower id should retain right of way");
  assertEqual(shouldEnemyYieldToBlocker(yielding, priority), true, "the higher id should yield deterministically");

  const yieldDirection = getEnemyCrowdYieldDirection(
    yielding,
    priority,
    navigation,
    { ...sample, x: 150, radius: 36 },
    { ...movingDirection, x: -1, baseX: -1, safeX: -1 },
  );
  assert(Math.abs(yieldDirection.z) > 0.5, "yielding should prefer a lateral escape over pushing through the blocker");
  assert(navigation.canMoveDirectly(150, 100, 150 + yieldDirection.x * 8, 100 + yieldDirection.z * 8, 36), "the yield direction should respect static collision");
};

testFailureCauseClassification();
testFlowCrowdAndStaticCauses();
testEvidenceUsesTheDominantCause();
testDualRecoveryUsesStableRightOfWay();

console.log("enemy movement failure tests passed");
