import {
  createEnemyAiRuntime,
  getEnemyRecoveryLevel,
  recordEnemyMovement,
} from "../src/ai/enemy-ai-runtime.js";
import { EnemyAiTelemetry } from "../src/ai/enemy-ai-telemetry.js";

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const testFailureSnapshotsAndTransitions = () => {
  const telemetry = new EnemyAiTelemetry();
  const runtime = createEnemyAiRuntime(7, "bug", 100, 120, 0);
  telemetry.register(runtime);

  const previousFailure = runtime.failure;
  const previousStuckSince = runtime.stuckSince;
  recordEnemyMovement(runtime, {
    now: 0.5,
    x: 100,
    z: 120,
    targetX: 240,
    targetZ: 220,
    desiredVelocityX: 1,
    desiredVelocityZ: 0,
  });
  telemetry.recordFailureChange(runtime, previousFailure, previousStuckSince, 0.5);

  const stuckSnapshot = telemetry.takeSnapshot(1);
  assertEqual(stuckSnapshot.activeEnemyCount, 1, "the registered enemy should be counted");
  assertEqual(stuckSnapshot.failureCounts.insufficientProgress, 1, "the failure aggregate should count the enemy");
  assertEqual(stuckSnapshot.stateCounts.patrolIdle, 1, "the state aggregate should count the enemy");
  assertEqual(stuckSnapshot.stuckEnemyCount, 1, "the stuck aggregate should count the enemy");
  assertEqual(stuckSnapshot.longestStuckSeconds, 1, "the snapshot should expose the current stuck duration");
  assertEqual(stuckSnapshot.affectedEnemies[0]?.id, 7, "the affected-enemy list should identify the enemy");
  assertEqual(stuckSnapshot.affectedEnemies[0]?.position.x, 100, "the affected-enemy list should include its position");
  assertEqual(stuckSnapshot.failureTransitions[0]?.from, "none", "the entry transition should preserve its source state");
  assertEqual(stuckSnapshot.failureTransitions[0]?.to, "insufficientProgress", "the entry transition should preserve its failure");

  assertEqual(telemetry.takeSnapshot(1).failureTransitions.length, 0, "failure transitions should be emitted once");

  const failureBeforeRecovery = runtime.failure;
  const stuckSinceBeforeRecovery = runtime.stuckSince;
  recordEnemyMovement(runtime, {
    now: 1,
    x: 112,
    z: 120,
    targetX: 240,
    targetZ: 220,
    desiredVelocityX: 1,
    desiredVelocityZ: 0,
  });
  telemetry.recordFailureChange(runtime, failureBeforeRecovery, stuckSinceBeforeRecovery, 1);

  const recoveredSnapshot = telemetry.takeSnapshot(1);
  assertEqual(recoveredSnapshot.failureCounts.none, 1, "the recovered enemy should return to the none aggregate");
  assertEqual(recoveredSnapshot.stuckEnemyCount, 0, "the recovered enemy should leave the affected list");
  assertEqual(recoveredSnapshot.failureTransitions[0]?.to, "none", "the recovery transition should be recorded");
  assertEqual(recoveredSnapshot.failureTransitions[0]?.stuckForSeconds, 1, "the recovery transition should retain total stuck duration");

  telemetry.unregister(runtime);
  assertEqual(telemetry.takeSnapshot(1).activeEnemyCount, 0, "removed enemies should leave telemetry");
};

const testStateTransitions = () => {
  const telemetry = new EnemyAiTelemetry();
  const runtime = createEnemyAiRuntime(10, "changeRequest", 40, 50, 0);
  telemetry.register(runtime);
  const previousState = runtime.state;
  runtime.state = "investigate";
  runtime.investigationReason = "gunshot";
  telemetry.recordStateChange(runtime, previousState, 0.25);

  const snapshot = telemetry.takeSnapshot(0.25);
  assertEqual(snapshot.stateCounts.investigate, 1, "state counts should expose current AI behavior");
  assertEqual(snapshot.stateTransitions[0]?.from, "patrolIdle", "state transitions should preserve their source");
  assertEqual(snapshot.stateTransitions[0]?.to, "investigate", "state transitions should preserve their destination");
  assertEqual(snapshot.stateTransitions[0]?.investigationReason, "gunshot", "state transitions should preserve investigation reasons");
  assertEqual(telemetry.takeSnapshot(0.25).stateTransitions.length, 0, "state transitions should be emitted once");
};

const testNoDirectionFailure = () => {
  const telemetry = new EnemyAiTelemetry();
  const runtime = createEnemyAiRuntime(8, "meeting", 20, 30, 0);
  telemetry.register(runtime);
  recordEnemyMovement(runtime, {
    now: 0.5,
    x: 20,
    z: 30,
    targetX: 120,
    targetZ: 30,
    desiredVelocityX: 0,
    desiredVelocityZ: 0,
  });

  const snapshot = telemetry.takeSnapshot(0.5);
  assertEqual(snapshot.failureCounts.noDirection, 1, "zero desired velocity should be reported as noDirection");
  assertEqual(snapshot.affectedEnemies[0]?.kind, "meeting", "the detail should include the enemy kind");
};

const testRecoveryLevelThresholds = () => {
  const runtime = createEnemyAiRuntime(9, "bug", 100, 100, 0);
  runtime.failure = "insufficientProgress";
  runtime.stuckSince = 10;

  assertEqual(getEnemyRecoveryLevel(runtime, 10.49), 0, "recovery should wait for the first threshold");
  assertEqual(getEnemyRecoveryLevel(runtime, 10.5), 1, "level one should begin after half a second");
  assertEqual(getEnemyRecoveryLevel(runtime, 11.5), 2, "level two should begin after one and a half seconds");
  assertEqual(getEnemyRecoveryLevel(runtime, 13), 3, "level three should begin after three seconds");

  runtime.failure = "none";
  assertEqual(getEnemyRecoveryLevel(runtime, 20), 0, "a recovered enemy should not retain a recovery level");
};

testFailureSnapshotsAndTransitions();
testNoDirectionFailure();
testRecoveryLevelThresholds();
testStateTransitions();

console.log("enemy AI telemetry tests passed");
