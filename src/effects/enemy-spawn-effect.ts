import * as THREE from "three";

export type EnemySpawnEffectOptions = {
  id: number;
  x: number;
  z: number;
  radius: number;
  height: number;
  color: number;
  target: THREE.Object3D;
  healthBar: THREE.Object3D;
  boss?: boolean;
  onComplete: () => void;
};

type AnimatedPuff = {
  mesh: THREE.Mesh;
  angle: number;
  distance: number;
  size: number;
  delay: number;
  rise: number;
};

type SpawnEffect = {
  elapsed: number;
  duration: number;
  radius: number;
  group: THREE.Group;
  target: THREE.Object3D;
  healthBar: THREE.Object3D;
  ring: THREE.Mesh;
  pool: THREE.Mesh;
  bubbles: AnimatedPuff[];
  smoke: AnimatedPuff[];
  bubbleMaterial: THREE.MeshBasicMaterial;
  smokeMaterial: THREE.MeshBasicMaterial;
  ringMaterial: THREE.MeshBasicMaterial;
  poolMaterial: THREE.MeshBasicMaterial;
  revealed: boolean;
  onComplete: () => void;
};

const clamp01 = (value: number) => THREE.MathUtils.clamp(value, 0, 1);
const easeOutCubic = (value: number) => 1 - (1 - value) ** 3;
const smoothstep = (from: number, to: number, value: number) => {
  const progress = clamp01((value - from) / (to - from));
  return progress * progress * (3 - 2 * progress);
};

/**
 * A lightweight, light-free spawn effect: ground bubbles swell, collapse into
 * smoke, then conceal the enemy's reveal. The system owns only temporary VFX;
 * gameplay activation stays with the caller via onComplete.
 */
export class EnemySpawnEffectSystem {
  private readonly bubbleGeometry = new THREE.SphereGeometry(1, 9, 7);
  private readonly smokeGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly ringGeometry = new THREE.RingGeometry(0.72, 1, 32);
  private readonly poolGeometry = new THREE.CircleGeometry(1, 32);
  private readonly effects = new Map<number, SpawnEffect>();

  constructor(private readonly scene: THREE.Scene) {}

  begin(options: EnemySpawnEffectOptions) {
    this.cancel(options.id);
    options.target.visible = false;
    options.target.scale.setScalar(1);
    options.healthBar.visible = false;

    const group = new THREE.Group();
    group.position.set(options.x, 0, options.z);

    const accentColor = new THREE.Color(options.color).lerp(new THREE.Color(0xd8ffd0), 0.38);
    const smokeColor = new THREE.Color(0xaeb7ad).lerp(new THREE.Color(options.color), 0.1);
    const bubbleMaterial = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const smokeMaterial = new THREE.MeshBasicMaterial({
      color: smokeColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const poolMaterial = new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const pool = new THREE.Mesh(this.poolGeometry, poolMaterial);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 1.2;
    pool.renderOrder = 30;
    group.add(pool);

    const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 1.8;
    ring.renderOrder = 31;
    group.add(ring);

    const bubbles = this.createPuffs(
      group,
      this.bubbleGeometry,
      bubbleMaterial,
      options.id,
      options.radius,
      options.height,
      6,
      false,
    );
    const smoke = this.createPuffs(
      group,
      this.smokeGeometry,
      smokeMaterial,
      options.id + 17,
      options.radius,
      options.height,
      options.boss ? 9 : 7,
      true,
    );

    this.scene.add(group);
    this.effects.set(options.id, {
      elapsed: 0,
      duration: options.boss ? 1.45 : 1.18,
      radius: options.radius,
      group,
      target: options.target,
      healthBar: options.healthBar,
      ring,
      pool,
      bubbles,
      smoke,
      bubbleMaterial,
      smokeMaterial,
      ringMaterial,
      poolMaterial,
      revealed: false,
      onComplete: options.onComplete,
    });
  }

  update(delta: number) {
    for (const [id, effect] of this.effects) {
      effect.elapsed += delta;
      const progress = clamp01(effect.elapsed / effect.duration);
      this.updateGround(effect, progress);
      this.updateBubbles(effect, progress);
      this.updateSmoke(effect, progress);
      this.updateReveal(effect, progress);
      if (progress < 1) continue;

      effect.target.visible = true;
      effect.target.scale.setScalar(1);
      effect.onComplete();
      this.disposeEffect(id, effect);
    }
  }

  isActive(id: number) {
    return this.effects.has(id);
  }

  cancel(id: number) {
    const effect = this.effects.get(id);
    if (!effect) return;
    this.disposeEffect(id, effect);
  }

  private createPuffs(
    group: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    seed: number,
    radius: number,
    height: number,
    count: number,
    smoke: boolean,
  ) {
    const puffs: AnimatedPuff[] = [];
    for (let index = 0; index < count; index += 1) {
      const phase = seed * 2.399963 + index * 2.196;
      const variation = (Math.sin(phase * 1.73) + 1) / 2;
      const angle = phase % (Math.PI * 2);
      const distance = radius * (smoke ? 0.28 + variation * 0.62 : 0.12 + variation * 0.68);
      const size = (smoke ? Math.max(14, radius * 0.54) : Math.max(7, radius * 0.27))
        * (0.78 + variation * 0.42);
      const delay = (index / Math.max(1, count - 1)) * (smoke ? 0.16 : 0.2);
      const rise = smoke
        ? height * (0.38 + variation * 0.35)
        : Math.max(16, height * (0.13 + variation * 0.12));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = smoke ? 33 : 32;
      group.add(mesh);
      puffs.push({ mesh, angle, distance, size, delay, rise });
    }
    return puffs;
  }

  private updateGround(effect: SpawnEffect, progress: number) {
    const pulse = Math.sin(progress * Math.PI * 4) * 0.045;
    const ringScale = effect.radius * (0.78 + progress * 0.64 + pulse);
    effect.ring.scale.setScalar(ringScale);
    effect.ringMaterial.opacity = 0.46 * (1 - smoothstep(0.68, 1, progress));

    const poolScale = effect.radius * (0.72 + easeOutCubic(progress) * 0.54);
    effect.pool.scale.setScalar(poolScale);
    effect.poolMaterial.opacity = 0.18 * Math.sin(progress * Math.PI);
  }

  private updateBubbles(effect: SpawnEffect, progress: number) {
    const bubbleProgress = clamp01(progress / 0.48);
    effect.bubbleMaterial.opacity = 0.52
      * smoothstep(0, 0.12, bubbleProgress)
      * (1 - smoothstep(0.7, 1, bubbleProgress));

    for (const bubble of effect.bubbles) {
      const local = clamp01((bubbleProgress - bubble.delay) / (1 - bubble.delay));
      bubble.mesh.visible = local > 0 && local < 1;
      const drift = bubble.distance * (0.65 + local * 0.35);
      bubble.mesh.position.set(
        Math.cos(bubble.angle) * drift,
        3 + bubble.rise * local,
        Math.sin(bubble.angle) * drift,
      );
      const scale = bubble.size * (0.12 + easeOutCubic(local) * 1.08);
      bubble.mesh.scale.setScalar(scale);
    }
  }

  private updateSmoke(effect: SpawnEffect, progress: number) {
    const smokeProgress = clamp01((progress - 0.3) / 0.7);
    effect.smokeMaterial.opacity = 0.58
      * smoothstep(0, 0.24, smokeProgress)
      * (1 - smoothstep(0.66, 1, smokeProgress));

    for (const puff of effect.smoke) {
      const local = clamp01((smokeProgress - puff.delay) / (1 - puff.delay));
      puff.mesh.visible = local > 0 && local < 1;
      const spread = puff.distance * (0.28 + local * 0.95);
      puff.mesh.position.set(
        Math.cos(puff.angle) * spread,
        5 + puff.rise * (0.22 + local * 0.78),
        Math.sin(puff.angle) * spread,
      );
      const scale = puff.size * (0.24 + easeOutCubic(local) * 1.2);
      puff.mesh.scale.setScalar(scale);
      puff.mesh.rotation.set(local * 0.55, puff.angle + local * 0.7, local * 0.35);
    }
  }

  private updateReveal(effect: SpawnEffect, progress: number) {
    if (progress < 0.66) return;
    if (!effect.revealed) {
      effect.revealed = true;
      effect.target.visible = true;
    }
    const revealProgress = clamp01((progress - 0.66) / 0.27);
    effect.target.scale.setScalar(0.7 + easeOutCubic(revealProgress) * 0.3);
  }

  private disposeEffect(id: number, effect: SpawnEffect) {
    this.scene.remove(effect.group);
    effect.group.clear();
    effect.bubbleMaterial.dispose();
    effect.smokeMaterial.dispose();
    effect.ringMaterial.dispose();
    effect.poolMaterial.dispose();
    this.effects.delete(id);
  }
}
