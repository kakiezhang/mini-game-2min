import type * as THREE from "three";
import type { EnemyKind } from "../config";
import type { NavigationWorld } from "../navigation";
import { ENEMY_AI_TIMING } from "./enemy-ai-config";
import {
  ENEMY_APPROACH_SLOT_INTERVAL,
  assignEnemyApproachSlots,
  getEnemyApproachSlotTarget,
} from "./enemy-approach-slots.js";
import {
  alertEnemyFromAlly,
  confirmEnemyHit,
  updateEnemyBehavior,
  type EnemyBehaviorSample,
  type EnemyNoiseEvent,
} from "./enemy-ai-behavior";
import { EnemyAiDebugLayer } from "./enemy-ai-debug";
import {
  ENEMY_SEPARATION_INTERVAL,
  recomputeEnemySeparation,
  resolveEnemyOverlaps,
} from "./enemy-crowd-movement.js";
import { EnemyAiTelemetry } from "./enemy-ai-telemetry";
import {
  getEnemyMovementDirection,
  type EnemySteeringSample,
} from "./enemy-movement-recovery";
import {
  createEnemyAiRuntime,
  recordEnemyMovement,
  setEnemyAiState,
  type EnemyAiRuntime,
  type EnemyMovementSample,
} from "./enemy-ai-runtime";
import { SeededRandom } from "./seeded-random";

type RegularEnemyKind = Exclude<EnemyKind, "boss">;
type SpawnWeights = Record<RegularEnemyKind, number>;

export type EnemyAiDevelopmentOptions = {
  seed: number;
  forcedKind?: EnemyKind;
  debugEnabled: boolean;
};

const ENEMY_KINDS = new Set<EnemyKind>(["bug", "changeRequest", "meeting", "boss"]);

const createRuntimeSeed = () => {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues(values);
  return values[0] || Date.now() >>> 0;
};

export const readEnemyAiDevelopmentOptions = (search: string): EnemyAiDevelopmentOptions => {
  const params = new URLSearchParams(search);
  const requestedSeed = params.get("aiSeed");
  const requestedKind = params.get("aiEnemy");
  const forcedKind = requestedKind && ENEMY_KINDS.has(requestedKind as EnemyKind)
    ? requestedKind as EnemyKind
    : undefined;

  if (requestedKind && !forcedKind) {
    console.warn(`[Enemy AI] Unknown aiEnemy '${requestedKind}'. Expected bug, changeRequest, meeting, or boss.`);
  }

  const random = new SeededRandom(requestedSeed ?? createRuntimeSeed());
  return {
    seed: random.seed,
    forcedKind,
    debugEnabled: params.get("aiDebug") === "1",
  };
};

export class EnemyAiSystem {
  readonly options: EnemyAiDevelopmentOptions;
  private readonly randomSource: SeededRandom;
  private readonly debugLayer: EnemyAiDebugLayer;
  private readonly telemetry = new EnemyAiTelemetry();
  private readonly runtimes = new Map<number, EnemyAiRuntime>();
  private latestNoise?: EnemyNoiseEvent;
  private separationTimer = 0;
  private approachSlotTimer = 0;
  private approachSlotEvents = {
    assignmentUpdates: 0,
    assignmentChanges: 0,
    invalidations: 0,
    releases: 0,
  };
  private approachSlotCounts = {
    eligibleEnemies: 0,
    assignedEnemies: 0,
    firstRingAssignments: 0,
    secondRingAssignments: 0,
    unassignedEnemies: 0,
  };
  private crowdMetrics = {
    pairChecks: 0,
    overlapPairs: 0,
    correctionApplications: 0,
    recoveryPriorityPairs: 0,
    forwardProgressConstraints: 0,
    blockedCorrections: 0,
    maximumOverlap: 0,
    maximumCorrection: 0,
    maximumRemainingOverlapPairs: 0,
    maximumRemainingOverlap: 0,
  };

  constructor(scene: THREE.Scene, search = window.location.search) {
    this.options = readEnemyAiDevelopmentOptions(search);
    this.randomSource = new SeededRandom(this.options.seed);
    this.debugLayer = new EnemyAiDebugLayer(scene, {
      enabled: this.options.debugEnabled,
      seed: this.options.seed,
      forcedKind: this.options.forcedKind,
    });

    if (this.options.debugEnabled || this.options.forcedKind || new URLSearchParams(search).has("aiSeed")) {
      console.info(
        `[Enemy AI] seed=${this.options.seed} spawn=${this.options.forcedKind ?? "weighted"}; press F3 to toggle debug`,
      );
    }
  }

  random() {
    return this.randomSource.next();
  }

  randomRange(min: number, max: number) {
    return this.randomSource.range(min, max);
  }

  randomInteger(maxExclusive: number) {
    return this.randomSource.integer(maxExclusive);
  }

  pickSpawnKind(weights: SpawnWeights): EnemyKind {
    if (this.options.forcedKind) return this.options.forcedKind;
    const total = weights.bug + weights.changeRequest + weights.meeting;
    const roll = this.random() * total;
    if (roll < weights.bug) return "bug";
    if (roll < weights.bug + weights.changeRequest) return "changeRequest";
    return "meeting";
  }

  createRuntime(id: number, kind: EnemyKind, x: number, z: number, now: number) {
    const runtime = createEnemyAiRuntime(id, kind, x, z, now);
    runtime.idleUntil = now + this.randomRange(
      ENEMY_AI_TIMING.patrolIdleMin,
      ENEMY_AI_TIMING.patrolIdleMax,
    );
    runtime.surroundAngle = this.randomRange(0, Math.PI * 2);
    runtime.surroundRadius = kind === "boss" ? 0 : this.randomRange(34, 118);
    this.runtimes.set(runtime.id, runtime);
    this.telemetry.register(runtime);
    return runtime;
  }

  updateBehavior(
    runtime: EnemyAiRuntime,
    navigation: NavigationWorld,
    sample: Omit<EnemyBehaviorSample, "latestNoise">,
  ) {
    const previousState = runtime.state;
    const approachTarget = getEnemyApproachSlotTarget(
      runtime,
      sample.playerX,
      sample.playerZ,
      sample.playerRadius,
    );
    const decision = updateEnemyBehavior(
      runtime,
      navigation,
      { ...sample, approachTarget, latestNoise: this.latestNoise },
      () => this.random(),
    );
    this.telemetry.recordStateChange(runtime, previousState, sample.now);
    if (decision.shouldAlertAllies) {
      this.alertAllies(runtime, sample.playerX, sample.playerZ, sample.now);
    }
    return decision;
  }

  notifyGunshot(x: number, z: number, now: number) {
    this.latestNoise = { x, z, at: now };
  }

  notifyHit(runtime: EnemyAiRuntime, playerX: number, playerZ: number, now: number) {
    const previousState = runtime.state;
    confirmEnemyHit(runtime, playerX, playerZ, now);
    this.telemetry.recordStateChange(runtime, previousState, now);
    this.alertAllies(runtime, playerX, playerZ, now);
  }

  getMovementDirection(
    runtime: EnemyAiRuntime,
    navigation: NavigationWorld,
    sample: EnemySteeringSample,
  ) {
    const previousState = runtime.state;
    const direction = getEnemyMovementDirection(runtime, navigation, sample);
    this.telemetry.recordStateChange(runtime, previousState, sample.now);
    return direction;
  }

  updateCrowd(
    delta: number,
    navigation: NavigationWorld,
    playerX: number,
    playerZ: number,
    playerRadius: number,
  ) {
    this.approachSlotTimer -= delta;
    if (this.approachSlotTimer <= 0) {
      const assignments = assignEnemyApproachSlots(
        this.runtimes.values(),
        navigation,
        playerX,
        playerZ,
        playerRadius,
      );
      this.approachSlotCounts = {
        eligibleEnemies: assignments.eligibleEnemies,
        assignedEnemies: assignments.assignedEnemies,
        firstRingAssignments: assignments.firstRingAssignments,
        secondRingAssignments: assignments.secondRingAssignments,
        unassignedEnemies: assignments.unassignedEnemies,
      };
      this.approachSlotEvents.assignmentUpdates += 1;
      this.approachSlotEvents.assignmentChanges += assignments.assignmentChanges;
      this.approachSlotEvents.invalidations += assignments.invalidations;
      this.approachSlotEvents.releases += assignments.releases;
      this.approachSlotTimer = ENEMY_APPROACH_SLOT_INTERVAL;
    }

    this.separationTimer -= delta;
    if (this.separationTimer > 0) return;
    recomputeEnemySeparation(this.runtimes.values());
    this.separationTimer = ENEMY_SEPARATION_INTERVAL;
  }

  resolveCrowdOverlaps(navigation: NavigationWorld) {
    const resolution = resolveEnemyOverlaps(this.runtimes.values(), navigation);
    this.crowdMetrics.pairChecks += resolution.pairChecks;
    this.crowdMetrics.overlapPairs += resolution.overlapPairs;
    this.crowdMetrics.correctionApplications += resolution.correctionApplications;
    this.crowdMetrics.recoveryPriorityPairs += resolution.recoveryPriorityPairs;
    this.crowdMetrics.forwardProgressConstraints += resolution.forwardProgressConstraints;
    this.crowdMetrics.blockedCorrections += resolution.blockedCorrections;
    this.crowdMetrics.maximumOverlap = Math.max(
      this.crowdMetrics.maximumOverlap,
      resolution.maximumOverlap,
    );
    this.crowdMetrics.maximumCorrection = Math.max(
      this.crowdMetrics.maximumCorrection,
      resolution.maximumCorrection,
    );
    this.crowdMetrics.maximumRemainingOverlapPairs = Math.max(
      this.crowdMetrics.maximumRemainingOverlapPairs,
      resolution.remainingOverlapPairs,
    );
    this.crowdMetrics.maximumRemainingOverlap = Math.max(
      this.crowdMetrics.maximumRemainingOverlap,
      resolution.maximumRemainingOverlap,
    );
  }

  recordMovement(runtime: EnemyAiRuntime, sample: EnemyMovementSample, height: number) {
    const previousFailure = runtime.failure;
    const previousStuckSince = runtime.stuckSince;
    recordEnemyMovement(runtime, sample);
    this.telemetry.recordFailureChange(runtime, previousFailure, previousStuckSince, sample.now);
    this.debugLayer.update(runtime, { x: sample.x, z: sample.z, height });
  }

  takePerformanceSnapshot(now: number) {
    const crowd = { ...this.crowdMetrics };
    const approachSlots = { ...this.approachSlotCounts, ...this.approachSlotEvents };
    for (const key of Object.keys(this.crowdMetrics) as Array<keyof typeof this.crowdMetrics>) {
      this.crowdMetrics[key] = 0;
    }
    for (const key of Object.keys(this.approachSlotEvents) as Array<keyof typeof this.approachSlotEvents>) {
      this.approachSlotEvents[key] = 0;
    }
    return { ...this.telemetry.takeSnapshot(now), crowd, approachSlots };
  }

  remove(runtime: EnemyAiRuntime, now: number) {
    setEnemyAiState(runtime, "dead", now);
    this.runtimes.delete(runtime.id);
    runtime.approachSlotId = undefined;
    this.telemetry.unregister(runtime);
    this.debugLayer.remove(runtime.id);
  }

  private alertAllies(source: EnemyAiRuntime, x: number, z: number, now: number) {
    for (const runtime of this.runtimes.values()) {
      if (runtime === source || runtime.kind === "boss") continue;
      if (Math.hypot(runtime.currentX - source.currentX, runtime.currentZ - source.currentZ) > ENEMY_AI_TIMING.allyAlertRadius) {
        continue;
      }
      const previousState = runtime.state;
      alertEnemyFromAlly(runtime, x, z, now);
      this.telemetry.recordStateChange(runtime, previousState, now);
    }
  }
}
