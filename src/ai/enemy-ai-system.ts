import type * as THREE from "three";
import type { EnemyKind } from "../config";
import { EnemyAiDebugLayer } from "./enemy-ai-debug";
import {
  createEnemyAiRuntime,
  recordEnemyMovement,
  setEnemyAiState,
  type EnemyAiRuntime,
  type EnemyMovementSample,
} from "./enemy-ai-runtime";
import { SeededRandom } from "./seeded-random";

type RegularEnemyKind = Exclude<EnemyKind, "boss">;
type SpawnWeights = Record<RegularEnemyKind, number>;

export type EnemyAiDevelopmentOptions = {
  seed: number;
  forcedKind?: EnemyKind;
  debugEnabled: boolean;
};

const ENEMY_KINDS = new Set<EnemyKind>(["bug", "changeRequest", "meeting", "boss"]);

const createRuntimeSeed = () => {
  const values = new Uint32Array(1);
  globalThis.crypto?.getRandomValues(values);
  return values[0] || Date.now() >>> 0;
};

export const readEnemyAiDevelopmentOptions = (search: string): EnemyAiDevelopmentOptions => {
  const params = new URLSearchParams(search);
  const requestedSeed = params.get("aiSeed");
  const requestedKind = params.get("aiEnemy");
  const forcedKind = requestedKind && ENEMY_KINDS.has(requestedKind as EnemyKind)
    ? requestedKind as EnemyKind
    : undefined;

  if (requestedKind && !forcedKind) {
    console.warn(`[Enemy AI] Unknown aiEnemy '${requestedKind}'. Expected bug, changeRequest, meeting, or boss.`);
  }

  const random = new SeededRandom(requestedSeed ?? createRuntimeSeed());
  return {
    seed: random.seed,
    forcedKind,
    debugEnabled: params.get("aiDebug") === "1",
  };
};

export class EnemyAiSystem {
  readonly options: EnemyAiDevelopmentOptions;
  private readonly randomSource: SeededRandom;
  private readonly debugLayer: EnemyAiDebugLayer;

  constructor(scene: THREE.Scene, search = window.location.search) {
    this.options = readEnemyAiDevelopmentOptions(search);
    this.randomSource = new SeededRandom(this.options.seed);
    this.debugLayer = new EnemyAiDebugLayer(scene, {
      enabled: this.options.debugEnabled,
      seed: this.options.seed,
      forcedKind: this.options.forcedKind,
    });

    if (this.options.debugEnabled || this.options.forcedKind || new URLSearchParams(search).has("aiSeed")) {
      console.info(
        `[Enemy AI] seed=${this.options.seed} spawn=${this.options.forcedKind ?? "weighted"}; press F3 to toggle debug`,
      );
    }
  }

  random() {
    return this.randomSource.next();
  }

  randomRange(min: number, max: number) {
    return this.randomSource.range(min, max);
  }

  randomInteger(maxExclusive: number) {
    return this.randomSource.integer(maxExclusive);
  }

  pickSpawnKind(weights: SpawnWeights): EnemyKind {
    if (this.options.forcedKind) return this.options.forcedKind;
    const total = weights.bug + weights.changeRequest + weights.meeting;
    const roll = this.random() * total;
    if (roll < weights.bug) return "bug";
    if (roll < weights.bug + weights.changeRequest) return "changeRequest";
    return "meeting";
  }

  createRuntime(id: number, kind: EnemyKind, x: number, z: number, now: number) {
    return createEnemyAiRuntime(id, kind, x, z, now);
  }

  recordMovement(runtime: EnemyAiRuntime, sample: EnemyMovementSample, height: number) {
    recordEnemyMovement(runtime, sample);
    this.debugLayer.update(runtime, { x: sample.x, z: sample.z, height });
  }

  remove(runtime: EnemyAiRuntime, now: number) {
    setEnemyAiState(runtime, "dead", now);
    this.debugLayer.remove(runtime.id);
  }
}
