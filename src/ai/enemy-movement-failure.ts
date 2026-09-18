import { ENEMY_CONFIG } from "../config.js";
import type { NavigationWorld } from "../navigation.js";
import type {
  EnemyAiRuntime,
  EnemyMovementFailureCause,
} from "./enemy-ai-runtime.js";
import type {
  EnemyMovementDirection,
  EnemySteeringSample,
} from "./enemy-movement-recovery.js";

const CROWD_GAP = 12;
const STATIC_DIRECTION_RATIO = 0.2;

const activeState = (runtime: EnemyAiRuntime) => (
  runtime.state === "stuckRecovery" ? runtime.previousState : runtime.state
);

export const findEnemyMovementBlocker = (
  runtime: EnemyAiRuntime,
  runtimes: Iterable<EnemyAiRuntime>,
  sample: EnemySteeringSample,
  direction: EnemyMovementDirection,
) => {
  const length = Math.hypot(direction.x, direction.z);
  if (length < 0.08) return undefined;
  const forwardX = direction.x / length;
  const forwardZ = direction.z / length;
  let nearest: EnemyAiRuntime | undefined;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;

  for (const other of runtimes) {
    if (other === runtime) continue;
    const deltaX = other.currentX - sample.x;
    const deltaZ = other.currentZ - sample.z;
    const combinedRadius = sample.radius + ENEMY_CONFIG[other.kind].radius;
    const forwardDistance = deltaX * forwardX + deltaZ * forwardZ;
    if (forwardDistance < -sample.radius * 0.25 || forwardDistance > combinedRadius + CROWD_GAP) {
      continue;
    }
    const lateralDistance = Math.abs(deltaX * forwardZ - deltaZ * forwardX);
    const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
    if (lateralDistance <= combinedRadius * 0.8 && distanceSquared < nearestDistanceSquared) {
      nearest = other;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
};

export const shouldEnemyYieldToBlocker = (
  runtime: EnemyAiRuntime,
  blocker: EnemyAiRuntime,
) => {
  if (runtime.kind === "boss") return false;
  if (blocker.kind === "boss") return true;
  if (blocker.state !== "stuckRecovery") return false;
  return runtime.id > blocker.id;
};

export const getEnemyCrowdYieldDirection = (
  runtime: EnemyAiRuntime,
  blocker: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemySteeringSample,
  direction: EnemyMovementDirection,
): EnemyMovementDirection => {
  const deltaX = sample.x - blocker.currentX;
  const deltaZ = sample.z - blocker.currentZ;
  const distance = Math.hypot(deltaX, deltaZ);
  const awayX = distance > 0.001 ? deltaX / distance : Math.cos(runtime.id * 2.399963);
  const awayZ = distance > 0.001 ? deltaZ / distance : Math.sin(runtime.id * 2.399963);
  const sideSign = ((Math.imul(Math.min(runtime.id, blocker.id) + 1, 73856093)
    ^ Math.imul(Math.max(runtime.id, blocker.id) + 1, 19349663)) >>> 0) % 2 === 0 ? 1 : -1;
  const sideX = -awayZ * sideSign;
  const sideZ = awayX * sideSign;
  const candidates = [
    { x: sideX + awayX * 0.35, z: sideZ + awayZ * 0.35 },
    { x: -sideX + awayX * 0.35, z: -sideZ + awayZ * 0.35 },
    { x: awayX, z: awayZ },
  ];
  let best = { x: 0, z: 0 };
  let bestLength = 0;
  for (const candidate of candidates) {
    const safe = navigation.getCollisionSafeDirection(
      sample.x,
      sample.z,
      candidate.x,
      candidate.z,
      sample.radius,
    );
    const safeLength = Math.hypot(safe.x, safe.z);
    if (safeLength <= bestLength + 0.0001) continue;
    best = safe;
    bestLength = safeLength;
  }
  return {
    ...direction,
    x: best.x,
    z: best.z,
  };
};

export const classifyEnemyMovementFailureCause = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  sample: EnemySteeringSample,
  direction: EnemyMovementDirection,
  runtimes: Iterable<EnemyAiRuntime>,
): EnemyMovementFailureCause => {
  const movementState = activeState(runtime);
  if (
    (movementState === "chase" || movementState === "attack")
    && runtime.approachSlotFailure === "invalid"
  ) {
    return "invalidSlot";
  }

  if (!navigation.canOccupy(sample.targetX, sample.targetZ, sample.radius)) {
    return "blockedWaypoint";
  }

  const baseLength = Math.hypot(direction.baseX, direction.baseZ);
  if (baseLength < 0.08) return "noFlowDirection";
  if (findEnemyMovementBlocker(runtime, runtimes, sample, direction)) return "crowdBlocked";

  const safeLength = Math.hypot(direction.safeX, direction.safeZ);
  if (safeLength < Math.max(0.08, baseLength * STATIC_DIRECTION_RATIO)) {
    return "staticCollision";
  }
  return "unclassified";
};

const CAUSE_PRIORITY: Record<EnemyMovementFailureCause, number> = {
  none: 0,
  unclassified: 1,
  visualOnly: 2,
  noFlowDirection: 3,
  staticCollision: 4,
  crowdBlocked: 5,
  blockedWaypoint: 6,
  invalidSlot: 7,
};

export class EnemyMovementFailureEvidence {
  private readonly samples = new Map<number, Map<EnemyMovementFailureCause, number>>();

  record(enemyId: number, cause: EnemyMovementFailureCause) {
    const causes = this.samples.get(enemyId) ?? new Map<EnemyMovementFailureCause, number>();
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
    this.samples.set(enemyId, causes);
  }

  peek(enemyId: number): EnemyMovementFailureCause {
    const causes = this.samples.get(enemyId);
    if (!causes) return "unclassified";
    let bestCause: EnemyMovementFailureCause = "unclassified";
    let bestCount = -1;
    for (const [cause, count] of causes) {
      if (count > bestCount || (count === bestCount && CAUSE_PRIORITY[cause] > CAUSE_PRIORITY[bestCause])) {
        bestCause = cause;
        bestCount = count;
      }
    }
    return bestCause;
  }

  reset(enemyId: number) {
    this.samples.delete(enemyId);
  }
}
