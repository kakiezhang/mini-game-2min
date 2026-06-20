export type Obstacle = {
  x: number;
  z: number;
  width: number;
  depth: number;
  active: boolean;
};

type Point = { x: number; z: number };

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

export class NavigationWorld {
  private readonly obstacles: Obstacle[] = [];
  private readonly columns: number;
  private readonly rows: number;
  private readonly blocked: Uint8Array;
  private readonly distances: Int32Array;
  private obstacleVersion = 0;
  private flowVersion = -1;
  private flowTargetIndex = -1;

  constructor(
    private readonly width: number,
    private readonly depth: number,
    private readonly cellSize = 40,
    private readonly navigationClearance = 30,
  ) {
    this.columns = Math.ceil(width / cellSize);
    this.rows = Math.ceil(depth / cellSize);
    this.blocked = new Uint8Array(this.columns * this.rows);
    this.distances = new Int32Array(this.columns * this.rows);
    this.distances.fill(-1);
  }

  addObstacle(x: number, z: number, width: number, depth: number, active = true) {
    const obstacle = { x, z, width, depth, active };
    this.obstacles.push(obstacle);
    this.obstacleVersion += 1;
    return obstacle;
  }

  setObstacleActive(obstacle: Obstacle | undefined, active: boolean) {
    if (!obstacle || obstacle.active === active) return;
    obstacle.active = active;
    this.obstacleVersion += 1;
  }

  canOccupy(x: number, z: number, radius: number) {
    return !this.isCircleBlocked(x, z, radius);
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

  getDirection(x: number, z: number, targetX: number, targetZ: number, radius: number): Point {
    const targetDistance = Math.hypot(targetX - x, targetZ - z);
    if (targetDistance <= this.cellSize * 6 && this.hasClearPath(x, z, targetX, targetZ, radius)) {
      return this.normalized(targetX - x, targetZ - z);
    }

    this.ensureFlow(targetX, targetZ);
    const column = this.toColumn(x);
    const row = this.toRow(z);
    let bestColumn = column;
    let bestRow = row;
    let bestDistance = this.distances[this.index(column, row)];

    for (const [columnOffset, rowOffset] of NEIGHBORS) {
      const nextColumn = column + columnOffset;
      const nextRow = row + rowOffset;
      if (!this.isInside(nextColumn, nextRow) || !this.canTraverse(column, row, nextColumn, nextRow)) continue;
      const distance = this.distances[this.index(nextColumn, nextRow)];
      if (distance >= 0 && (bestDistance < 0 || distance < bestDistance)) {
        bestDistance = distance;
        bestColumn = nextColumn;
        bestRow = nextRow;
      }
    }

    if (bestColumn === column && bestRow === row) return this.normalized(targetX - x, targetZ - z);
    const waypoint = this.cellCenter(bestColumn, bestRow);
    return this.normalized(waypoint.x - x, waypoint.z - z);
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

  private ensureFlow(targetX: number, targetZ: number) {
    this.rebuildBlockedGrid();
    let targetColumn = this.toColumn(targetX);
    let targetRow = this.toRow(targetZ);
    let targetIndex = this.index(targetColumn, targetRow);
    if (this.blocked[targetIndex]) {
      const openCell = this.findNearestOpenCell(targetColumn, targetRow);
      targetColumn = openCell.column;
      targetRow = openCell.row;
      targetIndex = this.index(targetColumn, targetRow);
    }
    if (this.flowVersion === this.obstacleVersion && this.flowTargetIndex === targetIndex) return;

    this.distances.fill(-1);
    const queue = new Int32Array(this.columns * this.rows);
    let head = 0;
    let tail = 0;
    queue[tail++] = targetIndex;
    this.distances[targetIndex] = 0;

    while (head < tail) {
      const currentIndex = queue[head++];
      const column = currentIndex % this.columns;
      const row = Math.floor(currentIndex / this.columns);
      for (const [columnOffset, rowOffset] of NEIGHBORS) {
        const nextColumn = column + columnOffset;
        const nextRow = row + rowOffset;
        if (!this.isInside(nextColumn, nextRow) || !this.canTraverse(column, row, nextColumn, nextRow)) continue;
        const nextIndex = this.index(nextColumn, nextRow);
        if (this.distances[nextIndex] >= 0) continue;
        this.distances[nextIndex] = this.distances[currentIndex] + 1;
        queue[tail++] = nextIndex;
      }
    }

    this.flowTargetIndex = targetIndex;
    this.flowVersion = this.obstacleVersion;
  }

  private rebuildBlockedGrid() {
    if (this.flowVersion === this.obstacleVersion) return;
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const center = this.cellCenter(column, row);
        this.blocked[this.index(column, row)] = this.isCircleBlocked(center.x, center.z, this.navigationClearance) ? 1 : 0;
      }
    }
  }

  private canTraverse(column: number, row: number, nextColumn: number, nextRow: number) {
    if (this.blocked[this.index(nextColumn, nextRow)]) return false;
    const diagonal = column !== nextColumn && row !== nextRow;
    if (!diagonal) return true;
    return !this.blocked[this.index(nextColumn, row)] && !this.blocked[this.index(column, nextRow)];
  }

  private findNearestOpenCell(startColumn: number, startRow: number) {
    for (let radius = 1; radius < Math.max(this.columns, this.rows); radius += 1) {
      for (let row = startRow - radius; row <= startRow + radius; row += 1) {
        for (let column = startColumn - radius; column <= startColumn + radius; column += 1) {
          if (!this.isInside(column, row) || this.blocked[this.index(column, row)]) continue;
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

  private cellCenter(column: number, row: number): Point {
    return {
      x: Math.min(this.width - this.navigationClearance, (column + 0.5) * this.cellSize),
      z: Math.min(this.depth - this.navigationClearance, (row + 0.5) * this.cellSize),
    };
  }

  private isInside(column: number, row: number) {
    return column >= 0 && column < this.columns && row >= 0 && row < this.rows;
  }

  private index(column: number, row: number) {
    return row * this.columns + column;
  }
}
