import type { NavigationWorld } from "../navigation.js";
import type { EnemyAiRuntime, NavigationPoint, PatrolZoneId } from "./enemy-ai-runtime.js";

const PATROL_POINTS: Record<PatrolZoneId, readonly NavigationPoint[]> = {
  meetingRoom: [
    { x: 90, z: 100 }, { x: 440, z: 110 }, { x: 90, z: 450 }, { x: 440, z: 450 },
  ],
  bossOffice: [
    { x: 630, z: 100 }, { x: 1000, z: 100 }, { x: 620, z: 450 }, { x: 1000, z: 450 },
  ],
  workstation: [
    { x: 70, z: 640 }, { x: 470, z: 650 }, { x: 70, z: 850 }, { x: 470, z: 1050 },
  ],
  pantry: [
    { x: 620, z: 640 }, { x: 1000, z: 650 }, { x: 630, z: 1040 }, { x: 1000, z: 1050 },
  ],
  elevatorCorridor: [
    { x: 90, z: 1210 }, { x: 300, z: 1250 }, { x: 790, z: 1250 }, { x: 990, z: 1210 },
    { x: 190, z: 1460 }, { x: 870, z: 1460 },
  ],
};

export type PatrolTarget = {
  pointIndex: number;
  point: NavigationPoint;
  path: NavigationPoint[];
};

export const choosePatrolTarget = (
  runtime: EnemyAiRuntime,
  navigation: NavigationWorld,
  radius: number,
  random: () => number,
): PatrolTarget | undefined => {
  const points = PATROL_POINTS[runtime.homeZone];
  const startIndex = Math.floor(random() * points.length);

  for (let offset = 0; offset < points.length; offset += 1) {
    const pointIndex = (startIndex + offset) % points.length;
    const point = points[pointIndex];
    if (pointIndex === runtime.patrolTargetIndex) continue;
    if (Math.hypot(point.x - runtime.currentX, point.z - runtime.currentZ) < 80) continue;
    if (!navigation.canOccupy(point.x, point.z, radius)) continue;
    const path = navigation.findPath(runtime.currentX, runtime.currentZ, point.x, point.z, radius);
    if (path.length === 0) continue;
    return { pointIndex, point, path };
  }
  return undefined;
};
