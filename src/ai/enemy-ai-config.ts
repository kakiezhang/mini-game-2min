import type { EnemyKind } from "../config";

export type EnemyPerceptionConfig = {
  proximityRange: number;
  visionRange: number;
  fieldOfViewDegrees: number;
  hearingRange: number;
  patrolSpeedMultiplier: number;
};

export const ENEMY_AI_TIMING = {
  perceptionInterval: 0.125,
  reactionTime: 0.3,
  targetMemory: 2.5,
  investigationDuration: 4,
  lostTargetInvestigationDuration: 3,
  patrolIdleMin: 0.6,
  patrolIdleMax: 1.8,
  allyAlertRadius: 220,
  allyAlertCooldown: 0.75,
  noiseLifetime: 0.6,
} as const;

export const ENEMY_PERCEPTION: Record<EnemyKind, EnemyPerceptionConfig> = {
  bug: {
    proximityRange: 170,
    visionRange: 480,
    fieldOfViewDegrees: 220,
    hearingRange: 680,
    patrolSpeedMultiplier: 0.6,
  },
  changeRequest: {
    proximityRange: 180,
    visionRange: 520,
    fieldOfViewDegrees: 200,
    hearingRange: 700,
    patrolSpeedMultiplier: 0.65,
  },
  meeting: {
    proximityRange: 160,
    visionRange: 420,
    fieldOfViewDegrees: 220,
    hearingRange: 600,
    patrolSpeedMultiplier: 0.48,
  },
  boss: {
    proximityRange: Number.POSITIVE_INFINITY,
    visionRange: Number.POSITIVE_INFINITY,
    fieldOfViewDegrees: 360,
    hearingRange: Number.POSITIVE_INFINITY,
    patrolSpeedMultiplier: 1,
  },
};
