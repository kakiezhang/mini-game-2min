export type ElevatorBoxLayout = {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
};

// Keep the frame pieces edge-to-edge instead of intersecting. Intersecting box
// faces at the same depth flicker as the follow camera moves (z-fighting).
export const ELEVATOR_FRAME_LAYOUT = {
  leftJamb: { x: 404, y: 45, z: 1295, width: 24, height: 90, depth: 28 },
  rightJamb: { x: 676, y: 45, z: 1295, width: 24, height: 90, depth: 28 },
  leftSideWall: { x: 380, y: 45, z: 1425, width: 24, height: 90, depth: 260 },
  rightSideWall: { x: 700, y: 45, z: 1425, width: 24, height: 90, depth: 260 },
  backWall: { x: 540, y: 45, z: 1555, width: 296, height: 90, depth: 24 },
  lintel: { x: 540, y: 80, z: 1295, width: 248, height: 24, depth: 28 },
} as const satisfies Record<string, ElevatorBoxLayout>;
