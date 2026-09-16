import type { EnemyKind } from "../config";

export type EnemyAiState =
  | "spawning"
  | "patrolIdle"
  | "patrolMove"
  | "investigate"
  | "chase"
  | "attack"
  | "search"
  | "stuckRecovery"
  | "dead";

export type PatrolZoneId =
  | "meetingRoom"
  | "bossOffice"
  | "workstation"
  | "pantry"
  | "elevatorCorridor";

export type NavigationPoint = {
  x: number;
  z: number;
};

export type EnemyMovementFailure =
  | "none"
  | "noDirection"
  | "insufficientProgress";

export type EnemyAiRuntime = {
  id: number;
  kind: EnemyKind;
  state: EnemyAiState;
  previousState: EnemyAiState;
  stateEnteredAt: number;
  homeZone: PatrolZoneId;
  targetX: number;
  targetZ: number;
  lastSeenPlayerX: number;
  lastSeenPlayerZ: number;
  lastSeenAt: number;
  lastHeardX: number;
  lastHeardZ: number;
  lastHeardAt: number;
  path: NavigationPoint[];
  pathIndex: number;
  approachSlotId?: number;
  nextPerceptionAt: number;
  stuckSince?: number;
  lastProgressAt: number;
  lastProgressX: number;
  lastProgressZ: number;
  failure: EnemyMovementFailure;
  recoveryLevel: number;
  desiredVelocityX: number;
  desiredVelocityZ: number;
};

export type EnemyMovementSample = {
  now: number;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  desiredVelocityX: number;
  desiredVelocityZ: number;
};

const STUCK_SAMPLE_INTERVAL = 0.5;
const STUCK_MIN_DISPLACEMENT = 5;

export const getPatrolZoneAt = (x: number, z: number): PatrolZoneId => {
  if (z >= 1120) return "elevatorCorridor";
  if (z < 560) return x < 540 ? "meetingRoom" : "bossOffice";
  return x < 540 ? "workstation" : "pantry";
};

export const createEnemyAiRuntime = (
  id: number,
  kind: EnemyKind,
  x: number,
  z: number,
  now: number,
): EnemyAiRuntime => ({
  id,
  kind,
  // Phase A preserves the legacy behavior: every live enemy immediately chases.
  state: "chase",
  previousState: "spawning",
  stateEnteredAt: now,
  homeZone: getPatrolZoneAt(x, z),
  targetX: x,
  targetZ: z,
  lastSeenPlayerX: x,
  lastSeenPlayerZ: z,
  lastSeenAt: Number.NEGATIVE_INFINITY,
  lastHeardX: x,
  lastHeardZ: z,
  lastHeardAt: Number.NEGATIVE_INFINITY,
  path: [],
  pathIndex: 0,
  nextPerceptionAt: now,
  lastProgressAt: now,
  lastProgressX: x,
  lastProgressZ: z,
  failure: "none",
  recoveryLevel: 0,
  desiredVelocityX: 0,
  desiredVelocityZ: 0,
});

export const setEnemyAiState = (runtime: EnemyAiRuntime, state: EnemyAiState, now: number) => {
  if (runtime.state === state) return;
  runtime.previousState = runtime.state;
  runtime.state = state;
  runtime.stateEnteredAt = now;
};

export const recordEnemyMovement = (runtime: EnemyAiRuntime, sample: EnemyMovementSample) => {
  runtime.targetX = sample.targetX;
  runtime.targetZ = sample.targetZ;
  runtime.desiredVelocityX = sample.desiredVelocityX;
  runtime.desiredVelocityZ = sample.desiredVelocityZ;

  if (sample.now - runtime.lastProgressAt < STUCK_SAMPLE_INTERVAL) return;

  const displacement = Math.hypot(
    sample.x - runtime.lastProgressX,
    sample.z - runtime.lastProgressZ,
  );
  const wantsToMove = Math.hypot(sample.desiredVelocityX, sample.desiredVelocityZ) > 0.08;
  const targetDistance = Math.hypot(sample.targetX - sample.x, sample.targetZ - sample.z);

  if (targetDistance > STUCK_MIN_DISPLACEMENT && displacement < STUCK_MIN_DISPLACEMENT) {
    if (wantsToMove) {
      runtime.failure = "insufficientProgress";
      runtime.stuckSince ??= sample.now - STUCK_SAMPLE_INTERVAL;
    } else {
      runtime.failure = "noDirection";
      runtime.stuckSince ??= sample.now - STUCK_SAMPLE_INTERVAL;
    }
  } else {
    runtime.failure = "none";
    runtime.stuckSince = undefined;
  }

  runtime.lastProgressAt = sample.now;
  runtime.lastProgressX = sample.x;
  runtime.lastProgressZ = sample.z;
};
