import * as THREE from "three";
import type { WaveInstance } from "./melee-wave.js";

/** Reusable triangle buffers; visuals have no separate range or collision math. */
export class AttackBandVisual {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private capacity = 0;

  constructor(color: number, opacity: number, height = 5) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.position.y = height;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  update(triangles: readonly number[], opacity = this.mesh.material.opacity) {
    const count = triangles.length / 2;
    if (count > this.capacity) {
      // Release the old GPU attribute when a larger obstacle polygon needs more space.
      if (this.capacity) this.mesh.geometry.dispose();
      this.capacity = 2 ** Math.ceil(Math.log2(Math.max(64, count)));
      this.mesh.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    const position = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (position) {
      for (let i = 0; i < count; i++) position.setXYZ(i, triangles[i * 2], 0, triangles[i * 2 + 1]);
      position.needsUpdate = true;
    }
    this.mesh.geometry.setDrawRange(0, count);
    this.mesh.material.opacity = opacity;
    this.mesh.visible = count > 0 && opacity > 0;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.removeFromParent(); }
}

export class MeleeWaveVisuals {
  private readonly pool: AttackBandVisual[] = [];
  constructor(private readonly scene: THREE.Scene) {}

  update(waves: readonly WaveInstance[]) {
    while (this.pool.length < waves.length) {
      const visual = new AttackBandVisual(0xffd77a, 0.8, 8);
      this.pool.push(visual); this.scene.add(visual.mesh);
    }
    this.pool.forEach((visual, i) => {
      const wave = waves[i];
      if (!wave) { visual.mesh.visible = false; return; }
      const fade = Math.max(0, wave.age - wave.spec.range / wave.spec.speed) / wave.spec.fade;
      visual.update(wave.triangles, 0.85 * Math.max(0, 1 - fade));
    });
  }

  dispose() { this.pool.forEach(visual => visual.dispose()); this.pool.length = 0; }
}
