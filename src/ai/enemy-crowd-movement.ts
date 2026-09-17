import { ENEMY_CONFIG, type EnemyKind } from "../config.js";
import type { EnemyAiRuntime } from "./enemy-ai-runtime.js";

export const ENEMY_SEPARATION_INTERVAL = 0.08;

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
