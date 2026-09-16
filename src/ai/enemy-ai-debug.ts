import * as THREE from "three";
import type { EnemyAiRuntime } from "./enemy-ai-runtime";

export type EnemyAiDebugPose = {
  x: number;
  z: number;
  height: number;
};

export type EnemyAiDebugOptions = {
  enabled: boolean;
  seed: number;
  forcedKind?: string;
};

type EnemyDebugVisual = {
  label: THREE.Sprite;
  labelTexture: THREE.CanvasTexture;
  lastLabel: string;
  targetLine: THREE.Line;
  pathLine: THREE.Line;
  targetMarker: THREE.Mesh;
};

const STATE_COLORS: Record<EnemyAiRuntime["state"], number> = {
  spawning: 0xffffff,
  patrolIdle: 0x94a3b8,
  patrolMove: 0x38bdf8,
  investigate: 0xfacc15,
  chase: 0xfb923c,
  attack: 0xef4444,
  search: 0xc084fc,
  stuckRecovery: 0xf43f5e,
  dead: 0x64748b,
};

const createLine = (color: number, dashed = false) => {
  const geometry = new THREE.BufferGeometry();
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 18, gapSize: 10, depthTest: false, transparent: true, opacity: 0.85 })
    : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.82 });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 1000;
  line.frustumCulled = false;
  return line;
};

const setLinePoints = (line: THREE.Line, points: THREE.Vector3[]) => {
  line.geometry.setFromPoints(points);
  if (line.material instanceof THREE.LineDashedMaterial) line.computeLineDistances();
  line.visible = points.length >= 2;
};

export class EnemyAiDebugLayer {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<number, EnemyDebugVisual>();
  private readonly panel = document.createElement("div");
  private enabled: boolean;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly options: EnemyAiDebugOptions,
  ) {
    this.enabled = options.enabled;
    this.root.name = "enemy-ai-debug-layer";
    this.root.visible = this.enabled;
    this.scene.add(this.root);
    this.createPanel();
    window.addEventListener("keydown", this.onKeyDown);
  }

  update(runtime: EnemyAiRuntime, pose: EnemyAiDebugPose) {
    if (!this.enabled) return;
    const visual = this.visuals.get(runtime.id) ?? this.createVisual(runtime.id);
    const color = STATE_COLORS[runtime.state];
    const stuckDuration = runtime.stuckSince === undefined
      ? "-"
      : `${Math.max(0, runtime.lastProgressAt - runtime.stuckSince).toFixed(1)}s`;
    const label = [
      `#${runtime.id} ${runtime.kind} · ${runtime.state}`,
      `zone ${runtime.homeZone} · path ${runtime.pathIndex}/${runtime.path.length} · stuck ${stuckDuration} ${runtime.failure}`,
    ].join("\n");

    if (label !== visual.lastLabel) {
      this.drawLabel(visual.labelTexture, label, color);
      visual.lastLabel = label;
    }

    visual.label.position.set(pose.x, pose.height + 72, pose.z);
    visual.targetMarker.position.set(runtime.targetX, 5, runtime.targetZ);
    const targetMaterial = visual.targetMarker.material;
    if (targetMaterial instanceof THREE.MeshBasicMaterial) targetMaterial.color.setHex(color);

    setLinePoints(visual.targetLine, [
      new THREE.Vector3(pose.x, 10, pose.z),
      new THREE.Vector3(runtime.targetX, 10, runtime.targetZ),
    ]);

    const pathPoints = runtime.path.slice(runtime.pathIndex).map((point) => new THREE.Vector3(point.x, 14, point.z));
    setLinePoints(
      visual.pathLine,
      pathPoints.length > 0 ? [new THREE.Vector3(pose.x, 14, pose.z), ...pathPoints] : [],
    );
  }

  remove(enemyId: number) {
    const visual = this.visuals.get(enemyId);
    if (!visual) return;
    this.root.remove(visual.label, visual.targetLine, visual.pathLine, visual.targetMarker);
    visual.labelTexture.dispose();
    visual.label.material.dispose();
    visual.targetLine.geometry.dispose();
    (visual.targetLine.material as THREE.Material).dispose();
    visual.pathLine.geometry.dispose();
    (visual.pathLine.material as THREE.Material).dispose();
    visual.targetMarker.geometry.dispose();
    (visual.targetMarker.material as THREE.Material).dispose();
    this.visuals.delete(enemyId);
  }

  private createVisual(enemyId: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 128;
    const labelTexture = new THREE.CanvasTexture(canvas);
    labelTexture.minFilter = THREE.LinearFilter;
    labelTexture.magFilter = THREE.LinearFilter;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTexture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }));
    label.scale.set(250, 50, 1);
    label.renderOrder = 1001;

    const targetLine = createLine(0xfbbf24, true);
    const pathLine = createLine(0x38bdf8);
    const targetMarker = new THREE.Mesh(
      new THREE.RingGeometry(12, 17, 20),
      new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    targetMarker.rotation.x = -Math.PI / 2;
    targetMarker.renderOrder = 1000;

    const visual = { label, labelTexture, lastLabel: "", targetLine, pathLine, targetMarker };
    this.root.add(label, targetLine, pathLine, targetMarker);
    this.visuals.set(enemyId, visual);
    return visual;
  }

  private drawLabel(texture: THREE.CanvasTexture, text: string, color: number) {
    const canvas = texture.image as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(5, 12, 18, 0.88)";
    context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
    context.lineWidth = 5;
    context.fillRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
    context.fillStyle = "#f8fafc";
    context.font = "600 29px ui-monospace, SFMono-Regular, Menlo, monospace";
    const lines = text.split("\n");
    context.fillText(lines[0], 22, 43);
    context.fillStyle = "#cbd5e1";
    context.font = "23px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(lines[1], 22, 88);
    texture.needsUpdate = true;
  }

  private createPanel() {
    this.panel.dataset.enemyAiDebug = "panel";
    this.panel.style.cssText = [
      "position:fixed",
      "top:12px",
      "right:12px",
      "z-index:2000",
      "padding:9px 12px",
      "border:1px solid rgba(56,189,248,.72)",
      "border-radius:8px",
      "background:rgba(5,12,18,.88)",
      "color:#e2e8f0",
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "pointer-events:none",
      "white-space:pre",
    ].join(";");
    const forcedKind = this.options.forcedKind ?? "weighted";
    this.panel.textContent = `ENEMY AI DEBUG · F3\nseed ${this.options.seed} · spawn ${forcedKind}\nlegacy chase · path data pending phase B`;
    document.body.append(this.panel);
    this.syncVisibility();
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "F3" || event.repeat) return;
    event.preventDefault();
    this.enabled = !this.enabled;
    this.syncVisibility();
  };

  private syncVisibility() {
    this.root.visible = this.enabled;
    this.panel.style.display = this.enabled ? "block" : "none";
  }
}
