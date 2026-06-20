import type { AttackMode } from "./config";

export type AttackRequest = {
  sourceId: string;
  weaponId: string;
  mode: AttackMode;
  originX: number;
  originZ: number;
  directionX: number;
  directionZ: number;
  range: number;
  damage: number;
  maxHits: number;
};

export type CircleTarget<T> = {
  target: T;
  x: number;
  z: number;
  radius: number;
};

export type ShotHit<T> = {
  target: T;
  distance: number;
  x: number;
  z: number;
};

export const traceCircleTargets = <T>(
  originX: number,
  originZ: number,
  directionX: number,
  directionZ: number,
  maxDistance: number,
  obstacleDistance: number,
  targets: CircleTarget<T>[],
  maxHits = 1,
) => {
  const hits: ShotHit<T>[] = [];
  const limit = Math.min(maxDistance, obstacleDistance);

  for (const candidate of targets) {
    const offsetX = candidate.x - originX;
    const offsetZ = candidate.z - originZ;
    const projectedDistance = offsetX * directionX + offsetZ * directionZ;
    if (projectedDistance < 0 || projectedDistance > limit) continue;
    const closestDistanceSquared = offsetX * offsetX + offsetZ * offsetZ - projectedDistance * projectedDistance;
    const radiusSquared = candidate.radius * candidate.radius;
    if (closestDistanceSquared > radiusSquared) continue;
    const entryDistance = Math.max(0, projectedDistance - Math.sqrt(radiusSquared - closestDistanceSquared));
    if (entryDistance > limit) continue;
    hits.push({
      target: candidate.target,
      distance: entryDistance,
      x: originX + directionX * entryDistance,
      z: originZ + directionZ * entryDistance,
    });
  }

  hits.sort((first, second) => first.distance - second.distance);
  const selectedHits = hits.slice(0, maxHits);
  return {
    hits: selectedHits,
    endDistance: selectedHits.length >= maxHits ? selectedHits[selectedHits.length - 1].distance : limit,
  };
};
