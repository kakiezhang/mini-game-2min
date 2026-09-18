import type { NavigationWorld } from "../navigation.js";
import {
  getEnemyRecoveryLevel,
  setEnemyAiState,
  type EnemyAiRuntime,
} from "./enemy-ai-runtime.js";

export type EnemySteeringSample = {
  now: number;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  flowTargetX: number;
  flowTargetZ: number;
  radius: number;
  separationX: number;
  separationZ: number;
};

export type EnemyMovementDirection = {
  x: number;
  z: number;
  baseX: number;
  baseZ: number;
  safeX: number;
  safeZ: number;
};

const leaveRecoveryState = (runtime: EnemyAiRuntime, now: number) => {
  if (runtime.state !== "stuckRecovery") return;
  const returnState = runtime.previousState === "stuckRecovery"
    ? "chase"
    : runtime.previousState;
  setEnemyAiState(runtime, returnState, now);
};

const limitMagnitude = (x: number, z: number, maximum: number) => {
  const length = Math.hypot(x, z);
  if (length <= maximum) return { x, z };
  return { x: (x / length) * maximum, z: (z / length) * maximum };
};

export const getEnemyMovementDirection = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemySteeringSample,
) => {
  const movementState = runtime.state === "stuckRecovery"
    ? runtime.previousState
    : runtime.state;
  const followingPatrolPath = movementState === "patrolMove";
  const baseDirection = navigation.getDirection(
    sample.x,
    sample.z,
    sample.targetX,
    sample.targetZ,
    sample.radius,
    sample.flowTargetX,
    sample.flowTargetZ,
    followingPatrolPath,
  );
  const safeSeparation = runtime.kind === "boss"
    ? { x: 0, z: 0 }
    : navigation.getCollisionSafeDirection(
      sample.x,
      sample.z,
      sample.separationX,
      sample.separationZ,
      sample.radius,
    );
  const maximumSeparation = followingPatrolPath ? 0.5 : 0.75;
  const separation = limitMagnitude(safeSeparation.x, safeSeparation.z, maximumSeparation);
  const blendedDirection = {
    x: baseDirection.x + separation.x,
    z: baseDirection.z + separation.z,
  };
  let normalDirection = navigation.getCollisionSafeDirection(
    sample.x,
    sample.z,
    blendedDirection.x,
    blendedDirection.z,
    sample.radius,
  );
  const baseLength = Math.hypot(baseDirection.x, baseDirection.z);
  if (
    baseLength > 0.08
    && normalDirection.x * baseDirection.x + normalDirection.z * baseDirection.z <= 0.08
  ) {
    normalDirection = baseDirection;
  }
  const recoveryLevel = getEnemyRecoveryLevel(runtime, sample.now);
  const withDiagnostics = (direction: { x: number; z: number }): EnemyMovementDirection => ({
    ...direction,
    baseX: baseDirection.x,
    baseZ: baseDirection.z,
    safeX: normalDirection.x,
    safeZ: normalDirection.z,
  });

  if (recoveryLevel === 0) {
    runtime.recoveryLevel = 0;
    leaveRecoveryState(runtime, sample.now);
    return withDiagnostics(normalDirection);
  }

  runtime.recoveryLevel = recoveryLevel;
  setEnemyAiState(runtime, "stuckRecovery", sample.now);
  const recoveryDirection = navigation.getRecoveryDirection(
    sample.x,
    sample.z,
    sample.flowTargetX,
    sample.flowTargetZ,
    sample.radius,
    recoveryLevel,
  );
  if (Math.hypot(recoveryDirection.x, recoveryDirection.z) > 0.08) {
    return withDiagnostics(recoveryDirection);
  }
  return withDiagnostics(normalDirection);
};
