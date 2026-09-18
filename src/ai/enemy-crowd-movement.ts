import { ENEMY_CONFIG, type EnemyKind } from "../config.js";
import type { NavigationWorld } from "../navigation.js";
import type { EnemyAiRuntime } from "./enemy-ai-runtime.js";

export const ENEMY_SEPARATION_INTERVAL = 0.08;
export const ENEMY_OVERLAP_ITERATIONS = 2;

const MAX_BODY_CORRECTION_PER_ITERATION = 8;
const ALLOWED_OVERLAP_RADIUS_RATIO = 0.2;

const PERSONAL_GAP: Record<EnemyKind, number> = {
  bug: 12,
  changeRequest: 8,
  meeting: 14,
  boss: 14,
};

const stablePairDirection = (firstId: number, secondId: number) => {
  const lowId = Math.min(firstId, secondId);
  const highId = Math.max(firstId, secondId);
  const hash = (
    Math.imul(lowId + 1, 73856093)
    ^ Math.imul(highId + 1, 19349663)
  ) >>> 0;
  const angle = (hash / 0x100000000) * Math.PI * 2;
  const sign = firstId === lowId ? 1 : -1;
  return {
    x: Math.cos(angle) * sign,
    z: Math.sin(angle) * sign,
  };
};

const addSeparation = (
  runtime: EnemyAiRuntime,
  directionX: number,
  directionZ: number,
  strength: number,
) => {
  if (runtime.kind === "boss") return;
  runtime.separationX += directionX * strength;
  runtime.separationZ += directionZ * strength;
};

export const recomputeEnemySeparation = (runtimes: Iterable<EnemyAiRuntime>) => {
  const enemies = Array.from(runtimes, (runtime) => {
    runtime.separationX = 0;
    runtime.separationZ = 0;
    return runtime;
  });

  for (let index = 0; index < enemies.length; index += 1) {
    const enemy = enemies[index];
    for (let otherIndex = index + 1; otherIndex < enemies.length; otherIndex += 1) {
      const other = enemies[otherIndex];
      const dx = enemy.currentX - other.currentX;
      const dz = enemy.currentZ - other.currentZ;
      const distanceSquared = dx * dx + dz * dz;
      const personalGap = (PERSONAL_GAP[enemy.kind] + PERSONAL_GAP[other.kind]) / 2;
      const minimumDistance = ENEMY_CONFIG[enemy.kind].radius
        + ENEMY_CONFIG[other.kind].radius
        + personalGap;
      if (distanceSquared >= minimumDistance * minimumDistance) continue;

      const distance = Math.sqrt(distanceSquared);
      const direction = distance > 0.001
        ? { x: dx / distance, z: dz / distance }
        : stablePairDirection(enemy.id, other.id);
      const strength = Math.min(1, Math.max(0, (minimumDistance - distance) / personalGap));
      const enemyShare = other.kind === "boss" ? 1 : 0.5;
      const otherShare = enemy.kind === "boss" ? 1 : 0.5;
      addSeparation(enemy, direction.x, direction.z, strength * enemyShare);
      addSeparation(other, -direction.x, -direction.z, strength * otherShare);
    }
  }
};

export type EnemyOverlapResolution = {
  pairChecks: number;
  overlapPairs: number;
  correctionApplications: number;
  recoveryPriorityPairs: number;
  forwardProgressConstraints: number;
  blockedCorrections: number;
  maximumOverlap: number;
  maximumCorrection: number;
  remainingOverlapPairs: number;
  maximumRemainingOverlap: number;
};

const createOverlapResolution = (): EnemyOverlapResolution => ({
  pairChecks: 0,
  overlapPairs: 0,
  correctionApplications: 0,
  recoveryPriorityPairs: 0,
  forwardProgressConstraints: 0,
  blockedCorrections: 0,
  maximumOverlap: 0,
  maximumCorrection: 0,
  remainingOverlapPairs: 0,
  maximumRemainingOverlap: 0,
});

const getCorrectionShares = (enemy: EnemyAiRuntime, other: EnemyAiRuntime) => {
  const enemyRecovering = enemy.state === "stuckRecovery";
  const otherRecovering = other.state === "stuckRecovery";
  if (enemyRecovering && otherRecovering) return { enemy: 0, other: 0, recoveryPriority: true };
  if (enemyRecovering) {
    return { enemy: 0, other: other.kind === "boss" ? 0 : 1, recoveryPriority: true };
  }
  if (otherRecovering) {
    return { enemy: enemy.kind === "boss" ? 0 : 1, other: 0, recoveryPriority: true };
  }
  if (enemy.kind === "boss" && other.kind !== "boss") {
    return { enemy: 0, other: 1, recoveryPriority: false };
  }
  if (other.kind === "boss" && enemy.kind !== "boss") {
    return { enemy: 1, other: 0, recoveryPriority: false };
  }
  return { enemy: 0.5, other: 0.5, recoveryPriority: false };
};

const preserveForwardProgress = (
  runtime: EnemyAiRuntime,
  correctionX: number,
  correctionZ: number,
) => {
  const desiredLength = Math.hypot(runtime.desiredVelocityX, runtime.desiredVelocityZ);
  if (desiredLength < 0.08) return { x: correctionX, z: correctionZ, constrained: false };
  const forwardX = runtime.desiredVelocityX / desiredLength;
  const forwardZ = runtime.desiredVelocityZ / desiredLength;
  const forwardComponent = correctionX * forwardX + correctionZ * forwardZ;
  if (forwardComponent >= 0) return { x: correctionX, z: correctionZ, constrained: false };
  return {
    x: correctionX - forwardX * forwardComponent,
    z: correctionZ - forwardZ * forwardComponent,
    constrained: true,
  };
};

const getActionableOverlap = (enemy: EnemyAiRuntime, other: EnemyAiRuntime, distance: number) => {
  const enemyRadius = ENEMY_CONFIG[enemy.kind].radius;
  const otherRadius = ENEMY_CONFIG[other.kind].radius;
  const allowedOverlap = Math.min(enemyRadius, otherRadius) * ALLOWED_OVERLAP_RADIUS_RATIO;
  return enemyRadius + otherRadius - distance - allowedOverlap;
};

const limitCorrection = (x: number, z: number) => {
  const length = Math.hypot(x, z);
  if (length <= MAX_BODY_CORRECTION_PER_ITERATION) return { x, z, length };
  const scale = MAX_BODY_CORRECTION_PER_ITERATION / length;
  return {
    x: x * scale,
    z: z * scale,
    length: MAX_BODY_CORRECTION_PER_ITERATION,
  };
};

/**
 * Resolves actual circle overlap after regular static-collision movement.
 * Corrections are accumulated before application so crowded groups do not
 * depend on pair iteration order, then projected through NavigationWorld.
 */
export const resolveEnemyOverlaps = (
  runtimes: Iterable<EnemyAiRuntime>,
  navigation: NavigationWorld,
): EnemyOverlapResolution => {
  const enemies = Array.from(runtimes);
  const result = createOverlapResolution();
  if (enemies.length < 2) return result;

  const correctionX = new Float64Array(enemies.length);
  const correctionZ = new Float64Array(enemies.length);

  for (let iteration = 0; iteration < ENEMY_OVERLAP_ITERATIONS; iteration += 1) {
    correctionX.fill(0);
    correctionZ.fill(0);
    let foundOverlap = false;

    for (let index = 0; index < enemies.length; index += 1) {
      const enemy = enemies[index];
      for (let otherIndex = index + 1; otherIndex < enemies.length; otherIndex += 1) {
        const other = enemies[otherIndex];
        result.pairChecks += 1;
        const dx = enemy.currentX - other.currentX;
        const dz = enemy.currentZ - other.currentZ;
        const distanceSquared = dx * dx + dz * dz;
        const distance = Math.sqrt(distanceSquared);
        const overlap = getActionableOverlap(enemy, other, distance);
        if (overlap <= 0) continue;

        foundOverlap = true;
        result.overlapPairs += 1;
        result.maximumOverlap = Math.max(result.maximumOverlap, overlap);
        const direction = distance > 0.001
          ? { x: dx / distance, z: dz / distance }
          : stablePairDirection(enemy.id, other.id);
        const shares = getCorrectionShares(enemy, other);
        if (shares.recoveryPriority) result.recoveryPriorityPairs += 1;
        correctionX[index] += direction.x * overlap * shares.enemy;
        correctionZ[index] += direction.z * overlap * shares.enemy;
        correctionX[otherIndex] -= direction.x * overlap * shares.other;
        correctionZ[otherIndex] -= direction.z * overlap * shares.other;
      }
    }

    if (!foundOverlap) break;
    let movedThisIteration = false;
    for (let index = 0; index < enemies.length; index += 1) {
      const enemy = enemies[index];
      const progressSafe = preserveForwardProgress(
        enemy,
        correctionX[index],
        correctionZ[index],
      );
      if (progressSafe.constrained) result.forwardProgressConstraints += 1;
      const correction = limitCorrection(progressSafe.x, progressSafe.z);
      if (correction.length < 0.0001) continue;
      const radius = ENEMY_CONFIG[enemy.kind].radius;
      const moved = navigation.moveCircle(
        enemy.currentX,
        enemy.currentZ,
        correction.x,
        correction.z,
        radius,
      );
      const appliedDistance = Math.hypot(
        moved.x - enemy.currentX,
        moved.z - enemy.currentZ,
      );
      if (appliedDistance < 0.0001) {
        result.blockedCorrections += 1;
        continue;
      }
      enemy.currentX = moved.x;
      enemy.currentZ = moved.z;
      movedThisIteration = true;
      result.correctionApplications += 1;
      result.maximumCorrection = Math.max(result.maximumCorrection, appliedDistance);
    }
    if (!movedThisIteration) break;
  }

  for (let index = 0; index < enemies.length; index += 1) {
    const enemy = enemies[index];
    for (let otherIndex = index + 1; otherIndex < enemies.length; otherIndex += 1) {
      const other = enemies[otherIndex];
      const distance = Math.hypot(
        enemy.currentX - other.currentX,
        enemy.currentZ - other.currentZ,
      );
      const overlap = getActionableOverlap(enemy, other, distance);
      if (overlap <= 0.001) continue;
      result.remainingOverlapPairs += 1;
      result.maximumRemainingOverlap = Math.max(result.maximumRemainingOverlap, overlap);
    }
  }

  return result;
};
