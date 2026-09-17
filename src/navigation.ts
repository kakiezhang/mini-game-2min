export type Obstacle = {
  x: number;
  z: number;
  width: number;
  depth: number;
  active: boolean;
};

export type NavigationSizeClass = "small" | "medium" | "large";

export type NavigationPerformanceMetrics = {
  directionCalls: number;
  reachabilityChecks: number;
  flowRequests: number;
  flowCacheHits: number;
  flowRebuilds: number;
  flowRebuildMs: number;
  blockedGridRebuilds: number;
  blockedGridRebuildMs: number;
};

type Point = { x: number; z: number };

type NavigationGrid = {
  sizeClass: NavigationSizeClass;
  clearance: number;
  obstacleVersion: number;
  blocked: Uint8Array;
};

type FlowField = {
  cacheKey: string;
  obstacleVersion: number;
  targetIndex: number;
  distances: Int32Array;
  lastUsed: number;
};

const NEIGHBORS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const NAVIGATION_CLEARANCE: Record<NavigationSizeClass, number> = {
  small: 18,
  medium: 30,
  large: 36,
};

const MAX_FLOW_CACHE_ENTRIES = 24;

export const getNavigationSizeClass = (radius: number): NavigationSizeClass => {
  if (radius <= 20) return "small";
  if (radius <= 32) return "medium";
  return "large";
};

export class NavigationWorld {
  private readonly obstacles: Obstacle[] = [];
  private readonly columns: number;
  private readonly rows: number;
  private readonly gridCache = new Map<NavigationSizeClass, NavigationGrid>();
  private readonly flowCache = new Map<string, FlowField>();
  private obstacleVersion = 0;
  private flowUsageCounter = 0;
  private performanceTracking = false;
  private readonly performanceMetrics = this.createPerformanceMetrics();

  constructor(
    private readonly width: number,
    private readonly depth: number,
    private readonly cellSize = 20,
  ) {
    this.columns = Math.ceil(width / cellSize);
    this.rows = Math.ceil(depth / cellSize);
  }

  addObstacle(x: number, z: number, width: number, depth: number, active = true) {
    const obstacle = { x, z, width, depth, active };
    this.obstacles.push(obstacle);
    this.invalidateNavigationCaches();
    return obstacle;
  }

  setObstacleActive(obstacle: Obstacle | undefined, active: boolean) {
    if (!obstacle || obstacle.active === active) return;
    obstacle.active = active;
    this.invalidateNavigationCaches();
  }

  setPerformanceTracking(enabled: boolean) {
    this.performanceTracking = enabled;
  }

  takePerformanceMetrics(): NavigationPerformanceMetrics {
    const snapshot = { ...this.performanceMetrics };
    for (const key of Object.keys(this.performanceMetrics) as Array<keyof NavigationPerformanceMetrics>) {
      this.performanceMetrics[key] = 0;
    }
    return snapshot;
  }

  canOccupy(x: number, z: number, radius: number) {
    return !this.isCircleBlocked(x, z, radius);
  }

  canMoveDirectly(x: number, z: number, targetX: number, targetZ: number, radius: number) {
    return this.hasClearPath(x, z, targetX, targetZ, radius);
  }

  canReach(x: number, z: number, targetX: number, targetZ: number, radius: number) {
    if (this.performanceTracking) this.performanceMetrics.reachabilityChecks += 1;
    const { grid, flow } = this.ensureFlow(targetX, targetZ, radius);
    const column = this.toColumn(x);
    const row = this.toRow(z);
    if (flow.distances[this.index(column, row)] >= 0) return true;

    return NEIGHBORS.some(([columnOffset, rowOffset]) => {
      const nextColumn = column + columnOffset;
      const nextRow = row + rowOffset;
      if (!this.isInside(nextColumn, nextRow) || !this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) {
        return false;
      }
      if (flow.distances[this.index(nextColumn, nextRow)] < 0) return false;
      const waypoint = this.cellCenter(nextColumn, nextRow, grid.clearance);
      return this.hasClearPath(x, z, waypoint.x, waypoint.z, radius);
    });
  }

  /**
   * Builds a low-frequency waypoint path by descending the cached flow field.
   * Chase steering can keep using the flow directly, while patrol/debug code
   * gets a stable, inspectable path without maintaining a second graph.
   */
  findPath(x: number, z: number, targetX: number, targetZ: number, radius: number): Point[] {
    if (this.hasClearPath(x, z, targetX, targetZ, radius)) return [{ x: targetX, z: targetZ }];

    const { grid, flow } = this.ensureFlow(targetX, targetZ, radius);
    let column = this.toColumn(x);
    let row = this.toRow(z);
    let distance = flow.distances[this.index(column, row)];
    const rawPath: Point[] = [];

    if (distance < 0) {
      const entry = this.findBestFlowNeighbor(grid, flow, column, row, x, z);
      if (!entry) return [];
      column = entry.column;
      row = entry.row;
      distance = entry.distance;
      rawPath.push(entry.waypoint);
    }

    const maximumSteps = this.columns * this.rows;
    for (let step = 0; distance > 0 && step < maximumSteps; step += 1) {
      let best: { column: number; row: number; distance: number; waypoint: Point } | undefined;
      for (const [columnOffset, rowOffset] of NEIGHBORS) {
        const nextColumn = column + columnOffset;
        const nextRow = row + rowOffset;
        if (!this.isInside(nextColumn, nextRow)) continue;
        if (!this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) continue;
        const nextDistance = flow.distances[this.index(nextColumn, nextRow)];
        if (nextDistance < 0 || nextDistance >= distance) continue;
        const waypoint = this.cellCenter(nextColumn, nextRow, grid.clearance);
        if (!best || nextDistance < best.distance) {
          best = { column: nextColumn, row: nextRow, distance: nextDistance, waypoint };
        }
      }
      if (!best) return [];
      column = best.column;
      row = best.row;
      distance = best.distance;
      rawPath.push(best.waypoint);
    }

    if (distance !== 0) return [];
    const finalWaypoint = rawPath.at(-1);
    if (
      !finalWaypoint
      || (
        Math.hypot(finalWaypoint.x - targetX, finalWaypoint.z - targetZ) > 1
        && this.hasClearPath(finalWaypoint.x, finalWaypoint.z, targetX, targetZ, radius)
      )
    ) {
      rawPath.push({ x: targetX, z: targetZ });
    }
    return this.compressPath(rawPath);
  }

  raycastObstacleDistance(x: number, z: number, directionX: number, directionZ: number, maxDistance: number) {
    let nearestDistance = maxDistance;
    for (const obstacle of this.obstacles) {
      if (!obstacle.active) continue;
      const distance = this.rayRectangleDistance(x, z, directionX, directionZ, obstacle);
      if (distance !== undefined && distance < nearestDistance) nearestDistance = distance;
    }
    return nearestDistance;
  }

  moveCircle(x: number, z: number, deltaX: number, deltaZ: number, radius: number): Point {
    const nextX = Math.max(radius, Math.min(this.width - radius, x + deltaX));
    if (!this.isCircleBlocked(nextX, z, radius)) x = nextX;

    const nextZ = Math.max(radius, Math.min(this.depth - radius, z + deltaZ));
    if (!this.isCircleBlocked(x, nextZ, radius)) z = nextZ;
    return { x, z };
  }

  /**
   * The local target controls close-range steering while the flow target stays
   * shared by all chasers. This prevents per-enemy orbit points from replacing
   * the global flow-field cache.
   */
  getDirection(
    x: number,
    z: number,
    targetX: number,
    targetZ: number,
    radius: number,
    flowTargetX = targetX,
    flowTargetZ = targetZ,
    preferDirectPath = false,
  ): Point {
    if (this.performanceTracking) this.performanceMetrics.directionCalls += 1;
    const targetDistance = Math.hypot(targetX - x, targetZ - z);
    if (
      (preferDirectPath || targetDistance <= this.cellSize * 6)
      && this.hasClearPath(x, z, targetX, targetZ, radius)
    ) {
      return this.normalized(targetX - x, targetZ - z);
    }

    const { grid, flow } = this.ensureFlow(flowTargetX, flowTargetZ, radius);
    const column = this.toColumn(x);
    const row = this.toRow(z);
    const currentDistance = flow.distances[this.index(column, row)];
    const currentTargetDistance = Math.hypot(flowTargetX - x, flowTargetZ - z);
    const candidates: Array<{ distance: number; targetDistance: number; waypoint: Point }> = [];

    for (const [columnOffset, rowOffset] of NEIGHBORS) {
      const nextColumn = column + columnOffset;
      const nextRow = row + rowOffset;
      if (!this.isInside(nextColumn, nextRow) || !this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) {
        continue;
      }
      const distance = flow.distances[this.index(nextColumn, nextRow)];
      if (distance < 0) continue;
      const waypoint = this.cellCenter(nextColumn, nextRow, grid.clearance);
      if (!this.hasClearPath(x, z, waypoint.x, waypoint.z, radius)) continue;
      candidates.push({
        distance,
        targetDistance: Math.hypot(flowTargetX - waypoint.x, flowTargetZ - waypoint.z),
        waypoint,
      });
    }

    candidates.sort((first, second) => first.distance - second.distance || first.targetDistance - second.targetDistance);
    const best = candidates.find((candidate) => currentDistance < 0 || candidate.distance < currentDistance)
      ?? candidates.find((candidate) => candidate.distance === currentDistance && candidate.targetDistance < currentTargetDistance);
    if (best) return this.normalized(best.waypoint.x - x, best.waypoint.z - z);

    // Grid routes are guaranteed between cell centers, but an agent can enter a
    // cell near an obstacle corner. Re-centering gives it a safe approach to the
    // next waypoint instead of repeatedly pushing into that corner.
    const currentWaypoint = this.cellCenter(column, row, grid.clearance);
    if (
      Math.hypot(currentWaypoint.x - x, currentWaypoint.z - z) > 1
      && this.hasClearPath(x, z, currentWaypoint.x, currentWaypoint.z, radius)
    ) {
      return this.normalized(currentWaypoint.x - x, currentWaypoint.z - z);
    }

    // Never fall back to steering through a wall. If a local orbit point is
    // blocked, moving toward the shared chase target is still safe when visible.
    if (this.hasClearPath(x, z, targetX, targetZ, radius)) return this.normalized(targetX - x, targetZ - z);
    if (
      (flowTargetX !== targetX || flowTargetZ !== targetZ)
      && this.hasClearPath(x, z, flowTargetX, flowTargetZ, radius)
    ) {
      return this.normalized(flowTargetX - x, flowTargetZ - z);
    }
    return { x: 0, z: 0 };
  }

  /**
   * Returns a short, collision-safe escape direction for an agent that has
   * stopped making progress. Recovery first recenters within the current cell,
   * then advances through a reachable neighbor; prolonged failures prefer the
   * neighbor with the most obstacle clearance.
   */
  getRecoveryDirection(
    x: number,
    z: number,
    targetX: number,
    targetZ: number,
    radius: number,
    recoveryLevel: number,
  ): Point {
    const { grid, flow } = this.ensureFlow(targetX, targetZ, radius);
    const column = this.toColumn(x);
    const row = this.toRow(z);
    const currentWaypoint = this.cellCenter(column, row, grid.clearance);
    const canRecenter = (
      Math.hypot(currentWaypoint.x - x, currentWaypoint.z - z) > 1
      && this.hasClearPath(x, z, currentWaypoint.x, currentWaypoint.z, radius)
    );
    if (recoveryLevel === 1 && canRecenter) {
      return this.normalized(currentWaypoint.x - x, currentWaypoint.z - z);
    }

    const candidates: Array<{
      flowDistance: number;
      targetDistance: number;
      clearance: number;
      waypoint: Point;
    }> = [];
    for (const [columnOffset, rowOffset] of NEIGHBORS) {
      const nextColumn = column + columnOffset;
      const nextRow = row + rowOffset;
      if (!this.isInside(nextColumn, nextRow)) continue;
      if (!this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) continue;
      const flowDistance = flow.distances[this.index(nextColumn, nextRow)];
      if (flowDistance < 0) continue;
      const waypoint = this.cellCenter(nextColumn, nextRow, grid.clearance);
      if (!this.hasClearPath(x, z, waypoint.x, waypoint.z, radius)) continue;
      candidates.push({
        flowDistance,
        targetDistance: Math.hypot(targetX - waypoint.x, targetZ - waypoint.z),
        clearance: this.getObstacleClearance(waypoint.x, waypoint.z, radius),
        waypoint,
      });
    }

    candidates.sort((first, second) => {
      if (recoveryLevel >= 3 && second.clearance !== first.clearance) {
        return second.clearance - first.clearance;
      }
      return first.flowDistance - second.flowDistance
        || first.targetDistance - second.targetDistance
        || second.clearance - first.clearance;
    });
    const best = candidates[0];
    if (best) return this.normalized(best.waypoint.x - x, best.waypoint.z - z);
    if (canRecenter) return this.normalized(currentWaypoint.x - x, currentWaypoint.z - z);
    return { x: 0, z: 0 };
  }

  private isCircleBlocked(x: number, z: number, radius: number) {
    if (x - radius < 0 || x + radius > this.width || z - radius < 0 || z + radius > this.depth) return true;

    for (const obstacle of this.obstacles) {
      if (!obstacle.active) continue;
      const halfWidth = obstacle.width / 2;
      const halfDepth = obstacle.depth / 2;
      const closestX = Math.max(obstacle.x - halfWidth, Math.min(x, obstacle.x + halfWidth));
      const closestZ = Math.max(obstacle.z - halfDepth, Math.min(z, obstacle.z + halfDepth));
      const deltaX = x - closestX;
      const deltaZ = z - closestZ;
      if (deltaX * deltaX + deltaZ * deltaZ < radius * radius) return true;
    }
    return false;
  }

  private getObstacleClearance(x: number, z: number, radius: number) {
    let clearance = Math.min(
      x - radius,
      this.width - x - radius,
      z - radius,
      this.depth - z - radius,
    );
    for (const obstacle of this.obstacles) {
      if (!obstacle.active) continue;
      const deltaX = Math.max(Math.abs(x - obstacle.x) - obstacle.width / 2, 0);
      const deltaZ = Math.max(Math.abs(z - obstacle.z) - obstacle.depth / 2, 0);
      clearance = Math.min(clearance, Math.hypot(deltaX, deltaZ) - radius);
    }
    return clearance;
  }

  private rayRectangleDistance(x: number, z: number, directionX: number, directionZ: number, obstacle: Obstacle) {
    const minX = obstacle.x - obstacle.width / 2;
    const maxX = obstacle.x + obstacle.width / 2;
    const minZ = obstacle.z - obstacle.depth / 2;
    const maxZ = obstacle.z + obstacle.depth / 2;
    let entry = 0;
    let exit = Number.POSITIVE_INFINITY;

    const updateRange = (origin: number, direction: number, min: number, max: number) => {
      if (Math.abs(direction) < 0.000001) return origin >= min && origin <= max;
      const first = (min - origin) / direction;
      const second = (max - origin) / direction;
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
      return entry <= exit;
    };

    if (!updateRange(x, directionX, minX, maxX) || !updateRange(z, directionZ, minZ, maxZ)) return undefined;
    return exit >= 0 ? Math.max(0, entry) : undefined;
  }

  private hasClearPath(x: number, z: number, targetX: number, targetZ: number, radius: number) {
    const distance = Math.hypot(targetX - x, targetZ - z);
    const steps = Math.max(1, Math.ceil(distance / (this.cellSize * 0.45)));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      if (this.isCircleBlocked(x + (targetX - x) * progress, z + (targetZ - z) * progress, radius)) return false;
    }
    return true;
  }

  private ensureFlow(targetX: number, targetZ: number, radius: number) {
    if (this.performanceTracking) this.performanceMetrics.flowRequests += 1;
    const grid = this.ensureNavigationGrid(radius);
    let targetColumn = this.toColumn(targetX);
    let targetRow = this.toRow(targetZ);
    let targetIndex = this.index(targetColumn, targetRow);
    if (grid.blocked[targetIndex]) {
      const openCell = this.findNearestOpenCell(grid.blocked, targetColumn, targetRow);
      targetColumn = openCell.column;
      targetRow = openCell.row;
      targetIndex = this.index(targetColumn, targetRow);
    }

    const cacheKey = `${grid.sizeClass}:${targetIndex}`;
    const cached = this.flowCache.get(cacheKey);
    if (cached?.obstacleVersion === this.obstacleVersion) {
      cached.lastUsed = ++this.flowUsageCounter;
      if (this.performanceTracking) this.performanceMetrics.flowCacheHits += 1;
      return { grid, flow: cached };
    }

    const rebuildStartedAt = this.performanceTracking ? performance.now() : 0;
    const distances = new Int32Array(this.columns * this.rows);
    distances.fill(-1);
    const queue = new Int32Array(this.columns * this.rows);
    let head = 0;
    let tail = 0;
    queue[tail++] = targetIndex;
    distances[targetIndex] = 0;

    while (head < tail) {
      const currentIndex = queue[head++];
      const column = currentIndex % this.columns;
      const row = Math.floor(currentIndex / this.columns);
      for (const [columnOffset, rowOffset] of NEIGHBORS) {
        const nextColumn = column + columnOffset;
        const nextRow = row + rowOffset;
        if (!this.isInside(nextColumn, nextRow) || !this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) {
          continue;
        }
        const nextIndex = this.index(nextColumn, nextRow);
        if (distances[nextIndex] >= 0) continue;
        distances[nextIndex] = distances[currentIndex] + 1;
        queue[tail++] = nextIndex;
      }
    }

    const flow: FlowField = {
      cacheKey,
      obstacleVersion: this.obstacleVersion,
      targetIndex,
      distances,
      lastUsed: ++this.flowUsageCounter,
    };
    this.flowCache.set(cacheKey, flow);
    this.trimFlowCache();
    if (this.performanceTracking) {
      this.performanceMetrics.flowRebuilds += 1;
      this.performanceMetrics.flowRebuildMs += performance.now() - rebuildStartedAt;
    }
    return { grid, flow };
  }

  private ensureNavigationGrid(radius: number) {
    const sizeClass = getNavigationSizeClass(radius);
    const cached = this.gridCache.get(sizeClass);
    if (cached?.obstacleVersion === this.obstacleVersion) return cached;

    const rebuildStartedAt = this.performanceTracking ? performance.now() : 0;
    const clearance = NAVIGATION_CLEARANCE[sizeClass];
    const blocked = new Uint8Array(this.columns * this.rows);
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const center = this.cellCenter(column, row, clearance);
        blocked[this.index(column, row)] = this.isCircleBlocked(center.x, center.z, clearance) ? 1 : 0;
      }
    }

    const grid = { sizeClass, clearance, obstacleVersion: this.obstacleVersion, blocked };
    this.gridCache.set(sizeClass, grid);
    if (this.performanceTracking) {
      this.performanceMetrics.blockedGridRebuilds += 1;
      this.performanceMetrics.blockedGridRebuildMs += performance.now() - rebuildStartedAt;
    }
    return grid;
  }

  private findBestFlowNeighbor(
    grid: NavigationGrid,
    flow: FlowField,
    column: number,
    row: number,
    x: number,
    z: number,
  ) {
    let best: { column: number; row: number; distance: number; waypoint: Point } | undefined;
    for (const [columnOffset, rowOffset] of NEIGHBORS) {
      const nextColumn = column + columnOffset;
      const nextRow = row + rowOffset;
      if (!this.isInside(nextColumn, nextRow)) continue;
      if (!this.canTraverse(grid.blocked, column, row, nextColumn, nextRow)) continue;
      const distance = flow.distances[this.index(nextColumn, nextRow)];
      if (distance < 0) continue;
      const waypoint = this.cellCenter(nextColumn, nextRow, grid.clearance);
      if (!this.hasClearPath(x, z, waypoint.x, waypoint.z, grid.clearance)) continue;
      if (!best || distance < best.distance) {
        best = { column: nextColumn, row: nextRow, distance, waypoint };
      }
    }
    return best;
  }

  private compressPath(path: Point[]) {
    if (path.length < 3) return path;
    const compressed: Point[] = [path[0]];
    let previousDirectionX = Math.sign(path[1].x - path[0].x);
    let previousDirectionZ = Math.sign(path[1].z - path[0].z);
    for (let index = 1; index < path.length - 1; index += 1) {
      const directionX = Math.sign(path[index + 1].x - path[index].x);
      const directionZ = Math.sign(path[index + 1].z - path[index].z);
      if (directionX !== previousDirectionX || directionZ !== previousDirectionZ) {
        compressed.push(path[index]);
      }
      previousDirectionX = directionX;
      previousDirectionZ = directionZ;
    }
    compressed.push(path.at(-1)!);
    return compressed;
  }

  private invalidateNavigationCaches() {
    this.obstacleVersion += 1;
    this.gridCache.clear();
    this.flowCache.clear();
  }

  private trimFlowCache() {
    if (this.flowCache.size <= MAX_FLOW_CACHE_ENTRIES) return;
    let oldest: FlowField | undefined;
    for (const flow of this.flowCache.values()) {
      if (!oldest || flow.lastUsed < oldest.lastUsed) oldest = flow;
    }
    if (oldest) this.flowCache.delete(oldest.cacheKey);
  }

  private createPerformanceMetrics(): NavigationPerformanceMetrics {
    return {
      directionCalls: 0,
      reachabilityChecks: 0,
      flowRequests: 0,
      flowCacheHits: 0,
      flowRebuilds: 0,
      flowRebuildMs: 0,
      blockedGridRebuilds: 0,
      blockedGridRebuildMs: 0,
    };
  }

  private canTraverse(
    blocked: Uint8Array,
    column: number,
    row: number,
    nextColumn: number,
    nextRow: number,
  ) {
    if (blocked[this.index(nextColumn, nextRow)]) return false;
    const diagonal = column !== nextColumn && row !== nextRow;
    if (!diagonal) return true;
    return !blocked[this.index(nextColumn, row)] && !blocked[this.index(column, nextRow)];
  }

  private findNearestOpenCell(blocked: Uint8Array, startColumn: number, startRow: number) {
    for (let radius = 1; radius < Math.max(this.columns, this.rows); radius += 1) {
      for (let row = startRow - radius; row <= startRow + radius; row += 1) {
        for (let column = startColumn - radius; column <= startColumn + radius; column += 1) {
          if (!this.isInside(column, row) || blocked[this.index(column, row)]) continue;
          return { column, row };
        }
      }
    }
    return { column: startColumn, row: startRow };
  }

  private normalized(x: number, z: number): Point {
    const length = Math.hypot(x, z);
    if (length < 0.001) return { x: 0, z: 0 };
    return { x: x / length, z: z / length };
  }

  private toColumn(x: number) {
    return Math.max(0, Math.min(this.columns - 1, Math.floor(x / this.cellSize)));
  }

  private toRow(z: number) {
    return Math.max(0, Math.min(this.rows - 1, Math.floor(z / this.cellSize)));
  }

  private cellCenter(column: number, row: number, clearance: number): Point {
    return {
      x: Math.min(this.width - clearance, (column + 0.5) * this.cellSize),
      z: Math.min(this.depth - clearance, (row + 0.5) * this.cellSize),
    };
  }

  private isInside(column: number, row: number) {
    return column >= 0 && column < this.columns && row >= 0 && row < this.rows;
  }

  private index(column: number, row: number) {
    return row * this.columns + column;
  }
}
