import type {
  EnemyAiRuntime,
  EnemyAiState,
  EnemyMovementFailure,
} from "./enemy-ai-runtime";

type FailureCounts = Record<EnemyMovementFailure, number>;
type StateCounts = Record<EnemyAiState, number>;

type EnemyStateTransition = {
  at: number;
  id: number;
  kind: EnemyAiRuntime["kind"];
  from: EnemyAiState;
  to: EnemyAiState;
  investigationReason?: EnemyAiRuntime["investigationReason"];
  position: { x: number; z: number };
  target: { x: number; z: number };
};

type EnemyFailureTransition = {
  at: number;
  id: number;
  kind: EnemyAiRuntime["kind"];
  state: EnemyAiRuntime["state"];
  from: EnemyMovementFailure;
  to: EnemyMovementFailure;
  stuckForSeconds: number;
  position: { x: number; z: number };
  target: { x: number; z: number };
  recoveryLevel: number;
};

const MAX_QUEUED_TRANSITIONS = 64;

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const getStuckDuration = (now: number, stuckSince?: number) => (
  stuckSince === undefined ? 0 : Math.max(0, now - stuckSince)
);

const getActiveInvestigationReason = (runtime: EnemyAiRuntime) => (
  runtime.state === "investigate"
  || (runtime.state === "stuckRecovery" && runtime.previousState === "investigate")
    ? runtime.investigationReason
    : undefined
);

const createEnemyDetails = (runtime: EnemyAiRuntime, now: number) => ({
  id: runtime.id,
  kind: runtime.kind,
  state: runtime.state,
  investigationReason: getActiveInvestigationReason(runtime),
  failure: runtime.failure,
  stuckForSeconds: round(getStuckDuration(now, runtime.stuckSince)),
  recoveryLevel: runtime.recoveryLevel,
  approachSlotId: runtime.approachSlotId,
  position: {
    x: round(runtime.currentX),
    z: round(runtime.currentZ),
  },
  target: {
    x: round(runtime.targetX),
    z: round(runtime.targetZ),
  },
  desiredSpeed: round(Math.hypot(runtime.desiredVelocityX, runtime.desiredVelocityZ), 3),
});

export class EnemyAiTelemetry {
  private readonly runtimes = new Map<number, EnemyAiRuntime>();
  private readonly failureTransitions: EnemyFailureTransition[] = [];
  private readonly stateTransitions: EnemyStateTransition[] = [];

  register(runtime: EnemyAiRuntime) {
    this.runtimes.set(runtime.id, runtime);
  }

  unregister(runtime: EnemyAiRuntime) {
    this.runtimes.delete(runtime.id);
  }

  recordFailureChange(
    runtime: EnemyAiRuntime,
    previousFailure: EnemyMovementFailure,
    previousStuckSince: number | undefined,
    now: number,
  ) {
    if (previousFailure === runtime.failure) return;
    const stuckSince = runtime.failure === "none"
      ? previousStuckSince
      : runtime.stuckSince;
    this.failureTransitions.push({
      at: round(now),
      id: runtime.id,
      kind: runtime.kind,
      state: runtime.state,
      from: previousFailure,
      to: runtime.failure,
      stuckForSeconds: round(getStuckDuration(now, stuckSince)),
      position: {
        x: round(runtime.currentX),
        z: round(runtime.currentZ),
      },
      target: {
        x: round(runtime.targetX),
        z: round(runtime.targetZ),
      },
      recoveryLevel: runtime.recoveryLevel,
    });
    if (this.failureTransitions.length > MAX_QUEUED_TRANSITIONS) {
      this.failureTransitions.splice(0, this.failureTransitions.length - MAX_QUEUED_TRANSITIONS);
    }
  }

  recordStateChange(runtime: EnemyAiRuntime, previousState: EnemyAiState, now: number) {
    if (previousState === runtime.state) return;
    this.stateTransitions.push({
      at: round(now),
      id: runtime.id,
      kind: runtime.kind,
      from: previousState,
      to: runtime.state,
      investigationReason: previousState === "investigate" || runtime.state === "investigate"
        ? runtime.investigationReason
        : undefined,
      position: { x: round(runtime.currentX), z: round(runtime.currentZ) },
      target: { x: round(runtime.targetX), z: round(runtime.targetZ) },
    });
    if (this.stateTransitions.length > MAX_QUEUED_TRANSITIONS) {
      this.stateTransitions.splice(0, this.stateTransitions.length - MAX_QUEUED_TRANSITIONS);
    }
  }

  takeSnapshot(now: number) {
    const failureCounts: FailureCounts = {
      none: 0,
      noDirection: 0,
      insufficientProgress: 0,
    };
    const stateCounts: StateCounts = {
      spawning: 0,
      patrolIdle: 0,
      patrolMove: 0,
      investigate: 0,
      chase: 0,
      attack: 0,
      stuckRecovery: 0,
      dead: 0,
    };
    const affectedEnemies: ReturnType<typeof createEnemyDetails>[] = [];
    let longestStuckSeconds = 0;
    let maxRecoveryLevel = 0;

    for (const runtime of this.runtimes.values()) {
      stateCounts[runtime.state] += 1;
      failureCounts[runtime.failure] += 1;
      maxRecoveryLevel = Math.max(maxRecoveryLevel, runtime.recoveryLevel);
      if (runtime.failure === "none") continue;
      const details = createEnemyDetails(runtime, now);
      affectedEnemies.push(details);
      longestStuckSeconds = Math.max(longestStuckSeconds, details.stuckForSeconds);
    }

    const failureTransitions = this.failureTransitions.splice(0, this.failureTransitions.length);
    const stateTransitions = this.stateTransitions.splice(0, this.stateTransitions.length);
    return {
      activeEnemyCount: this.runtimes.size,
      stateCounts,
      failureCounts,
      stuckEnemyCount: affectedEnemies.length,
      longestStuckSeconds: round(longestStuckSeconds),
      maxRecoveryLevel,
      affectedEnemies,
      failureTransitions,
      stateTransitions,
    };
  }
}
