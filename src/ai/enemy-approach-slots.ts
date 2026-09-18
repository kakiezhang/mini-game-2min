import { ENEMY_CONFIG } from "../config.js";
import type { NavigationWorld } from "../navigation.js";
import type { EnemyAiRuntime, EnemyAiState } from "./enemy-ai-runtime.js";

export const ENEMY_APPROACH_SLOT_INTERVAL = 0.1;

const FIRST_RING_SLOT_COUNT = 6;
const SECOND_RING_SLOT_COUNT = 12;
const CONTACT_OVERLAP = 2;
const SECOND_RING_GAP = 12;

type ApproachRing = 0 | 1;

type ApproachSlotDefinition = {
  id: number;
  ring: ApproachRing;
  angle: number;
};

export type ApproachSlotTarget = {
  slotId: number;
  ring: ApproachRing;
  x: number;
  z: number;
};

export type ApproachSlotAssignmentResult = {
  eligibleEnemies: number;
  assignedEnemies: number;
  firstRingAssignments: number;
  secondRingAssignments: number;
  unassignedEnemies: number;
  assignmentChanges: number;
  invalidations: number;
  releases: number;
};

const createSlots = () => {
  const slots: ApproachSlotDefinition[] = [];
  for (let index = 0; index < FIRST_RING_SLOT_COUNT; index += 1) {
    slots.push({
      id: index,
      ring: 0,
      angle: (index / FIRST_RING_SLOT_COUNT) * Math.PI * 2,
    });
  }
  for (let index = 0; index < SECOND_RING_SLOT_COUNT; index += 1) {
    slots.push({
      id: FIRST_RING_SLOT_COUNT + index,
      ring: 1,
      angle: ((index + 0.5) / SECOND_RING_SLOT_COUNT) * Math.PI * 2,
    });
  }
  return slots;
};

const APPROACH_SLOTS = createSlots();
const APPROACH_SLOT_BY_ID = new Map(APPROACH_SLOTS.map((slot) => [slot.id, slot]));

const getActiveState = (runtime: EnemyAiRuntime): EnemyAiState => (
  runtime.state === "stuckRecovery" ? runtime.previousState : runtime.state
);

const isEligible = (runtime: EnemyAiRuntime) => {
  const state = getActiveState(runtime);
  return state === "chase" || state === "attack";
};

const angleDistance = (first: number, second: number) => {
  const difference = Math.abs(first - second) % (Math.PI * 2);
  return Math.min(difference, Math.PI * 2 - difference);
};

const getRingRadius = (
  runtime: EnemyAiRuntime,
  ring: ApproachRing,
  playerRadius: number,
) => {
  const enemyRadius = ENEMY_CONFIG[runtime.kind].radius;
  const firstRingRadius = playerRadius + enemyRadius - CONTACT_OVERLAP;
  if (ring === 0) return firstRingRadius;
  return firstRingRadius + enemyRadius * 2 + SECOND_RING_GAP;
};

const createTarget = (
  runtime: EnemyAiRuntime,
  slot: ApproachSlotDefinition,
  playerX: number,
  playerZ: number,
  playerRadius: number,
): ApproachSlotTarget => {
  const radius = getRingRadius(runtime, slot.ring, playerRadius);
  return {
    slotId: slot.id,
    ring: slot.ring,
    x: playerX + Math.cos(slot.angle) * radius,
    z: playerZ + Math.sin(slot.angle) * radius,
  };
};

const isTargetValid = (
  runtime: EnemyAiRuntime,
  target: ApproachSlotTarget,
  navigation: NavigationWorld,
  playerX: number,
  playerZ: number,
) => {
  const radius = ENEMY_CONFIG[runtime.kind].radius;
  if (!navigation.canOccupy(target.x, target.z, radius)) return false;
  const distance = Math.hypot(playerX - target.x, playerZ - target.z);
  if (distance < 0.001) return true;
  return navigation.raycastObstacleDistance(
    target.x,
    target.z,
    (playerX - target.x) / distance,
    (playerZ - target.z) / distance,
    distance,
  ) >= distance - 1;
};

const priorityCompare = (
  first: EnemyAiRuntime,
  second: EnemyAiRuntime,
  playerX: number,
  playerZ: number,
) => {
  const bossPriority = Number(second.kind === "boss") - Number(first.kind === "boss");
  if (bossPriority !== 0) return bossPriority;
  const attackPriority = Number(getActiveState(second) === "attack")
    - Number(getActiveState(first) === "attack");
  if (attackPriority !== 0) return attackPriority;
  const existingPriority = Number(second.approachSlotId !== undefined)
    - Number(first.approachSlotId !== undefined);
  if (existingPriority !== 0) return existingPriority;
  const firstDistance = Math.hypot(first.currentX - playerX, first.currentZ - playerZ);
  const secondDistance = Math.hypot(second.currentX - playerX, second.currentZ - playerZ);
  return firstDistance - secondDistance || first.id - second.id;
};

const candidateSlots = (runtime: EnemyAiRuntime, playerX: number, playerZ: number) => {
  const currentAngle = Math.atan2(runtime.currentZ - playerZ, runtime.currentX - playerX);
  const ordered: ApproachSlotDefinition[] = [];
  for (const ring of [0, 1] as const) {
    ordered.push(
      ...APPROACH_SLOTS
        .filter((slot) => slot.ring === ring)
        .sort((first, second) => (
          angleDistance(first.angle, currentAngle) - angleDistance(second.angle, currentAngle)
          || first.id - second.id
        )),
    );
  }
  return ordered;
};

export const getEnemyApproachSlotTarget = (
  runtime: EnemyAiRuntime,
  playerX: number,
  playerZ: number,
  playerRadius: number,
): ApproachSlotTarget | undefined => {
  if (runtime.approachSlotId === undefined) return undefined;
  const slot = APPROACH_SLOT_BY_ID.get(runtime.approachSlotId);
  if (!slot) return undefined;
  return createTarget(runtime, slot, playerX, playerZ, playerRadius);
};

export const assignEnemyApproachSlots = (
  runtimes: Iterable<EnemyAiRuntime>,
  navigation: NavigationWorld,
  playerX: number,
  playerZ: number,
  playerRadius: number,
): ApproachSlotAssignmentResult => {
  const result: ApproachSlotAssignmentResult = {
    eligibleEnemies: 0,
    assignedEnemies: 0,
    firstRingAssignments: 0,
    secondRingAssignments: 0,
    unassignedEnemies: 0,
    assignmentChanges: 0,
    invalidations: 0,
    releases: 0,
  };
  const enemies = Array.from(runtimes);
  const eligible = enemies
    .filter(isEligible)
    .sort((first, second) => priorityCompare(first, second, playerX, playerZ));
  const occupiedSlots = new Set<number>();
  result.eligibleEnemies = eligible.length;

  for (const runtime of enemies) {
    if (isEligible(runtime) || runtime.approachSlotId === undefined) continue;
    runtime.approachSlotId = undefined;
    result.releases += 1;
  }

  for (const runtime of eligible) {
    const previousSlotId = runtime.approachSlotId;
    let assignedTarget: ApproachSlotTarget | undefined;

    if (previousSlotId !== undefined && !occupiedSlots.has(previousSlotId)) {
      const existingSlot = APPROACH_SLOT_BY_ID.get(previousSlotId);
      if (existingSlot) {
        const target = createTarget(runtime, existingSlot, playerX, playerZ, playerRadius);
        if (isTargetValid(runtime, target, navigation, playerX, playerZ)) assignedTarget = target;
      }
    }

    if (!assignedTarget) {
      for (const slot of candidateSlots(runtime, playerX, playerZ)) {
        if (occupiedSlots.has(slot.id)) continue;
        const target = createTarget(runtime, slot, playerX, playerZ, playerRadius);
        if (!isTargetValid(runtime, target, navigation, playerX, playerZ)) continue;
        assignedTarget = target;
        break;
      }
    }

    if (!assignedTarget) {
      if (previousSlotId !== undefined) result.invalidations += 1;
      runtime.approachSlotId = undefined;
      result.unassignedEnemies += 1;
      continue;
    }

    runtime.approachSlotId = assignedTarget.slotId;
    occupiedSlots.add(assignedTarget.slotId);
    result.assignedEnemies += 1;
    if (assignedTarget.ring === 0) result.firstRingAssignments += 1;
    else result.secondRingAssignments += 1;
    if (previousSlotId !== undefined && previousSlotId !== assignedTarget.slotId) {
      result.assignmentChanges += 1;
    }
  }

  return result;
};
