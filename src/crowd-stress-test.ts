import * as THREE from "three";
import "./crowd-stress-test.css";
import { EnemyAiSystem } from "./ai/enemy-ai-system";
import type { EnemyAiRuntime } from "./ai/enemy-ai-runtime";
import {
  CharacterAssetStore,
  type CharacterVisual,
  turnCharacterTowardMovement,
} from "./characters/animated-character";
import { CHARACTER_MODELS } from "./characters/catalog";
import { ENEMY_CONFIG, type EnemyKind } from "./config";
import { NavigationWorld } from "./navigation";

const WORLD_WIDTH = 1000;
const WORLD_DEPTH = 600;
const CORRIDOR_CENTER_Z = 300;
const CORRIDOR_WIDTH = 132;
const WALL_WIDTH = 720;
const TEST_DURATION = 8;
const MINIMUM_OBSERVATION_TIME = 5.5;
const INITIAL_AI_TIME = 1;

type StressEnemy = {
  runtime: EnemyAiRuntime;
  mesh: THREE.Group;
  visual: CharacterVisual;
  kind: EnemyKind;
  speed: number;
  radius: number;
  targetX: number;
  targetZ: number;
  initialX: number;
};

type CrowdTotals = {
  overlapPairs: number;
  correctionApplications: number;
  recoveryPriorityPairs: number;
  dualRecoveryYieldPairs: number;
  recoveryYieldStarts: number;
  maximumActiveYields: number;
  maximumRemainingOverlapPairs: number;
  maximumRemainingOverlap: number;
};

const createCrowdTotals = (): CrowdTotals => ({
  overlapPairs: 0,
  correctionApplications: 0,
  recoveryPriorityPairs: 0,
  dualRecoveryYieldPairs: 0,
  recoveryYieldStarts: 0,
  maximumActiveYields: 0,
  maximumRemainingOverlapPairs: 0,
  maximumRemainingOverlap: 0,
});

const createSessionId = () => `crowd-stress-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

class CrowdStressTest {
  private readonly app = document.querySelector<HTMLDivElement>("#crowd-test-app")!;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-500, 500, 300, -300, 1, 2400);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly navigation = new NavigationWorld(WORLD_WIDTH, WORLD_DEPTH);
  private readonly ai = new EnemyAiSystem(this.scene, "?aiSeed=120");
  private readonly characterAssets = new CharacterAssetStore();
  private readonly clock = new THREE.Clock();
  private readonly panel = document.createElement("section");
  private readonly status = document.createElement("span");
  private readonly metrics = new Map<string, HTMLElement>();
  private readonly enemies: StressEnemy[] = [];
  private sessionId = createSessionId();
  private elapsed = 0;
  private nextSnapshotAt = 0.5;
  private running = false;
  private completed = false;
  private assetsReady = false;
  private crowdTotals = createCrowdTotals();
  private failureEntries = 0;
  private maximumRecoveryLevel = 0;
  private remainedCollisionSafe = true;
  private readonly instantMode = new URLSearchParams(window.location.search).get("instant") === "1";

  constructor() {
    this.scene.background = new THREE.Color(0x07110f);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.camera.position.set(500, 760, 800);
    this.camera.lookAt(500, 0, 300);
    this.setupLighting();
    this.setupMap();
    this.setupPanel();
    this.app.appendChild(this.renderer.domElement);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.setStatus("LOADING", "running");
    if (!this.instantMode) this.renderer.setAnimationLoop(this.frame);
    void this.loadCharactersAndStart();
  }

  private async loadCharactersAndStart() {
    try {
      await Promise.all([
        this.characterAssets.preload(CHARACTER_MODELS.ppt),
        this.characterAssets.preload(CHARACTER_MODELS.bug),
      ]);
      this.assetsReady = true;
      this.reset();
      if (this.instantMode) {
        for (let step = 0; step < TEST_DURATION * 60 && this.running; step += 1) {
          this.update(1 / 60);
        }
        this.renderer.render(this.scene, this.camera);
      }
    } catch (error) {
      console.error("Failed to load stress-test character models", error);
      this.setStatus("LOAD FAIL", "failed");
      void this.postEvent({
        type: "crowd-stress-load-failure",
        capturedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setupLighting() {
    this.scene.add(new THREE.HemisphereLight(0xcfffe8, 0x17201d, 1.7));
    const light = new THREE.DirectionalLight(0xffffff, 2.1);
    light.position.set(300, 700, 180);
    light.castShadow = true;
    this.scene.add(light);
  }

  private setupMap() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_WIDTH, WORLD_DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x18312a, roughness: 0.92 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(WORLD_WIDTH / 2, 0, WORLD_DEPTH / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallDepth = (WORLD_DEPTH - CORRIDOR_WIDTH) / 2;
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x52615d, roughness: 0.86 });
    const createWall = (z: number) => {
      this.navigation.addObstacle(WORLD_WIDTH / 2, z, WALL_WIDTH, wallDepth);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(WALL_WIDTH, 62, wallDepth), wallMaterial);
      wall.position.set(WORLD_WIDTH / 2, 31, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.scene.add(wall);
    };
    createWall(wallDepth / 2);
    createWall(WORLD_DEPTH - wallDepth / 2);

    const corridor = new THREE.Mesh(
      new THREE.PlaneGeometry(WALL_WIDTH, CORRIDOR_WIDTH),
      new THREE.MeshBasicMaterial({ color: 0x234b3f, transparent: true, opacity: 0.72 }),
    );
    corridor.rotation.x = -Math.PI / 2;
    corridor.position.set(WORLD_WIDTH / 2, 0.5, CORRIDOR_CENTER_Z);
    this.scene.add(corridor);

    this.scene.add(this.createTargetMarker(820, CORRIDOR_CENTER_Z, 0x60a5fa));
    this.scene.add(this.createTargetMarker(180, CORRIDOR_CENTER_Z, 0xff6f61));
  }

  private createTargetMarker(x: number, z: number, color: number) {
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(18, 25, 28),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    marker.rotation.x = -Math.PI / 2;
    marker.position.set(x, 2, z);
    return marker;
  }

  private setupPanel() {
    this.panel.className = "stress-panel";
    this.panel.innerHTML = `
      <div class="stress-title-row">
        <h1 class="stress-title">窄通道双恢复让行测试</h1>
      </div>
      <p class="stress-copy">真实 PPT 怪与 Bug 怪从重叠恢复状态出发，随后继续走向通道另一端。无需操作，约 8 秒自动给出结果。</p>
      <div class="stress-grid"></div>
      <div class="stress-actions"><button class="stress-button" type="button">重新运行</button></div>
    `;
    this.status.className = "stress-status";
    this.status.dataset.state = "running";
    this.status.textContent = "RUNNING";
    this.panel.querySelector(".stress-title-row")?.appendChild(this.status);
    const grid = this.panel.querySelector<HTMLDivElement>(".stress-grid")!;
    for (const [key, label] of [
      ["time", "时间"],
      ["distance", "怪物间距"],
      ["first", "PPT 怪 #1"],
      ["second", "Bug 怪 #2"],
      ["yield", "侧向让行"],
      ["dual", "双恢复修正"],
      ["failures", "重复 Failure"],
      ["remaining", "最大残留重叠"],
    ] as const) {
      const metric = document.createElement("div");
      metric.className = "stress-metric";
      metric.innerHTML = `<span>${label}</span><strong>-</strong>`;
      grid.appendChild(metric);
      this.metrics.set(key, metric.querySelector("strong")!);
    }
    this.panel.querySelector("button")?.addEventListener("click", () => {
      if (this.assetsReady) this.reset();
    });
    document.body.appendChild(this.panel);

    const legend = document.createElement("div");
    legend.className = "stress-legend";
    legend.textContent = "PPT 怪优先通行 · Bug 怪侧向让路";
    document.body.appendChild(legend);
  }

  private reset() {
    for (const enemy of this.enemies) {
      this.scene.remove(enemy.mesh);
      enemy.visual.dispose();
      this.ai.remove(enemy.runtime, INITIAL_AI_TIME + this.elapsed);
    }
    this.enemies.length = 0;
    this.sessionId = createSessionId();
    this.elapsed = 0;
    this.nextSnapshotAt = 0.5;
    this.running = true;
    this.completed = false;
    this.crowdTotals = createCrowdTotals();
    this.failureEntries = 0;
    this.maximumRecoveryLevel = 0;
    this.remainedCollisionSafe = true;
    this.createEnemy(1, "meeting", 475, 294, 820, CORRIDOR_CENTER_Z, 0x60a5fa);
    this.createEnemy(2, "bug", 525, 306, 180, CORRIDOR_CENTER_Z, 0xff6f61);
    this.clock.getDelta();
    this.setStatus("RUNNING", "running");
    void this.postEvent({
      type: "crowd-stress-start",
      capturedAt: new Date().toISOString(),
      corridorWidth: CORRIDOR_WIDTH,
      testDuration: TEST_DURATION,
      enemies: this.enemies.map((enemy) => ({
        id: enemy.runtime.id,
        kind: enemy.kind,
        visualModel: enemy.kind === "meeting" ? "ppt" : "bug",
        x: enemy.runtime.currentX,
        z: enemy.runtime.currentZ,
        targetX: enemy.targetX,
        targetZ: enemy.targetZ,
        radius: enemy.radius,
      })),
    });
    this.updatePanel();
  }

  private createEnemy(
    id: number,
    kind: EnemyKind,
    x: number,
    z: number,
    targetX: number,
    targetZ: number,
    color: number,
  ) {
    const config = ENEMY_CONFIG[kind];
    const runtime = this.ai.createRuntime(id, kind, x, z, 0);
    runtime.previousState = "patrolMove";
    runtime.state = "stuckRecovery";
    runtime.stateEnteredAt = 0;
    runtime.failure = "insufficientProgress";
    runtime.failureCause = "crowdBlocked";
    runtime.stuckSince = 0;
    runtime.lastProgressAt = 0;
    runtime.lastProgressX = x;
    runtime.lastProgressZ = z;
    runtime.targetX = targetX;
    runtime.targetZ = targetZ;

    const modelConfig = kind === "bug" ? CHARACTER_MODELS.bug : CHARACTER_MODELS.ppt;
    const visual = this.characterAssets.create(modelConfig, {
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(config.radius, config.radius + 3, 28),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 2;
    const group = new THREE.Group();
    group.add(visual.root, ring);
    group.position.set(x, 0, z);
    group.rotation.y = Math.atan2(targetX - x, targetZ - z);
    this.scene.add(group);
    this.enemies.push({
      runtime,
      mesh: group,
      visual,
      kind,
      speed: config.speed,
      radius: config.radius,
      targetX,
      targetZ,
      initialX: x,
    });
  }

  private frame = () => {
    const delta = Math.min(this.clock.getDelta(), 1 / 30);
    if (this.running) this.update(delta);
    this.renderer.render(this.scene, this.camera);
  };

  private update(delta: number) {
    this.elapsed += delta;
    const now = INITIAL_AI_TIME + this.elapsed;
    this.ai.updateCrowd(delta, this.navigation, WORLD_WIDTH / 2, WORLD_DEPTH / 2, 30);

    for (const enemy of this.enemies) {
      const direction = this.ai.getMovementDirection(enemy.runtime, this.navigation, {
        now,
        x: enemy.runtime.currentX,
        z: enemy.runtime.currentZ,
        targetX: enemy.targetX,
        targetZ: enemy.targetZ,
        flowTargetX: enemy.targetX,
        flowTargetZ: enemy.targetZ,
        radius: enemy.radius,
        separationX: enemy.runtime.separationX,
        separationZ: enemy.runtime.separationZ,
      });
      turnCharacterTowardMovement(enemy.mesh, direction.x, direction.z, delta);
      const length = Math.max(0.001, Math.hypot(direction.x, direction.z));
      const next = this.navigation.moveCircle(
        enemy.runtime.currentX,
        enemy.runtime.currentZ,
        (direction.x / length) * enemy.speed * delta,
        (direction.z / length) * enemy.speed * delta,
        enemy.radius,
      );
      this.ai.recordMovement(enemy.runtime, {
        now,
        x: next.x,
        z: next.z,
        targetX: enemy.targetX,
        targetZ: enemy.targetZ,
        desiredVelocityX: direction.x,
        desiredVelocityZ: direction.z,
      }, ENEMY_CONFIG[enemy.kind].height);
      this.maximumRecoveryLevel = Math.max(this.maximumRecoveryLevel, enemy.runtime.recoveryLevel);
    }

    this.ai.resolveCrowdOverlaps(this.navigation);
    for (const enemy of this.enemies) {
      const movedX = enemy.runtime.currentX - enemy.mesh.position.x;
      const movedZ = enemy.runtime.currentZ - enemy.mesh.position.z;
      enemy.visual.setMovement(movedX / Math.max(delta, 0.001), movedZ / Math.max(delta, 0.001));
      enemy.visual.update(delta);
      enemy.mesh.position.x = enemy.runtime.currentX;
      enemy.mesh.position.z = enemy.runtime.currentZ;
      this.remainedCollisionSafe &&= this.navigation.canOccupy(
        enemy.runtime.currentX,
        enemy.runtime.currentZ,
        enemy.radius,
      );
    }

    if (this.elapsed >= this.nextSnapshotAt) {
      this.captureSnapshot(now);
      this.nextSnapshotAt += 0.5;
    }
    if (this.elapsed + 1e-6 >= TEST_DURATION) {
      this.elapsed = TEST_DURATION;
      this.finish(INITIAL_AI_TIME + this.elapsed);
    } else {
      this.updatePanel();
    }
  }

  private captureSnapshot(now: number) {
    const snapshot = this.ai.takePerformanceSnapshot(now);
    const crowd = snapshot.crowd;
    this.crowdTotals.overlapPairs += crowd.overlapPairs;
    this.crowdTotals.correctionApplications += crowd.correctionApplications;
    this.crowdTotals.recoveryPriorityPairs += crowd.recoveryPriorityPairs;
    this.crowdTotals.dualRecoveryYieldPairs += crowd.dualRecoveryYieldPairs;
    this.crowdTotals.recoveryYieldStarts += crowd.recoveryYieldStarts;
    this.crowdTotals.maximumActiveYields = Math.max(
      this.crowdTotals.maximumActiveYields,
      crowd.maximumActiveYields,
    );
    this.crowdTotals.maximumRemainingOverlapPairs = Math.max(
      this.crowdTotals.maximumRemainingOverlapPairs,
      crowd.maximumRemainingOverlapPairs,
    );
    this.crowdTotals.maximumRemainingOverlap = Math.max(
      this.crowdTotals.maximumRemainingOverlap,
      crowd.maximumRemainingOverlap,
    );
    this.failureEntries += snapshot.failureTransitions.filter((transition) => (
      transition.from === "none" && transition.to !== "none"
    )).length;
    void this.postEvent({
      type: "crowd-stress-sample",
      capturedAt: new Date().toISOString(),
      elapsed: Number(this.elapsed.toFixed(2)),
      enemies: this.enemies.map((enemy) => ({
        id: enemy.runtime.id,
        state: enemy.runtime.state,
        failure: enemy.runtime.failure,
        failureCause: enemy.runtime.failureCause,
        recoveryLevel: enemy.runtime.recoveryLevel,
        x: Number(enemy.runtime.currentX.toFixed(2)),
        z: Number(enemy.runtime.currentZ.toFixed(2)),
      })),
      crowd,
      failureTransitions: snapshot.failureTransitions,
    });
  }

  private finish(now: number) {
    if (this.completed || this.elapsed < MINIMUM_OBSERVATION_TIME) return;
    this.completed = true;
    this.running = false;
    this.captureSnapshot(now);
    const [first, second] = this.enemies;
    const distance = Math.hypot(
      first.runtime.currentX - second.runtime.currentX,
      first.runtime.currentZ - second.runtime.currentZ,
    );
    const criteria = {
      yieldTriggered: this.crowdTotals.recoveryYieldStarts > 0,
      dualRecoveryResolved: this.crowdTotals.dualRecoveryYieldPairs > 0,
      orderSwapped: first.runtime.currentX > second.runtime.currentX,
      separated: distance >= first.radius + second.radius,
      recovered: this.enemies.every((enemy) => enemy.runtime.failure === "none"),
      noLevelThree: this.maximumRecoveryLevel < 3,
      noRepeatedFailure: this.failureEntries === 0,
      collisionSafe: this.remainedCollisionSafe,
    };
    const passed = Object.values(criteria).every(Boolean);
    this.setStatus(passed ? "PASS" : "FAIL", passed ? "passed" : "failed");
    this.updatePanel();
    void this.postEvent({
      type: "crowd-stress-result",
      capturedAt: new Date().toISOString(),
      elapsed: Number(this.elapsed.toFixed(2)),
      passed,
      criteria,
      failureEntries: this.failureEntries,
      maximumRecoveryLevel: this.maximumRecoveryLevel,
      finalDistance: Number(distance.toFixed(2)),
      crowd: this.crowdTotals,
      enemies: this.enemies.map((enemy) => ({
        id: enemy.runtime.id,
        kind: enemy.kind,
        visualModel: enemy.kind === "meeting" ? "ppt" : "bug",
        x: Number(enemy.runtime.currentX.toFixed(2)),
        z: Number(enemy.runtime.currentZ.toFixed(2)),
        targetX: enemy.targetX,
        targetZ: enemy.targetZ,
        state: enemy.runtime.state,
        failure: enemy.runtime.failure,
        failureCause: enemy.runtime.failureCause,
      })),
    });
  }

  private updatePanel() {
    const [first, second] = this.enemies;
    if (!first || !second) return;
    const distance = Math.hypot(
      first.runtime.currentX - second.runtime.currentX,
      first.runtime.currentZ - second.runtime.currentZ,
    );
    this.setMetric("time", `${this.elapsed.toFixed(1)} / ${TEST_DURATION.toFixed(0)}s`);
    this.setMetric("distance", distance.toFixed(1));
    this.setMetric("first", `${first.runtime.state} · ${first.runtime.failureCause}`);
    this.setMetric("second", `${second.runtime.state} · ${second.runtime.failureCause}`);
    this.setMetric("yield", `${this.crowdTotals.recoveryYieldStarts}`);
    this.setMetric("dual", `${this.crowdTotals.dualRecoveryYieldPairs}`);
    this.setMetric("failures", `${this.failureEntries}`);
    this.setMetric("remaining", `${this.crowdTotals.maximumRemainingOverlapPairs} / ${this.crowdTotals.maximumRemainingOverlap.toFixed(1)}`);
  }

  private setMetric(key: string, value: string) {
    const metric = this.metrics.get(key);
    if (metric) metric.textContent = value;
  }

  private setStatus(label: string, state: "running" | "passed" | "failed") {
    this.status.textContent = label;
    this.status.dataset.state = state;
  }

  private postEvent(event: Record<string, unknown>) {
    return fetch("/__perf-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, events: [event] }),
      keepalive: true,
    }).catch(() => undefined);
  }

  private resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const aspect = width / Math.max(1, height);
    const viewHeight = aspect < 1 ? 760 : 620;
    const viewWidth = viewHeight * aspect;
    this.camera.left = -viewWidth / 2;
    this.camera.right = viewWidth / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };
}

new CrowdStressTest();
