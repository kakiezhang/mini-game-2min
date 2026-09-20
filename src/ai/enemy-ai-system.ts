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
  classifyEnemyMovementFailureCause,
  EnemyMovementFailureEvidence,
  findEnemyMovementBlocker,
  getEnemyCrowdYieldDirection,
  shouldEnemyYieldToBlocker,
} from "./enemy-movement-failure.js";
import {
  getEnemyMovementDirection,
  type EnemyMovementDirection,
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
import { pickAvailableSpawnKind, type SpawnWeights } from "./enemy-spawn-selection.js";

export type EnemyAiDevelopmentOptions = {
  seed: number;
  forcedKind?: EnemyKind;
  debugEnabled: boolean;
};

const ENEMY_KINDS = new Set<EnemyKind>(["bug", "changeRequest", "meeting", "boss"]);
const CROWD_YIELD_DURATION = 1.5;

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
  private readonly movementFailureEvidence = new EnemyMovementFailureEvidence();
  private readonly runtimes = new Map<number, EnemyAiRuntime>();
  private readonly crowdYields = new Map<number, { blockerId: number; until: number }>();
  private latestNoise?: EnemyNoiseEvent;
  private separationTimer = 0;
  private approachSlotTimer = 0;
  private approachSlotEvents = {
    assignmentUpdates: 0,
    assignmentChanges: 0,
    invalidations: 0,
    releases: 0,
    invalidTargetMisses: 0,
    capacityMisses: 0,
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
    dualRecoveryYieldPairs: 0,
    recoveryYieldStarts: 0,
    maximumActiveYields: 0,
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

  pickSpawnKind(weights: SpawnWeights, activeEnemies: Iterable<{ kind: EnemyKind }>): EnemyKind | undefined {
    if (this.options.forcedKind) return this.options.forcedKind;
    return pickAvailableSpawnKind(weights, activeEnemies, () => this.random());
  }

  createRuntime(id: number, kind: EnemyKind, x: number, z: number, now: number, spawning = false) {
    const runtime = createEnemyAiRuntime(id, kind, x, z, now);
    if (spawning) runtime.state = "spawning";
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

  activateSpawn(runtime: EnemyAiRuntime, now: number) {
    if (runtime.state !== "spawning") return;
    const previousState = runtime.state;
    setEnemyAiState(runtime, runtime.kind === "boss" ? "chase" : "patrolIdle", now);
    runtime.idleUntil = now + (runtime.kind === "boss" ? 0 : this.randomRange(
      ENEMY_AI_TIMING.patrolIdleMin,
      ENEMY_AI_TIMING.patrolIdleMax,
    ));
    runtime.nextPerceptionAt = now;
    runtime.lastProgressAt = now;
    runtime.lastProgressX = runtime.currentX;
    runtime.lastProgressZ = runtime.currentZ;
    this.telemetry.recordStateChange(runtime, previousState, now);
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
    const failureCause = classifyEnemyMovementFailureCause(
      runtime,
      navigation,
      sample,
      direction,
      this.getActiveRuntimes(),
    );
    this.movementFailureEvidence.record(
      runtime.id,
      failureCause,
    );
    this.telemetry.recordStateChange(runtime, previousState, sample.now);
    return this.applyCrowdYield(runtime, navigation, sample, direction, failureCause);
  }

  updateCrowd(
    delta: number,
    navigation: NavigationWorld,
    playerX: number,
    playerZ: number,
    playerRadius: number,
  ) {
    const activeRuntimes = this.getActiveRuntimes();
    this.approachSlotTimer -= delta;
    if (this.approachSlotTimer <= 0) {
      const assignments = assignEnemyApproachSlots(
        activeRuntimes,
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
      this.approachSlotEvents.invalidTargetMisses += assignments.invalidTargetMisses;
      this.approachSlotEvents.capacityMisses += assignments.capacityMisses;
      this.approachSlotTimer = ENEMY_APPROACH_SLOT_INTERVAL;
    }

    this.separationTimer -= delta;
    if (this.separationTimer > 0) return;
    recomputeEnemySeparation(activeRuntimes);
    this.separationTimer = ENEMY_SEPARATION_INTERVAL;
  }

  resolveCrowdOverlaps(navigation: NavigationWorld) {
    const resolution = resolveEnemyOverlaps(this.getActiveRuntimes(), navigation);
    this.crowdMetrics.pairChecks += resolution.pairChecks;
    this.crowdMetrics.overlapPairs += resolution.overlapPairs;
    this.crowdMetrics.correctionApplications += resolution.correctionApplications;
    this.crowdMetrics.recoveryPriorityPairs += resolution.recoveryPriorityPairs;
    this.crowdMetrics.dualRecoveryYieldPairs += resolution.dualRecoveryYieldPairs;
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
    const previousFailureCause = runtime.failureCause;
    const previousStuckSince = runtime.stuckSince;
    const previousProgressAt = runtime.lastProgressAt;
    recordEnemyMovement(runtime, {
      ...sample,
      failureCause: this.movementFailureEvidence.peek(runtime.id),
    });
    if (runtime.lastProgressAt !== previousProgressAt) {
      this.movementFailureEvidence.reset(runtime.id);
    }
    this.telemetry.recordFailureChange(
      runtime,
      previousFailure,
      previousFailureCause,
      previousStuckSince,
      sample.now,
    );
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
    runtime.approachSlotFailure = "none";
    this.movementFailureEvidence.reset(runtime.id);
    this.crowdYields.delete(runtime.id);
    this.telemetry.unregister(runtime);
    this.debugLayer.remove(runtime.id);
  }

  private applyCrowdYield(
    runtime: EnemyAiRuntime,
    navigation: NavigationWorld,
    sample: EnemySteeringSample,
    direction: EnemyMovementDirection,
    failureCause: ReturnType<typeof classifyEnemyMovementFailureCause>,
  ) {
    let activeYield = this.crowdYields.get(runtime.id);
    if (activeYield && activeYield.until <= sample.now) {
      this.crowdYields.delete(runtime.id);
      activeYield = undefined;
    }

    const isCrowdRecovery = runtime.state === "stuckRecovery"
      && (runtime.failureCause === "crowdBlocked" || failureCause === "crowdBlocked");
    if (isCrowdRecovery) {
      const blocker = findEnemyMovementBlocker(
        runtime,
        this.getActiveRuntimes(),
        sample,
        direction,
      );
      if (blocker && shouldEnemyYieldToBlocker(runtime, blocker)) {
        if (!activeYield || activeYield.blockerId !== blocker.id) {
          activeYield = { blockerId: blocker.id, until: sample.now + CROWD_YIELD_DURATION };
          this.crowdYields.set(runtime.id, activeYield);
          this.crowdMetrics.recoveryYieldStarts += 1;
          this.crowdMetrics.maximumActiveYields = Math.max(
            this.crowdMetrics.maximumActiveYields,
            this.crowdYields.size,
          );
        }
      }
    }

    if (!activeYield) return direction;
    const blocker = this.runtimes.get(activeYield.blockerId);
    if (!blocker) {
      this.crowdYields.delete(runtime.id);
      return direction;
    }
    return getEnemyCrowdYieldDirection(runtime, blocker, navigation, sample, direction);
  }

  private alertAllies(source: EnemyAiRuntime, x: number, z: number, now: number) {
    for (const runtime of this.getActiveRuntimes()) {
      if (runtime === source || runtime.kind === "boss") continue;
      if (Math.hypot(runtime.currentX - source.currentX, runtime.currentZ - source.currentZ) > ENEMY_AI_TIMING.allyAlertRadius) {
        continue;
      }
      const previousState = runtime.state;
      alertEnemyFromAlly(runtime, x, z, now);
      this.telemetry.recordStateChange(runtime, previousState, now);
    }
  }

  private getActiveRuntimes() {
    return Array.from(this.runtimes.values()).filter((runtime) => (
      runtime.state !== "spawning" && runtime.state !== "dead"
    ));
  }
}
