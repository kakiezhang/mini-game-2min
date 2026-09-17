import type * as THREE from "three";
import type { EnemyKind } from "../config";
import type { NavigationPerformanceMetrics, NavigationWorld } from "../navigation";
import { renderPerformanceProfile } from "./render-performance-profile";

type FramePhase = "update" | "enemies" | "render";

type FrameContext = {
  gameElapsed: number;
  gameState: string;
  enemyCount: number;
  animatedEnemyCount: number;
  rendererInfo: THREE.WebGLInfo;
};

type PerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

type BrowserPerformance = Performance & {
  memory?: PerformanceMemory;
};

type NavigatorWithDeviceInfo = Navigator & {
  deviceMemory?: number;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
};

type SpawnSample = {
  kind: EnemyKind;
  durationMs: number;
  gameElapsed: number;
};

type TelemetryEvent = Record<string, unknown> & {
  type: string;
  capturedAt: string;
  perfNowMs: number;
};

type PerformanceSnapshotProvider = () => Record<string, unknown>;

const LONG_FRAME_THRESHOLD_MS = 50;
const SUMMARY_INTERVAL_MS = 5000;
const MAX_QUEUED_EVENTS = 120;

const createNavigationMetrics = (): NavigationPerformanceMetrics => ({
  directionCalls: 0,
  reachabilityChecks: 0,
  flowRequests: 0,
  flowCacheHits: 0,
  flowRebuilds: 0,
  flowRebuildMs: 0,
  blockedGridRebuilds: 0,
  blockedGridRebuildMs: 0,
});

const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const percentile = (values: number[], ratio: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
};

const createSessionId = () => {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export class GamePerformanceMonitor {
  readonly enabled: boolean;
  readonly sessionId: string;

  private readonly phases: Partial<Record<FramePhase, number>> = {};
  private readonly frameIntervals: number[] = [];
  private readonly workDurations: number[] = [];
  private readonly phaseTotals: Record<FramePhase, number> = { update: 0, enemies: 0, render: 0 };
  private readonly phaseMaximums: Record<FramePhase, number> = { update: 0, enemies: 0, render: 0 };
  private readonly queue: TelemetryEvent[] = [];
  private navigationTotals = createNavigationMetrics();
  private readonly thresholdMs: number;
  private frameStartedAt = 0;
  private previousFrameStartedAt = 0;
  private summaryStartedAt = 0;
  private readonly spawnSamples: SpawnSample[] = [];
  private latestRuntimeSnapshot: Record<string, unknown> = {};
  private flushing = false;

  constructor(
    private readonly navigation: NavigationWorld,
    private readonly scene: THREE.Scene,
    private readonly aiSnapshotProvider?: PerformanceSnapshotProvider,
    search = window.location.search,
  ) {
    const params = new URLSearchParams(search);
    this.enabled = params.get("perf") === "1";
    this.sessionId = createSessionId();
    const requestedThreshold = Number(params.get("perfThreshold"));
    this.thresholdMs = Number.isFinite(requestedThreshold) && requestedThreshold >= 16
      ? requestedThreshold
      : LONG_FRAME_THRESHOLD_MS;
    this.navigation.setPerformanceTracking(this.enabled);
    if (!this.enabled) return;

    this.summaryStartedAt = performance.now();
    this.enqueue("session-start", this.createDeviceSnapshot(params));
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.setInterval(() => this.flushSummary(), SUMMARY_INTERVAL_MS);
    this.createIndicator();
    console.info(`[Performance] recording session ${this.sessionId}; slow frame threshold ${this.thresholdMs}ms`);
  }

  beginFrame() {
    if (!this.enabled) return;
    const now = performance.now();
    this.frameStartedAt = now;
    this.spawnSamples.length = 0;
    this.phases.update = 0;
    this.phases.enemies = 0;
    this.phases.render = 0;

    if (this.previousFrameStartedAt > 0) {
      this.frameIntervals.push(now - this.previousFrameStartedAt);
    }
    this.previousFrameStartedAt = now;
  }

  startPhase() {
    return this.enabled ? performance.now() : -1;
  }

  finishPhase(phase: FramePhase, startedAt: number) {
    if (!this.enabled || startedAt < 0) return;
    const duration = performance.now() - startedAt;
    this.phases[phase] = (this.phases[phase] ?? 0) + duration;
    this.phaseTotals[phase] += duration;
    this.phaseMaximums[phase] = Math.max(this.phaseMaximums[phase], duration);
  }

  measureSpawn(kind: EnemyKind, gameElapsed: number, spawn: () => void) {
    if (!this.enabled) {
      spawn();
      return;
    }
    const startedAt = performance.now();
    spawn();
    const durationMs = performance.now() - startedAt;
    this.spawnSamples.push({ kind, durationMs, gameElapsed });
    this.enqueue("enemy-spawn", {
      kind,
      durationMs: round(durationMs),
      gameElapsed: round(gameElapsed),
    });
  }

  finishFrame(context: FrameContext) {
    if (!this.enabled || this.frameStartedAt <= 0) return;
    const finishedAt = performance.now();
    const workDuration = finishedAt - this.frameStartedAt;
    const interval = this.frameIntervals.at(-1) ?? workDuration;
    this.workDurations.push(workDuration);
    const navigation = this.navigation.takePerformanceMetrics();
    this.accumulateNavigation(navigation);
    this.latestRuntimeSnapshot = this.createRuntimeSnapshot(context);

    if (workDuration >= this.thresholdMs || interval >= this.thresholdMs) {
      this.enqueue("long-frame", this.createFrameSnapshot(navigation, workDuration, interval));
      void this.flush();
    }
  }

  private createFrameSnapshot(
    navigation: NavigationPerformanceMetrics,
    workDuration: number,
    interval: number,
  ) {
    return {
      frameIntervalMs: round(interval),
      frameWorkMs: round(workDuration),
      updateMs: round(this.phases.update ?? 0),
      enemiesMs: round(this.phases.enemies ?? 0),
      renderMs: round(this.phases.render ?? 0),
      spawns: this.spawnSamples.map((sample) => ({
        kind: sample.kind,
        durationMs: round(sample.durationMs),
        gameElapsed: round(sample.gameElapsed),
      })),
      navigation: this.roundNavigation(navigation),
      enemyAi: this.aiSnapshotProvider?.(),
      ...this.latestRuntimeSnapshot,
      lighting: this.createLightingSnapshot(),
      memory: this.readMemory(),
    };
  }

  private flushSummary() {
    if (!this.enabled || this.frameIntervals.length === 0) return;
    const now = performance.now();
    const navigation = this.navigationTotals;
    const contextDuration = now - this.summaryStartedAt;
    this.enqueue("frame-summary", {
      durationMs: round(contextDuration),
      frameCount: this.frameIntervals.length,
      frameIntervalMs: {
        average: round(this.frameIntervals.reduce((sum, value) => sum + value, 0) / this.frameIntervals.length),
        p95: round(percentile(this.frameIntervals, 0.95)),
        maximum: round(Math.max(...this.frameIntervals)),
      },
      frameWorkMs: {
        average: round(this.workDurations.reduce((sum, value) => sum + value, 0) / Math.max(1, this.workDurations.length)),
        p95: round(percentile(this.workDurations, 0.95)),
        maximum: round(Math.max(...this.workDurations)),
      },
      phases: {
        updateAverageMs: round(this.phaseTotals.update / Math.max(1, this.workDurations.length)),
        updateMaximumMs: round(this.phaseMaximums.update),
        enemiesAverageMs: round(this.phaseTotals.enemies / Math.max(1, this.workDurations.length)),
        enemiesMaximumMs: round(this.phaseMaximums.enemies),
        renderAverageMs: round(this.phaseTotals.render / Math.max(1, this.workDurations.length)),
        renderMaximumMs: round(this.phaseMaximums.render),
      },
      navigation: this.roundNavigation(navigation),
      enemyAi: this.aiSnapshotProvider?.(),
      ...this.latestRuntimeSnapshot,
      lighting: this.createLightingSnapshot(),
      memory: this.readMemory(),
    });
    this.frameIntervals.length = 0;
    this.workDurations.length = 0;
    this.phaseTotals.update = 0;
    this.phaseTotals.enemies = 0;
    this.phaseTotals.render = 0;
    this.phaseMaximums.update = 0;
    this.phaseMaximums.enemies = 0;
    this.phaseMaximums.render = 0;
    this.navigationTotals = createNavigationMetrics();
    this.summaryStartedAt = now;
    void this.flush();
  }

  private createRuntimeSnapshot(context: FrameContext) {
    const render = context.rendererInfo.render;
    const memory = context.rendererInfo.memory;
    return {
      gameElapsed: round(context.gameElapsed),
      gameState: context.gameState,
      enemyCount: context.enemyCount,
      animatedEnemyCount: context.animatedEnemyCount,
      renderer: {
        calls: render.calls,
        triangles: render.triangles,
        lines: render.lines,
        points: render.points,
        geometries: memory.geometries,
        textures: memory.textures,
        programs: context.rendererInfo.programs?.length ?? 0,
      },
    };
  }

  private createLightingSnapshot() {
    let pointLights = 0;
    let visiblePointLights = 0;
    let dynamicPointLights = 0;
    let visibleDynamicPointLights = 0;

    const visit = (object: THREE.Object3D, parentVisible: boolean) => {
      const visible = parentVisible && object.visible;
      if (object.type === "PointLight") {
        pointLights += 1;
        if (visible) visiblePointLights += 1;
        if (object.userData.performanceDynamicPointLight) {
          dynamicPointLights += 1;
          if (visible) visibleDynamicPointLights += 1;
        }
      }
      for (const child of object.children) visit(child, visible);
    };

    visit(this.scene, true);
    return { pointLights, visiblePointLights, dynamicPointLights, visibleDynamicPointLights };
  }

  private createDeviceSnapshot(params: URLSearchParams) {
    const deviceNavigator = navigator as NavigatorWithDeviceInfo;
    const connection = deviceNavigator.connection;
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: deviceNavigator.deviceMemory,
      connection: connection ? {
        effectiveType: connection.effectiveType,
        downlink: connection.downlink,
        rtt: connection.rtt,
        saveData: connection.saveData,
      } : undefined,
      aiSeed: params.get("aiSeed"),
      aiEnemy: params.get("aiEnemy"),
      aiDebug: params.get("aiDebug") === "1",
      renderProfile: renderPerformanceProfile,
      thresholdMs: this.thresholdMs,
    };
  }

  private readMemory() {
    const memory = (performance as BrowserPerformance).memory;
    if (!memory) return undefined;
    return {
      usedJsHeapBytes: memory.usedJSHeapSize,
      totalJsHeapBytes: memory.totalJSHeapSize,
      jsHeapLimitBytes: memory.jsHeapSizeLimit,
    };
  }

  private roundNavigation(metrics: NavigationPerformanceMetrics) {
    return {
      directionCalls: metrics.directionCalls,
      reachabilityChecks: metrics.reachabilityChecks,
      flowRequests: metrics.flowRequests,
      flowCacheHits: metrics.flowCacheHits,
      flowRebuilds: metrics.flowRebuilds,
      flowRebuildMs: round(metrics.flowRebuildMs),
      blockedGridRebuilds: metrics.blockedGridRebuilds,
      blockedGridRebuildMs: round(metrics.blockedGridRebuildMs),
    };
  }

  private accumulateNavigation(metrics: NavigationPerformanceMetrics) {
    for (const key of Object.keys(metrics) as Array<keyof NavigationPerformanceMetrics>) {
      this.navigationTotals[key] += metrics[key];
    }
  }

  private enqueue(type: string, details: Record<string, unknown>) {
    this.queue.push({
      type,
      capturedAt: new Date().toISOString(),
      perfNowMs: round(performance.now()),
      ...details,
    });
    if (this.queue.length > MAX_QUEUED_EVENTS) this.queue.splice(0, this.queue.length - MAX_QUEUED_EVENTS);
  }

  private async flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const events = this.queue.splice(0, Math.min(40, this.queue.length));
    let uploaded = false;
    try {
      const response = await fetch("/__perf-log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, events }),
        keepalive: true,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      uploaded = true;
    } catch (error) {
      this.queue.unshift(...events.slice(-MAX_QUEUED_EVENTS));
      console.warn("[Performance] failed to upload telemetry", error);
    } finally {
      this.flushing = false;
      if (uploaded && this.queue.length > 0) window.setTimeout(() => void this.flush(), 0);
    }
  }

  private onPageHide = () => {
    this.flushSummary();
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0, this.queue.length);
    const payload = JSON.stringify({ sessionId: this.sessionId, events });
    if (!navigator.sendBeacon("/__perf-log", new Blob([payload], { type: "application/json" }))) {
      this.queue.unshift(...events);
    }
  };

  private onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this.flushSummary();
      this.previousFrameStartedAt = 0;
      return;
    }
    this.previousFrameStartedAt = performance.now();
    this.summaryStartedAt = performance.now();
  };

  private createIndicator() {
    const indicator = document.createElement("div");
    const lightMode = renderPerformanceProfile.dynamicPointLights === "disabled" ? " · LIGHTS OFF" : "";
    indicator.textContent = `PERF REC${lightMode} · ${this.sessionId.slice(0, 8)}`;
    indicator.style.cssText = [
      "position:fixed",
      "left:10px",
      "bottom:10px",
      "z-index:2100",
      "padding:5px 8px",
      "border-radius:6px",
      "background:rgba(127,29,29,.88)",
      "color:#fecaca",
      "font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace",
      "pointer-events:none",
    ].join(";");
    document.body.append(indicator);
  }
}
