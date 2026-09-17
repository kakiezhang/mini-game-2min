import { NavigationWorld, getNavigationSizeClass } from "../src/navigation.js";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const testSizeClasses = () => {
  assertEqual(getNavigationSizeClass(17), "small", "17-radius agents should use the small grid");
  assertEqual(getNavigationSizeClass(30), "medium", "30-radius agents should use the medium grid");
  assertEqual(getNavigationSizeClass(36), "large", "36-radius agents should use the large grid");
};

const testSharedChaseFlowIgnoresLocalOrbitTargets = () => {
  const navigation = new NavigationWorld(480, 480);
  navigation.setPerformanceTracking(true);

  navigation.getDirection(40, 240, 340, 190, 17, 420, 240);
  navigation.getDirection(40, 240, 340, 290, 17, 420, 240);

  const metrics = navigation.takePerformanceMetrics();
  assertEqual(metrics.flowRequests, 2, "both distant steering requests should consult a flow");
  assertEqual(metrics.flowRebuilds, 1, "local orbit targets must share the chase flow");
  assertEqual(metrics.flowCacheHits, 1, "the second chase request should hit the cache");
  assertEqual(metrics.blockedGridRebuilds, 1, "one small-agent blocked grid should be built");
};

const testPatrolCanPreferLongDirectSegment = () => {
  const navigation = new NavigationWorld(480, 480);
  navigation.setPerformanceTracking(true);

  const direction = navigation.getDirection(40, 240, 420, 240, 17, 420, 240, true);

  assert(direction.x > 0.99, "a clear patrol segment should steer directly toward its waypoint");
  const metrics = navigation.takePerformanceMetrics();
  assertEqual(metrics.flowRequests, 0, "a clear patrol segment should not rebuild or consult a flow field");
};

const testSizeClassesHaveIndependentCaches = () => {
  const navigation = new NavigationWorld(480, 480);
  navigation.setPerformanceTracking(true);

  navigation.getDirection(40, 240, 420, 240, 17);
  navigation.getDirection(40, 240, 420, 240, 36);

  const metrics = navigation.takePerformanceMetrics();
  assertEqual(metrics.flowRebuilds, 2, "small and large agents need separate flow fields");
  assertEqual(metrics.blockedGridRebuilds, 2, "small and large agents need separate blocked grids");
};

const testDynamicObstacleInvalidatesCaches = () => {
  const navigation = new NavigationWorld(400, 400);
  const barrier = navigation.addObstacle(200, 200, 400, 40, false);
  navigation.setPerformanceTracking(true);

  assert(navigation.canReach(200, 80, 200, 320, 17), "the inactive barrier should allow a route");
  navigation.takePerformanceMetrics();

  navigation.setObstacleActive(barrier, true);
  assert(!navigation.canReach(200, 80, 200, 320, 17), "the active full-width barrier should block the route");
  const metrics = navigation.takePerformanceMetrics();
  assertEqual(metrics.flowRebuilds, 1, "changing an obstacle should rebuild the requested flow lazily");
  assertEqual(metrics.blockedGridRebuilds, 1, "changing an obstacle should rebuild the requested size grid lazily");
};

const testNarrowPassageRespectsAgentSize = () => {
  const navigation = new NavigationWorld(240, 240);
  navigation.addObstacle(35, 120, 70, 240);
  navigation.addObstacle(185, 120, 110, 240);

  assert(navigation.canReach(100, 60, 100, 180, 17), "small agents should fit through the 60-unit passage");
  assert(!navigation.canReach(100, 60, 100, 180, 36), "large agents should reject the 60-unit passage");
};

const testWallCornerRecoveryRecentersLargeEnemy = () => {
  const navigation = new NavigationWorld(1080, 1720);
  navigation.addObstacle(535, 560, 370, 24);
  const start = { x: 319.31, z: 528.48 };
  const recovery = navigation.getRecoveryDirection(
    start.x,
    start.z,
    764.2,
    642.28,
    36,
    1,
  );

  assert(recovery.x < -0.5, "corner recovery should first move the large enemy away from the wall endpoint");
  assert(recovery.z > 0.1, "corner recovery should recenter the enemy inside its safe grid cell");
  const moved = navigation.moveCircle(start.x, start.z, recovery.x * 19.5, recovery.z * 19.5, 36);
  assert(
    Math.hypot(moved.x - start.x, moved.z - start.z) > 5,
    "the recovery direction should produce meaningful collision-safe progress",
  );

  const escalatedRecovery = navigation.getRecoveryDirection(
    start.x,
    start.z,
    764.2,
    642.28,
    36,
    2,
  );
  assert(
    Math.hypot(escalatedRecovery.x - recovery.x, escalatedRecovery.z - recovery.z) > 0.1,
    "level-two recovery should switch from recentering to a reachable neighboring cell",
  );
};

const testMediumAndLargeEnemiesCanReachElevatorCorridor = () => {
  const navigation = new NavigationWorld(1080, 1720);
  // The two horizontal walls leave 180 units in total, while the vertical wall
  // splits that opening into two 78-unit passages. A 40-unit grid missed both
  // passages even though 60- and 72-unit collision circles physically fit.
  navigation.addObstacle(235, 1120, 430, 24);
  navigation.addObstacle(845, 1120, 430, 24);
  navigation.addObstacle(540, 1019, 24, 178);

  assert(
    navigation.canReach(580, 860, 540, 1200, 30),
    "medium enemies should fit through the elevator-corridor doorway",
  );
  assert(
    navigation.canReach(580, 860, 540, 1200, 36),
    "large enemies should fit through the elevator-corridor doorway",
  );
};

const testPatrolPathUsesReachableWaypoints = () => {
  const navigation = new NavigationWorld(400, 400);
  navigation.addObstacle(200, 200, 40, 300);
  const path = navigation.findPath(80, 200, 320, 200, 17);

  assert(path.length > 1, "a blocked direct route should produce a waypoint path");
  let position = { x: 80, z: 200 };
  for (const waypoint of path) {
    assert(navigation.canOccupy(waypoint.x, waypoint.z, 17), "every patrol waypoint should be occupiable");
    assert(navigation.canReach(position.x, position.z, waypoint.x, waypoint.z, 17), "each waypoint should remain reachable");
    position = waypoint;
  }
};

testSizeClasses();
testSharedChaseFlowIgnoresLocalOrbitTargets();
testPatrolCanPreferLongDirectSegment();
testSizeClassesHaveIndependentCaches();
testDynamicObstacleInvalidatesCaches();
testNarrowPassageRespectsAgentSize();
testWallCornerRecoveryRecentersLargeEnemy();
testMediumAndLargeEnemiesCanReachElevatorCorridor();
testPatrolPathUsesReachableWaypoints();

console.log("navigation tests passed");
