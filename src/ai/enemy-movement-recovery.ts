import type { NavigationWorld } from "../navigation";
import {
  getEnemyRecoveryLevel,
  setEnemyAiState,
  type EnemyAiRuntime,
} from "./enemy-ai-runtime";

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

const leaveRecoveryState = (runtime: EnemyAiRuntime, now: number) => {
  if (runtime.state !== "stuckRecovery") return;
  const returnState = runtime.previousState === "stuckRecovery"
    ? "chase"
    : runtime.previousState;
  setEnemyAiState(runtime, returnState, now);
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
  const separationScale = runtime.kind === "boss" ? 0 : followingPatrolPath ? 0.8 : 1.6;
  const normalDirection = {
    x: baseDirection.x + sample.separationX * separationScale,
    z: baseDirection.z + sample.separationZ * separationScale,
  };
  const recoveryLevel = getEnemyRecoveryLevel(runtime, sample.now);

  if (recoveryLevel === 0) {
    runtime.recoveryLevel = 0;
    leaveRecoveryState(runtime, sample.now);
    return normalDirection;
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
    return recoveryDirection;
  }
  return normalDirection;
};
