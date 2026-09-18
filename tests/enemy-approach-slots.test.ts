import {
  assignEnemyApproachSlots,
  getEnemyApproachSlotTarget,
} from "../src/ai/enemy-approach-slots.js";
import { createEnemyAiRuntime } from "../src/ai/enemy-ai-runtime.js";
import { NavigationWorld } from "../src/navigation.js";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEqual = <T>(actual: T, expected: T, message: string) => {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
};

const createChaser = (id: number, x: number, z: number, kind: "bug" | "changeRequest" | "meeting" | "boss" = "bug") => {
  const runtime = createEnemyAiRuntime(id, kind, x, z, 0);
  runtime.state = "chase";
  return runtime;
};

const testSlotsRemainStableAndUnique = () => {
  const navigation = new NavigationWorld(800, 800);
  const first = createChaser(1, 500, 400);
  const second = createChaser(2, 300, 400);

  const initial = assignEnemyApproachSlots([first, second], navigation, 400, 400, 30);
  const firstSlot = first.approachSlotId;
  const secondSlot = second.approachSlotId;
  const repeated = assignEnemyApproachSlots([second, first], navigation, 400, 400, 30);

  assert(firstSlot !== undefined && secondSlot !== undefined, "eligible enemies should receive approach slots");
  assert(firstSlot !== secondSlot, "each approach slot should have a single occupant");
  assertEqual(first.approachSlotId, firstSlot, "the first assignment should remain stable");
  assertEqual(second.approachSlotId, secondSlot, "iteration order should not swap stable assignments");
  assertEqual(initial.firstRingAssignments, 2, "available first-ring slots should be preferred");
  assertEqual(repeated.assignmentChanges, 0, "stable assignments should not count as changes");
};

const testNearestAngularSlotIsPreferred = () => {
  const navigation = new NavigationWorld(800, 800);
  const eastEnemy = createChaser(3, 600, 400);

  assignEnemyApproachSlots([eastEnemy], navigation, 400, 400, 30);
  const target = getEnemyApproachSlotTarget(eastEnemy, 400, 400, 30);

  assertEqual(eastEnemy.approachSlotId, 0, "an east-side enemy should receive the east slot");
  assert(target !== undefined && target.x > 400, "the slot target should stay on the enemy's current side");
  assert(target !== undefined && Math.abs(target.z - 400) < 0.000001, "the east slot should preserve its axis");
};

const testBlockedSlotsAreRejected = () => {
  const navigation = new NavigationWorld(800, 800);
  navigation.addObstacle(464, 400, 40, 80);
  const eastEnemy = createChaser(4, 600, 400);

  assignEnemyApproachSlots([eastEnemy], navigation, 400, 400, 30);
  const target = getEnemyApproachSlotTarget(eastEnemy, 400, 400, 30);

  assert(eastEnemy.approachSlotId !== 0, "a slot inside furniture should not be assigned");
  assert(target !== undefined, "another valid slot should be selected");
  assert(navigation.canOccupy(target.x, target.z, 36), "the fallback slot should be occupiable");
};

const testSecondRingProvidesOverflowCapacity = () => {
  const navigation = new NavigationWorld(1000, 1000);
  const enemies = Array.from({ length: 7 }, (_, index) => {
    const angle = (index / 7) * Math.PI * 2;
    return createChaser(index + 10, 500 + Math.cos(angle) * 240, 500 + Math.sin(angle) * 240);
  });

  const result = assignEnemyApproachSlots(enemies, navigation, 500, 500, 30);

  assertEqual(result.firstRingAssignments, 6, "the first ring should expose six stable attack positions");
  assertEqual(result.secondRingAssignments, 1, "overflow enemies should wait in the second ring");
  assertEqual(new Set(enemies.map((enemy) => enemy.approachSlotId)).size, 7, "overflow assignments should remain unique");
};

const testBossCanClaimPrioritySlot = () => {
  const navigation = new NavigationWorld(800, 800);
  const regular = createChaser(30, 600, 400);
  assignEnemyApproachSlots([regular], navigation, 400, 400, 30);
  assertEqual(regular.approachSlotId, 0, "the regular enemy should initially own the nearest slot");

  const boss = createChaser(31, 620, 400, "boss");
  const result = assignEnemyApproachSlots([regular, boss], navigation, 400, 400, 30);

  assertEqual(boss.approachSlotId, 0, "the boss should claim the highest-priority nearby slot");
  assert(regular.approachSlotId !== 0, "the displaced regular enemy should choose another slot");
  assert(result.assignmentChanges > 0, "boss displacement should be visible as an assignment change");
};

const testSlotsReleaseOutsideCombat = () => {
  const navigation = new NavigationWorld(800, 800);
  const runtime = createChaser(40, 600, 400);
  assignEnemyApproachSlots([runtime], navigation, 400, 400, 30);
  runtime.state = "patrolMove";

  const result = assignEnemyApproachSlots([runtime], navigation, 400, 400, 30);

  assertEqual(runtime.approachSlotId, undefined, "leaving combat should release the approach slot");
  assertEqual(result.releases, 1, "slot releases should be observable");
  assertEqual(runtime.approachSlotFailure, "none", "leaving combat should clear slot failure state");
};

const testInvalidTargetsAndCapacityAreDistinguished = () => {
  const constrainedNavigation = new NavigationWorld(100, 100);
  const constrained = createChaser(50, 50, 50);
  const invalid = assignEnemyApproachSlots([constrained], constrainedNavigation, 50, 50, 30);

  assertEqual(constrained.approachSlotId, undefined, "an enemy should remain unassigned when every target is invalid");
  assertEqual(constrained.approachSlotFailure, "invalid", "invalid geometry should be retained as the slot failure reason");
  assertEqual(invalid.invalidTargetMisses, 1, "invalid target misses should be observable");
  assertEqual(invalid.capacityMisses, 0, "invalid geometry is not a capacity miss");

  const openNavigation = new NavigationWorld(1200, 1200);
  const crowded = Array.from({ length: 19 }, (_, index) => createChaser(60 + index, 600, 600));
  const capacity = assignEnemyApproachSlots(crowded, openNavigation, 600, 600, 30);

  assertEqual(capacity.assignedEnemies, 18, "all available approach slots should be filled");
  assertEqual(capacity.capacityMisses, 1, "overflow should be reported separately from invalid geometry");
  assertEqual(crowded.filter((enemy) => enemy.approachSlotFailure === "capacity").length, 1, "one enemy should retain the capacity reason");
};

testSlotsRemainStableAndUnique();
testNearestAngularSlotIsPreferred();
testBlockedSlotsAreRejected();
testSecondRingProvidesOverflowCapacity();
testBossCanClaimPrioritySlot();
testSlotsReleaseOutsideCombat();
testInvalidTargetsAndCapacityAreDistinguished();

console.log("enemy approach slot tests passed");
