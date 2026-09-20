import { COLORS, type EnemyKind } from "../config.js";
import type { NavigationWorld } from "../navigation.js";

type MapSize = {
  width: number;
  depth: number;
};

type PositionSource = {
  x: number;
  z: number;
};

type EnemySource = {
  kind: EnemyKind;
  hp: number;
  group: {
    position: PositionSource;
  };
  ai: {
    state: string;
  };
};

export type MinimapViewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

const DRAW_INTERVAL = 0.1;
const CANVAS_PADDING = 10;

const ENEMY_COLORS: Record<EnemyKind, string> = {
  bug: `#${COLORS.bug.toString(16).padStart(6, "0")}`,
  changeRequest: `#${COLORS.changeRequest.toString(16).padStart(6, "0")}`,
  meeting: `#${COLORS.meeting.toString(16).padStart(6, "0")}`,
  boss: `#${COLORS.boss.toString(16).padStart(6, "0")}`,
};

export const createMinimapViewport = (
  map: MapSize,
  canvasWidth: number,
  canvasHeight: number,
  padding = CANVAS_PADDING,
): MinimapViewport => {
  const scale = Math.min(
    (canvasWidth - padding * 2) / map.width,
    (canvasHeight - padding * 2) / map.depth,
  );
  return {
    scale,
    offsetX: (canvasWidth - map.width * scale) / 2,
    offsetY: (canvasHeight - map.depth * scale) / 2,
  };
};

export const projectMinimapPoint = (
  position: PositionSource,
  viewport: MinimapViewport,
) => ({
  x: viewport.offsetX + position.x * viewport.scale,
  y: viewport.offsetY + position.z * viewport.scale,
});

export class GameMinimap {
  private readonly context: CanvasRenderingContext2D;
  private drawTimer = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly navigation: NavigationWorld,
    private readonly map: MapSize,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Minimap requires a 2D canvas context");
    this.context = context;
  }

  update(delta: number, player: PositionSource, enemies: Iterable<EnemySource>) {
    this.drawTimer -= delta;
    if (this.drawTimer > 0) return;
    this.drawTimer = DRAW_INTERVAL;
    this.draw(player, enemies);
  }

  private draw(player: PositionSource, enemies: Iterable<EnemySource>) {
    const { context, canvas } = this;
    const viewport = createMinimapViewport(this.map, canvas.width, canvas.height);
    const mapWidth = this.map.width * viewport.scale;
    const mapDepth = this.map.depth * viewport.scale;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(4, 12, 10, 0.48)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(23, 38, 33, 0.58)";
    context.fillRect(viewport.offsetX, viewport.offsetY, mapWidth, mapDepth);

    this.drawGrid(viewport, mapWidth, mapDepth);
    this.drawObstacles(viewport);

    context.strokeStyle = "rgba(189, 239, 255, 0.72)";
    context.lineWidth = 2;
    context.strokeRect(viewport.offsetX, viewport.offsetY, mapWidth, mapDepth);

    for (const enemy of enemies) {
      if (enemy.hp <= 0) continue;
      const point = projectMinimapPoint(enemy.group.position, viewport);
      const radius = enemy.kind === "boss" ? 6.5 : 4.2;
      context.globalAlpha = enemy.ai.state === "spawning" ? 0.55 : 1;
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = ENEMY_COLORS[enemy.kind];
      context.fill();
      context.strokeStyle = "rgba(12, 16, 14, 0.9)";
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.globalAlpha = 1;

    const playerPoint = projectMinimapPoint(player, viewport);
    context.beginPath();
    context.arc(playerPoint.x, playerPoint.y, 6.2, 0, Math.PI * 2);
    context.fillStyle = `#${COLORS.playerAccent.toString(16).padStart(6, "0")}`;
    context.fill();
    context.strokeStyle = "#f4f0da";
    context.lineWidth = 2.2;
    context.stroke();
  }

  private drawGrid(viewport: MinimapViewport, mapWidth: number, mapDepth: number) {
    const { context } = this;
    context.beginPath();
    context.strokeStyle = "rgba(189, 239, 255, 0.08)";
    context.lineWidth = 1;
    for (let column = 1; column < 4; column += 1) {
      const x = viewport.offsetX + (mapWidth * column) / 4;
      context.moveTo(x, viewport.offsetY);
      context.lineTo(x, viewport.offsetY + mapDepth);
    }
    for (let row = 1; row < 6; row += 1) {
      const y = viewport.offsetY + (mapDepth * row) / 6;
      context.moveTo(viewport.offsetX, y);
      context.lineTo(viewport.offsetX + mapWidth, y);
    }
    context.stroke();
  }

  private drawObstacles(viewport: MinimapViewport) {
    const { context } = this;
    context.fillStyle = "rgba(133, 151, 141, 0.48)";
    for (const obstacle of this.navigation.getObstacles()) {
      if (!obstacle.active) continue;
      const topLeft = projectMinimapPoint({
        x: obstacle.x - obstacle.width / 2,
        z: obstacle.z - obstacle.depth / 2,
      }, viewport);
      context.fillRect(
        topLeft.x,
        topLeft.y,
        Math.max(1.5, obstacle.width * viewport.scale),
        Math.max(1.5, obstacle.depth * viewport.scale),
      );
    }
  }
}
