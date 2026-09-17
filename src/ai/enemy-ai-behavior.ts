import type { NavigationWorld } from "../navigation.js";
import { ENEMY_AI_TIMING, ENEMY_PERCEPTION } from "./enemy-ai-config.js";
import { choosePatrolTarget } from "./enemy-patrol.js";
import {
  setEnemyAiState,
  type EnemyAiRuntime,
  type EnemyAiState,
  type InvestigationReason,
} from "./enemy-ai-runtime.js";

export type EnemyNoiseEvent = {
  x: number;
  z: number;
  at: number;
};

export type EnemyBehaviorSample = {
  now: number;
  x: number;
  z: number;
  radius: number;
  playerX: number;
  playerZ: number;
  playerRadius: number;
  latestNoise?: EnemyNoiseEvent;
};

export type EnemyBehaviorDecision = {
  targetX: number;
  targetZ: number;
  flowTargetX: number;
  flowTargetZ: number;
  speedMultiplier: number;
  canAttack: boolean;
  shouldAlertAllies: boolean;
};

const activeState = (runtime: EnemyAiRuntime) => (
  runtime.state === "stuckRecovery" ? runtime.previousState : runtime.state
);

const transitionBehavior = (runtime: EnemyAiRuntime, state: EnemyAiState, now: number) => {
  if (runtime.state === "stuckRecovery") {
    runtime.previousState = state;
    return;
  }
  setEnemyAiState(runtime, state, now);
};

const clearPathToPlayer = (
  navigation: NavigationWorld,
  x: number,
  z: number,
  playerX: number,
  playerZ: number,
  distance: number,
) => {
  if (distance < 0.001) return true;
  const directionX = (playerX - x) / distance;
  const directionZ = (playerZ - z) / distance;
  return navigation.raycastObstacleDistance(x, z, directionX, directionZ, distance) >= distance - 1;
};

const canSeePlayer = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemyBehaviorSample,
  distance: number,
) => {
  const config = ENEMY_PERCEPTION[runtime.kind];
  if (distance > config.visionRange) return false;
  const directionX = distance > 0.001 ? (sample.playerX - sample.x) / distance : runtime.facingX;
  const directionZ = distance > 0.001 ? (sample.playerZ - sample.z) / distance : runtime.facingZ;
  const minimumDot = Math.cos((config.fieldOfViewDegrees * Math.PI) / 360);
  if (runtime.facingX * directionX + runtime.facingZ * directionZ < minimumDot) return false;
  return clearPathToPlayer(
    navigation,
    sample.x,
    sample.z,
    sample.playerX,
    sample.playerZ,
    distance,
  );
};

const rememberPlayer = (runtime: EnemyAiRuntime, sample: EnemyBehaviorSample) => {
  runtime.lastSeenPlayerX = sample.playerX;
  runtime.lastSeenPlayerZ = sample.playerZ;
  runtime.lastSeenAt = sample.now;
};

const beginInvestigation = (
  runtime: EnemyAiRuntime,
  x: number,
  z: number,
  now: number,
  reason: InvestigationReason,
  duration: number = ENEMY_AI_TIMING.investigationDuration,
  reactionTime: number = ENEMY_AI_TIMING.reactionTime,
) => {
  runtime.investigationX = x;
  runtime.investigationZ = z;
  runtime.investigationReason = reason;
  runtime.reactionUntil = now + reactionTime;
  runtime.investigationExpiresAt = now + duration;
  if (reason === "gunshot" || reason === "allyAlert") {
    runtime.lastHeardX = x;
    runtime.lastHeardZ = z;
    runtime.lastHeardAt = now;
  }
  runtime.path = [];
  runtime.pathIndex = 0;
  transitionBehavior(runtime, "investigate", now);
};

const beginPatrolIdle = (
  runtime: EnemyAiRuntime,
  now: number,
  random: () => number,
) => {
  runtime.path = [];
  runtime.pathIndex = 0;
  runtime.idleUntil = now + ENEMY_AI_TIMING.patrolIdleMin
    + random() * (ENEMY_AI_TIMING.patrolIdleMax - ENEMY_AI_TIMING.patrolIdleMin);
  transitionBehavior(runtime, "patrolIdle", now);
};

const beginPatrolMove = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  radius: number,
  now: number,
  random: () => number,
) => {
  const target = choosePatrolTarget(runtime, navigation, radius, random);
  if (!target) {
    beginPatrolIdle(runtime, now, random);
    return;
  }
  runtime.patrolTargetIndex = target.pointIndex;
  runtime.path = target.path;
  runtime.pathIndex = 0;
  runtime.targetX = target.point.x;
  runtime.targetZ = target.point.z;
  transitionBehavior(runtime, "patrolMove", now);
};

const followPatrolPath = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemyBehaviorSample,
  random: () => number,
) => {
  const arrivalDistance = Math.max(24, sample.radius * 0.9);
  while (runtime.pathIndex < runtime.path.length) {
    const waypoint = runtime.path[runtime.pathIndex];
    if (Math.hypot(waypoint.x - sample.x, waypoint.z - sample.z) > arrivalDistance) break;
    runtime.pathIndex += 1;
  }
  if (runtime.pathIndex >= runtime.path.length) {
    beginPatrolIdle(runtime, sample.now, random);
    return { x: sample.x, z: sample.z };
  }
  const waypoint = runtime.path[runtime.pathIndex];
  if (!navigation.canOccupy(waypoint.x, waypoint.z, sample.radius)) {
    beginPatrolMove(runtime, navigation, sample.radius, sample.now, random);
    return runtime.path[runtime.pathIndex] ?? { x: sample.x, z: sample.z };
  }

  // Paths are built from grid cells and may contain more turns than the
  // collision geometry requires. Follow the farthest currently visible point
  // so large enemies do not repeatedly squeeze past redundant corner points.
  for (let index = runtime.path.length - 1; index > runtime.pathIndex; index -= 1) {
    const candidate = runtime.path[index];
    if (
      navigation.canOccupy(candidate.x, candidate.z, sample.radius)
      && navigation.canMoveDirectly(sample.x, sample.z, candidate.x, candidate.z, sample.radius)
    ) {
      runtime.pathIndex = index;
      return candidate;
    }
  }
  return waypoint;
};

export const alertEnemyFromAlly = (
  runtime: EnemyAiRuntime,
  x: number,
  z: number,
  now: number,
) => {
  if (runtime.kind === "boss" || runtime.state === "dead") return;
  const state = activeState(runtime);
  if (state === "chase" || state === "attack") return;
  beginInvestigation(runtime, x, z, now, "allyAlert");
};

export const confirmEnemyHit = (
  runtime: EnemyAiRuntime,
  playerX: number,
  playerZ: number,
  now: number,
) => {
  if (runtime.state === "dead") return;
  runtime.lastSeenPlayerX = playerX;
  runtime.lastSeenPlayerZ = playerZ;
  runtime.lastSeenAt = now;
  runtime.path = [];
  runtime.pathIndex = 0;
  transitionBehavior(runtime, "chase", now);
};

export const updateEnemyBehavior = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemyBehaviorSample,
  random: () => number,
): EnemyBehaviorDecision => {
  runtime.currentX = sample.x;
  runtime.currentZ = sample.z;
  const config = ENEMY_PERCEPTION[runtime.kind];
  const playerDistance = Math.hypot(sample.playerX - sample.x, sample.playerZ - sample.z);
  let sawPlayer = false;

  if (runtime.kind === "boss") {
    rememberPlayer(runtime, sample);
    transitionBehavior(runtime, "chase", sample.now);
  } else {
    const nearPlayer = playerDistance <= config.proximityRange
      && clearPathToPlayer(
        navigation,
        sample.x,
        sample.z,
        sample.playerX,
        sample.playerZ,
        playerDistance,
      );
    if (nearPlayer || sample.now >= runtime.nextPerceptionAt) {
      sawPlayer = nearPlayer || canSeePlayer(runtime, navigation, sample, playerDistance);
      runtime.nextPerceptionAt = sample.now + ENEMY_AI_TIMING.perceptionInterval;
      if (sawPlayer) {
        rememberPlayer(runtime, sample);
        const state = activeState(runtime);
        const reason = nearPlayer ? "proximity" : "vision";
        if (state === "patrolIdle" || state === "patrolMove") {
          beginInvestigation(runtime, sample.playerX, sample.playerZ, sample.now, reason);
        } else if (state === "investigate") {
          runtime.investigationX = sample.playerX;
          runtime.investigationZ = sample.playerZ;
          runtime.investigationReason = reason;
          runtime.investigationExpiresAt = sample.now + ENEMY_AI_TIMING.investigationDuration;
        }
      }
    }

    const noise = sample.latestNoise;
    if (
      noise
      && noise.at > runtime.lastHeardAt
      && sample.now - noise.at <= ENEMY_AI_TIMING.noiseLifetime
      && Math.hypot(noise.x - sample.x, noise.z - sample.z) <= config.hearingRange
      && activeState(runtime) !== "chase"
      && activeState(runtime) !== "attack"
    ) {
      beginInvestigation(runtime, noise.x, noise.z, noise.at, "gunshot");
    }
  }

  let state = activeState(runtime);
  const hasFreshSight = sample.now - runtime.lastSeenAt <= ENEMY_AI_TIMING.perceptionInterval * 1.5;
  if (state === "investigate") {
    if (hasFreshSight && sample.now >= runtime.reactionUntil) {
      transitionBehavior(runtime, "chase", sample.now);
    } else if (!hasFreshSight && sample.now >= runtime.reactionUntil) {
      const reachedTarget = Math.hypot(
        runtime.investigationX - sample.x,
        runtime.investigationZ - sample.z,
      ) <= 28;
      const expired = sample.now >= runtime.investigationExpiresAt;
      const shouldFinish = runtime.investigationReason === "lostTarget"
        ? expired
        : reachedTarget || expired;
      if (shouldFinish) beginPatrolMove(runtime, navigation, sample.radius, sample.now, random);
    }
  }

  state = activeState(runtime);
  if ((state === "chase" || state === "attack") && sample.now - runtime.lastSeenAt > ENEMY_AI_TIMING.targetMemory) {
    beginInvestigation(
      runtime,
      runtime.lastSeenPlayerX,
      runtime.lastSeenPlayerZ,
      sample.now,
      "lostTarget",
      ENEMY_AI_TIMING.lostTargetInvestigationDuration,
      0,
    );
  }

  state = activeState(runtime);
  const attackEnterDistance = sample.playerRadius + sample.radius + 5;
  const attackLeaveDistance = attackEnterDistance + 10;
  if (state === "chase" && playerDistance <= attackEnterDistance) {
    transitionBehavior(runtime, "attack", sample.now);
  } else if (state === "attack" && playerDistance > attackLeaveDistance) {
    transitionBehavior(runtime, "chase", sample.now);
  }

  state = activeState(runtime);
  if (state === "patrolIdle" && sample.now >= runtime.idleUntil) {
    beginPatrolMove(runtime, navigation, sample.radius, sample.now, random);
  }

  state = activeState(runtime);
  let targetX = sample.x;
  let targetZ = sample.z;
  let flowTargetX = targetX;
  let flowTargetZ = targetZ;
  let speedMultiplier = 0;

  if (state === "patrolMove") {
    const waypoint = followPatrolPath(runtime, navigation, sample, random);
    targetX = waypoint.x;
    targetZ = waypoint.z;
    flowTargetX = waypoint.x;
    flowTargetZ = waypoint.z;
    speedMultiplier = config.patrolSpeedMultiplier;
  } else if (state === "investigate") {
    targetX = runtime.investigationX;
    targetZ = runtime.investigationZ;
    flowTargetX = targetX;
    flowTargetZ = targetZ;
    speedMultiplier = runtime.investigationReason === "lostTarget" ? 0.62 : 0.78;
  } else if (state === "chase" || state === "attack") {
    flowTargetX = hasFreshSight || runtime.kind === "boss" ? sample.playerX : runtime.lastSeenPlayerX;
    flowTargetZ = hasFreshSight || runtime.kind === "boss" ? sample.playerZ : runtime.lastSeenPlayerZ;
    const orbitAngle = runtime.surroundAngle + sample.now * 0.18;
    if (playerDistance < 210 && runtime.surroundRadius > 0) {
      targetX = flowTargetX + Math.cos(orbitAngle) * runtime.surroundRadius;
      targetZ = flowTargetZ + Math.sin(orbitAngle) * runtime.surroundRadius;
    } else {
      targetX = flowTargetX;
      targetZ = flowTargetZ;
    }
    speedMultiplier = 1;
  }

  runtime.targetX = targetX;
  runtime.targetZ = targetZ;
  const shouldAlertAllies = sawPlayer
    && (state === "chase" || state === "attack")
    && sample.now - runtime.lastAlertAt >= ENEMY_AI_TIMING.allyAlertCooldown;
  if (shouldAlertAllies) runtime.lastAlertAt = sample.now;

  return {
    targetX,
    targetZ,
    flowTargetX,
    flowTargetZ,
    speedMultiplier,
    canAttack: state === "attack",
    shouldAlertAllies,
  };
};
