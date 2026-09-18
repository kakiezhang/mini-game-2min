import { updateEnemyBehavior, confirmEnemyHit } from "../src/ai/enemy-ai-behavior.js";
import { createEnemyAiRuntime } from "../src/ai/enemy-ai-runtime.js";
import { NavigationWorld } from "../src/navigation.js";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const createSample = (now: number, playerX: number, playerZ: number) => ({
  now,
  x: 100,
  z: 100,
  radius: 17,
  playerX,
  playerZ,
  playerRadius: 30,
});

const testPatrolAndVisionReaction = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(1, "changeRequest", 100, 100, 0);
  runtime.facingX = 1;
  runtime.facingZ = 0;
  runtime.idleUntil = 10;

  let decision = updateEnemyBehavior(runtime, navigation, createSample(0.02, 350, 100), () => 0);
  assertEqual(runtime.state, "investigate", "a visible player should trigger a reaction state");
  assertEqual(runtime.investigationReason, "vision", "visual discovery should retain its investigation reason");
  assertEqual(decision.speedMultiplier, 0.78, "investigation should use its own movement speed");

  decision = updateEnemyBehavior(runtime, navigation, createSample(0.33, 350, 100), () => 0);
  assertEqual(runtime.state, "chase", "continuous sight beyond reaction time should confirm a chase");
  assertEqual(decision.flowTargetX, 350, "chase flow should use the visible player position");
};

const testWallBlocksVision = () => {
  const navigation = new NavigationWorld(600, 400);
  navigation.addObstacle(220, 100, 24, 240);
  const runtime = createEnemyAiRuntime(2, "changeRequest", 100, 100, 0);
  runtime.facingX = 1;
  runtime.facingZ = 0;
  runtime.idleUntil = 10;

  updateEnemyBehavior(runtime, navigation, createSample(0.04, 350, 100), () => 0);
  assertEqual(runtime.state, "patrolIdle", "a wall should block both normal and close-range visual detection");
  assertEqual(runtime.lastSeenAt, Number.NEGATIVE_INFINITY, "blocked vision must not update player memory");
};

const testGunshotAndHitResponses = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(3, "bug", 100, 100, 0);
  runtime.idleUntil = 10;

  const decision = updateEnemyBehavior(runtime, navigation, {
    ...createSample(0.1, 900, 900),
    latestNoise: { x: 500, z: 100, at: 0.1 },
  }, () => 0);
  assertEqual(runtime.state, "investigate", "an audible gunshot should trigger investigation");
  assertEqual(runtime.investigationReason, "gunshot", "gunshot investigation should be identifiable in telemetry");
  assertEqual(decision.targetX, 500, "investigation should target the gunshot position");

  confirmEnemyHit(runtime, 900, 900, 0.2);
  assertEqual(runtime.state, "chase", "taking damage should immediately confirm the player");
  assertEqual(runtime.lastSeenPlayerZ, 900, "hit response should retain the attacker position");
};

const testBriefVisualLossStaysInInvestigation = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(5, "changeRequest", 100, 100, 0);
  runtime.facingX = 1;
  runtime.facingZ = 0;
  runtime.idleUntil = 10;

  updateEnemyBehavior(runtime, navigation, createSample(0.08, 350, 100), () => 0);
  runtime.facingX = -1;
  updateEnemyBehavior(runtime, navigation, createSample(0.4, 350, 100), () => 0);

  assertEqual(runtime.state, "investigate", "brief visual loss must not bounce into a second state");
  assertEqual(runtime.investigationX, 350, "visual investigation should preserve the last seen position");
};

const testLostTargetInvestigatesThenPatrols = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(4, "changeRequest", 100, 100, 0);
  confirmEnemyHit(runtime, 900, 900, 0);

  updateEnemyBehavior(runtime, navigation, createSample(2.6, 900, 900), () => 0);
  assertEqual(runtime.state, "investigate", "expired target memory should reuse investigation");
  assertEqual(runtime.investigationReason, "lostTarget", "lost-target investigation should retain its reason");
  assertEqual(runtime.investigationX, 900, "lost-target investigation should use the last seen position");
  assert(runtime.investigationExpiresAt > 2.6, "lost-target investigation should have a finite timeout");

  updateEnemyBehavior(runtime, navigation, createSample(runtime.investigationExpiresAt + 0.01, 900, 900), () => 0);
  assert(
    runtime.state === "patrolMove" || runtime.state === "patrolIdle",
    "an expired lost-target investigation should return to the patrol loop",
  );
};

const testPatrolSkipsToFarthestDirectWaypoint = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(6, "bug", 100, 100, 0);
  runtime.state = "patrolMove";
  runtime.path = [
    { x: 140, z: 100 },
    { x: 220, z: 100 },
    { x: 320, z: 100 },
  ];
  runtime.pathIndex = 0;
  runtime.nextPerceptionAt = 10;

  const decision = updateEnemyBehavior(runtime, navigation, createSample(0.1, 1000, 1600), () => 0);

  assertEqual(runtime.pathIndex, 2, "patrol should skip redundant directly reachable waypoints");
  assertEqual(decision.targetX, 320, "patrol steering should target the farthest clear waypoint");
  assertEqual(decision.flowTargetX, 320, "patrol flow target should match the active path segment");
};

const testPatrolDoesNotSkipThroughObstacle = () => {
  const navigation = new NavigationWorld(1080, 1720);
  navigation.addObstacle(200, 100, 40, 160);
  const runtime = createEnemyAiRuntime(7, "bug", 100, 100, 0);
  runtime.state = "patrolMove";
  runtime.path = [
    { x: 140, z: 200 },
    { x: 260, z: 200 },
    { x: 300, z: 100 },
  ];
  runtime.pathIndex = 0;
  runtime.nextPerceptionAt = 10;

  const decision = updateEnemyBehavior(runtime, navigation, {
    ...createSample(0.1, 1000, 1600),
    radius: 36,
  }, () => 0);

  assertEqual(runtime.pathIndex, 0, "patrol must retain the first safe turn when later points are blocked");
  assertEqual(decision.targetX, 140, "patrol must not shortcut through an obstacle");
};

const testChaseUsesStableApproachTarget = () => {
  const navigation = new NavigationWorld(1080, 1720);
  const runtime = createEnemyAiRuntime(8, "changeRequest", 100, 100, 0);
  confirmEnemyHit(runtime, 500, 100, 0);

  const decision = updateEnemyBehavior(runtime, navigation, {
    ...createSample(0.1, 500, 100),
    approachTarget: { slotId: 0, ring: 0, x: 453, z: 100 },
  }, () => 0);

  assertEqual(decision.targetX, 453, "a confirmed chaser should use its stable approach slot");
  assertEqual(decision.targetZ, 100, "the local target should match the assigned slot");
  assertEqual(decision.flowTargetX, 500, "approach slots must retain the shared player flow target");
};

testPatrolAndVisionReaction();
testWallBlocksVision();
testGunshotAndHitResponses();
testBriefVisualLossStaysInInvestigation();
testLostTargetInvestigatesThenPatrols();
testPatrolSkipsToFarthestDirectWaypoint();
testPatrolDoesNotSkipThroughObstacle();
testChaseUsesStableApproachTarget();

console.log("enemy AI behavior tests passed");
