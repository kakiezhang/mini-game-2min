import type { EnemyKind } from "../config";

export type EnemyAiState =
  | "spawning"
  | "patrolIdle"
  | "patrolMove"
  | "investigate"
  | "chase"
  | "attack"
  | "stuckRecovery"
  | "dead";

export type InvestigationReason =
  | "vision"
  | "proximity"
  | "gunshot"
  | "allyAlert"
  | "lostTarget";

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
  currentX: number;
  currentZ: number;
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
  idleUntil: number;
  investigationX: number;
  investigationZ: number;
  investigationReason?: InvestigationReason;
  reactionUntil: number;
  investigationExpiresAt: number;
  patrolTargetIndex?: number;
  facingX: number;
  facingZ: number;
  surroundAngle: number;
  surroundRadius: number;
  lastAlertAt: number;
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
  state: kind === "boss" ? "chase" : "patrolIdle",
  previousState: "spawning",
  stateEnteredAt: now,
  homeZone: getPatrolZoneAt(x, z),
  currentX: x,
  currentZ: z,
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
  nextPerceptionAt: now + (id % 8) * 0.015625,
  idleUntil: now,
  investigationX: x,
  investigationZ: z,
  reactionUntil: now,
  investigationExpiresAt: now,
  facingX: Math.sin(id * 2.399963),
  facingZ: Math.cos(id * 2.399963),
  surroundAngle: (id * 2.399963) % (Math.PI * 2),
  surroundRadius: kind === "boss" ? 0 : 72,
  lastAlertAt: Number.NEGATIVE_INFINITY,
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

export const getEnemyRecoveryLevel = (runtime: EnemyAiRuntime, now: number) => {
  if (runtime.failure === "none" || runtime.stuckSince === undefined) return 0;
  const stuckFor = Math.max(0, now - runtime.stuckSince);
  if (stuckFor >= 3) return 3;
  if (stuckFor >= 1.5) return 2;
  if (stuckFor >= 0.5) return 1;
  return 0;
};

export const recordEnemyMovement = (runtime: EnemyAiRuntime, sample: EnemyMovementSample) => {
  runtime.currentX = sample.x;
  runtime.currentZ = sample.z;
  runtime.targetX = sample.targetX;
  runtime.targetZ = sample.targetZ;
  runtime.desiredVelocityX = sample.desiredVelocityX;
  runtime.desiredVelocityZ = sample.desiredVelocityZ;
  if (Math.hypot(sample.desiredVelocityX, sample.desiredVelocityZ) > 0.08) {
    const desiredLength = Math.hypot(sample.desiredVelocityX, sample.desiredVelocityZ);
    runtime.facingX = sample.desiredVelocityX / desiredLength;
    runtime.facingZ = sample.desiredVelocityZ / desiredLength;
  }

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
