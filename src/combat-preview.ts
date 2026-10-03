import * as THREE from "three";
import "./combat-preview.css";
import { InputController } from "./input.js";
import { MeleeSystem, PUNCH_PLAYBACK_RATES } from "./melee.js";
import { MeleeWaveSystem } from "./melee-wave.js";
import { JAB_WAVE } from "./attack-shape.js";
import { MeleeWaveVisuals } from "./melee-wave-visual.js";
import { AttackPreview } from "./ui/attack-preview.js";
import { NavigationWorld } from "./navigation.js";
import { CharacterAssetStore, type CharacterVisual } from "./characters/animated-character.js";
import { CHARACTER_MODELS } from "./characters/catalog.js";
import { COMBAT_ICONS } from "./ui/combat-icons.js";

type Target = { id: number; group: THREE.Group; body: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  bar: THREE.Mesh; radius: number; hp: number; hits: number; flashUntil: number; baseX: number; baseZ: number };

class CombatPreviewScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-250, 250, 300, -300, 1, 2000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly navigation = new NavigationWorld(720, 720);
  private readonly assets = new CharacterAssetStore();
  private melee = this.createMelee();
  private readonly waves = new MeleeWaveSystem(this.navigation);
  private readonly waveVisuals = new MeleeWaveVisuals(this.scene);
  private readonly preview = new AttackPreview(this.scene, this.navigation);
  private readonly player = new THREE.Group();
  private readonly targets: Target[] = [];
  private readonly wallObstacle = this.navigation.addObstacle(360, 403, 72, 9, false);
  private readonly wall: THREE.Mesh;
  private readonly input: InputController;
  private visual?: CharacterVisual;
  private elapsed = 0;
  private scenario = "group";
  private ready = false;
  private previousFrame = performance.now();
  private pendingDamage = 0;
  private markerCount = 0;
  private movementScale = 1;
  private aim = { x: 0, z: -1 };
  private readonly ui = this.createUi();

  private createMelee() {
    return new MeleeSystem({ cycle: ["punchJab", "punchRightCross", "punchCombo"], charged: "punchJab" },
      PUNCH_PLAYBACK_RATES);
  }

  constructor() {
    document.querySelector("#app")!.prepend(this.renderer.domElement);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x132923);
    this.scene.add(new THREE.HemisphereLight(0xe5fff3, 0x3c5c4e, 2.5));
    const light = new THREE.DirectionalLight(0xffe6b9, 2.6);
    light.position.set(200, 650, 400); light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024); light.shadow.camera.left = -500; light.shadow.camera.right = 500;
    light.shadow.camera.top = 500; light.shadow.camera.bottom = -500; light.shadow.normalBias = 0.1;
    light.target.position.set(360, 0, 360); this.scene.add(light, light.target);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(720, 720), new THREE.MeshStandardMaterial({ color: 0x35584a, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(360, 0, 360); floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(720, 24, 0x78947c, 0x456657); grid.position.set(360, 0.2, 360); this.scene.add(grid);
    this.wall = new THREE.Mesh(new THREE.BoxGeometry(72, 55, 9), new THREE.MeshStandardMaterial({ color: 0xa1bbb0, roughness: 0.8 }));
    this.wall.position.set(360, 27.5, 403); this.wall.castShadow = true; this.wall.receiveShadow = true; this.scene.add(this.wall);
    this.player.position.set(360, 0, 480); this.scene.add(this.player);
    const foot = new THREE.Mesh(new THREE.RingGeometry(25, 27, 40), new THREE.MeshBasicMaterial({ color: 0x64e8bd, side: THREE.DoubleSide }));
    foot.rotation.x = -Math.PI / 2; foot.position.y = 1; this.player.add(foot);
    this.input = new InputController(this.renderer.domElement, this.camera, { base: this.ui.joystick, knob: this.ui.knob },
      { punch: this.ui.punch, fire: this.ui.fire, kick: this.ui.kick, previous: this.ui.previous, next: this.ui.next },
      { directionalMelee: true, allowedMeleeKinds: ["punch"] });
    for (let i = 0; i < 3; i++) this.targets.push(this.makeTarget(i + 1));
    this.ui.scenarios.forEach(button => this.bindSceneButton(button, () => { this.scenario = button.dataset.scene!; this.reset(); }));
    this.bindSceneButton(this.ui.reset, () => this.reset());
    this.bindSceneButton(this.ui.door, () => {
      this.navigation.setObstacleActive(this.wallObstacle, !this.wallObstacle.active);
      this.wall.visible = this.wallObstacle.active;
      this.ui.door.textContent = this.wallObstacle.active ? "移开挡板" : "放回挡板";
    });
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => { this.previousFrame = performance.now(); if (document.hidden) this.input.reset(); });
    // Match the game's multi-touch browser-gesture protection.
    for (const type of ["touchstart", "touchmove"]) document.querySelector("#app")!.addEventListener(type, event => {
      if ((event as TouchEvent).touches.length > 1) event.preventDefault();
    }, { passive: false });
    this.reset(); this.resize();
    void this.assets.createAsync(CHARACTER_MODELS.playerUnarmed).then(visual => {
      this.visual = visual; this.player.add(visual.root); this.ready = true; this.ui.punch.disabled = false;
      this.ui.message.textContent = "短按轮换：刺拳 → 右直拳 → 四连击";
    }).catch(error => { console.error(error); this.ui.message.textContent = "角色加载失败，请刷新重试"; });
    requestAnimationFrame(this.frame);
  }

  private bindSceneButton(button: HTMLButtonElement, activate: () => void) {
    // Multi-touch protection suppresses click while the other hand is aiming.
    let pointer: number | undefined;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || pointer !== undefined) return;
      event.preventDefault(); pointer = event.pointerId; button.setPointerCapture(pointer);
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = undefined;
      if (event.type !== "pointerup") return;
      const rect = button.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) activate();
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) button.addEventListener(type, release);
    button.addEventListener("click", event => { if (event.detail === 0) activate(); });
  }

  private makeTarget(id: number): Target {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 45, 16), new THREE.MeshStandardMaterial({ color: 0xe7a46b, roughness: 0.75 }));
    body.position.y = 23; body.castShadow = true; group.add(body);
    const ring = new THREE.Mesh(new THREE.RingGeometry(13, 15, 32), new THREE.MeshBasicMaterial({ color: 0xfad4a5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 1; group.add(ring);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(34, 4), new THREE.MeshBasicMaterial({ color: 0x64e8bd, side: THREE.DoubleSide }));
    bar.position.y = 56; group.add(bar);
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#f9f1d9"; ctx.font = "bold 44px Arial"; ctx.textAlign = "center"; ctx.fillText(String(id), 32, 46);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    label.position.y = 72; label.scale.set(23, 23, 1); group.add(label); this.scene.add(group);
    return { id, group, body, bar, radius: 14, hp: 60, hits: 0, flashUntil: 0, baseX: 0, baseZ: 0 };
  }

  private reset() {
    this.input?.reset(true);
    if (this.melee.active) this.visual?.stopOneShot(this.melee.active.move.action);
    this.melee.cancel(); this.melee = this.createMelee(); this.waves.clear(); this.waveVisuals.update([]);
    this.player.position.set(360, 0, 480); this.aim = { x: 0, z: -1 };
    this.elapsed = 0; this.pendingDamage = 0; this.markerCount = 0;
    const positions = this.scenario === "wall" ? [[336, 372], [384, 372], [300, 410]] : [[336, 394], [384, 394], [360, 330]];
    this.targets.forEach((target, i) => {
      [target.baseX, target.baseZ] = positions[i]; target.group.position.set(target.baseX, 0, target.baseZ);
      target.hp = 60; target.hits = 0; target.flashUntil = 0;
    });
    this.navigation.setObstacleActive(this.wallObstacle, this.scenario === "wall");
    this.wall.visible = this.wallObstacle.active; this.ui.door.hidden = this.scenario !== "wall";
    this.ui.door.textContent = "移开挡板";
    this.ui.scenarios.forEach(button => button.classList.toggle("selected", button.dataset.scene === this.scenario));
    this.ui.message.textContent = this.ready ? "短按轮换：刺拳 → 右直拳 → 四连击" : "正在加载角色…";
    this.ui.summary.textContent = this.scenario === "group" ? "①② 在初始射程内 · ③ 在射程外"
      : this.scenario === "wall" ? "①② 在挡板后 · ③ 可从侧面命中" : "① 横向移动 · 检查波面经过时的命中";
    this.refreshTargets(); this.updateCamera();
  }

  private frame = (now: number) => {
    const delta = Math.min(0.1, Math.max(0, (now - this.previousFrame) / 1000)); this.previousFrame = now;
    if (this.ready && !document.hidden) this.update(delta);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.frame);
  };

  private update(delta: number) {
    const input = this.input.getState(this.player.position.x, this.player.position.z);
    const frameStart = this.elapsed;
    const oldPosition = { x: this.player.position.x, z: this.player.position.z };
    const moving = Math.hypot(input.moveX, input.moveZ) > 0.08;
    for (const request of input.meleeRequests) {
      this.melee.request(request, frameStart);
      this.ui.message.textContent = request.charged ? "本场长按仍用刺拳（12 伤害）" : "短按轮换：刺拳 → 右直拳 → 四连击";
    }
    const released = this.melee.releaseRecovery(frameStart, moving);
    if (released) this.visual!.stopOneShot(released);
    this.visual!.setMovement(input.moveX, input.moveZ);
    this.melee.startQueued(frameStart, input.aimX, input.aimZ, move => this.visual!.playOneShot(move.action, { durationSeconds: move.duration }));
    const attack = this.melee.active;
    const previewAim = input.aimPreview;
    this.aim = attack ? { x: attack.aimX, z: attack.aimZ }
      : previewAim && !previewAim.canceled ? { x: previewAim.x, z: previewAim.z }
      : moving ? { x: input.moveX, z: input.moveZ } : this.aim;
    this.movementScale = input.moveSpeedMultiplier <= 1 ? input.moveSpeedMultiplier || 1
      : THREE.MathUtils.lerp(this.movementScale, input.moveSpeedMultiplier, 1 - Math.exp(-delta * 10));
    const position = this.navigation.moveCircle(oldPosition.x, oldPosition.z,
      input.moveX * 82 * this.movementScale * delta, input.moveZ * 82 * this.movementScale * delta, 30);
    this.player.position.set(position.x, 0, position.z); this.player.rotation.y = Math.atan2(this.aim.x, this.aim.z);
    const offAxis = moving && input.moveX * this.aim.x + input.moveZ * this.aim.z < 0.7;
    // Keep the character visible while validating independent movement and aim.
    // Existing forward locomotion is temporary until the directional clips arrive.
    const actionLabel = attack?.move.action === "punchRightCross" ? "右直拳"
      : attack?.move.action === "punchCombo" ? "四连击" : attack ? "刺拳" : "空手";
    this.ui.pose.textContent = `${actionLabel} · ${offAxis ? "侧／后移动作待补，暂用现有步态" : "Mixamo 动作"}`;
    this.visual!.setMovementSpeedScale(this.movementScale); this.visual!.update(delta);
    const targets = this.targets.map(target => {
      const previous = { x: target.group.position.x, z: target.group.position.z };
      if (this.scenario === "moving" && target.id === 1) target.group.position.x = 360 + Math.sin((frameStart + delta) * 2) * 80;
      return { id: target.id, previous, position: { x: target.group.position.x, z: target.group.position.z }, radius: target.radius, alive: target.hp > 0 };
    });
    this.elapsed += delta;
    for (const event of this.melee.advanceEvents(this.elapsed)) {
      const fraction = delta ? THREE.MathUtils.clamp((event.occurredAt - frameStart) / delta, 0, 1) : 0;
      const origin = { x: THREE.MathUtils.lerp(oldPosition.x, position.x, fraction), z: THREE.MathUtils.lerp(oldPosition.z, position.z, fraction) };
      if (this.waves.spawn(event, origin)) this.markerCount++;
    }
    for (const hit of this.waves.advance(frameStart, this.elapsed, targets)) {
      const target = this.targets.find(candidate => candidate.id === hit.targetId)!;
      if (target.hp <= 0) continue;
      const damage = Math.min(target.hp, hit.damage); target.hp -= damage; target.hits++; target.flashUntil = this.elapsed + 0.15;
      this.pendingDamage += damage;
    }
    this.waveVisuals.update(this.waves.waves);
    this.preview.update(position, previewAim ?? { x: input.aimX, z: input.aimZ }, JAB_WAVE, previewAim?.canceled);
    this.ui.punch.style.setProperty("--charge", `${input.punchCharge * 360}deg`);
    this.ui.punch.classList.toggle("charged", input.punchCharge >= 1);
    this.ui.gesture.textContent = previewAim?.canceled ? "松手取消" : input.punchCharge >= 1 ? "蓄力完成 · 本场仍为刺拳" : previewAim ? "松手出拳 · 回中心取消" : "拖动瞄准 · 松手出拳";
    this.ui.stats.textContent = `发波 ${this.markerCount} 次 · 总伤害 ${this.pendingDamage}`;
    this.targets.forEach(target => {
      target.body.material.color.setHex(target.hp <= 0 ? 0x566b60 : this.elapsed < target.flashUntil ? 0xfff2bf : 0xe7a46b);
      target.bar.scale.x = Math.max(0.001, target.hp / 60); target.bar.quaternion.copy(this.camera.quaternion);
    });
    this.refreshTargets(); this.updateCamera();
  }

  private updateCamera() {
    const { x, z } = this.player.position;
    this.camera.position.set(x + 340, 620, z + 420); this.camera.lookAt(x, 10, z - 40); this.camera.updateMatrixWorld(true);
  }
  private resize() {
    const aspect = innerWidth / innerHeight, height = innerWidth < 600 ? 620 : 560;
    this.camera.left = -height * aspect / 2; this.camera.right = height * aspect / 2;
    this.camera.top = height / 2; this.camera.bottom = -height / 2; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight, false);
  }
  private refreshTargets() {
    this.targets.forEach((target, i) => { this.ui.targetStats[i].textContent = `靶 ${target.id}　${target.hp}/60　命中 ${target.hits}`; });
  }

  private createUi() {
    const root = document.createElement("div"); root.className = "training-ui";
    root.innerHTML = `<header><div class="eyebrow">120 秒下班 · 战斗验证 01</div><h1>拳击训练场</h1>
      <p class="summary"></p><div class="scenario-row"><button data-scene="group">多目标</button><button data-scene="wall">墙后目标</button><button data-scene="moving">移动靶</button><button class="reset">重置</button></div>
      <button class="door" hidden>移开挡板</button></header>
      <aside><div class="stats"></div><div class="target-stat" data-target="1"></div><div class="target-stat" data-target="2"></div><div class="target-stat" data-target="3"></div></aside>
      <div class="training-hint"><strong class="message" role="status">正在加载角色…</strong><span>浅色扇形是范围，亮色波面经过时造成伤害</span><span class="pose"></span></div>
      <div class="joystick"><div class="joystick-knob"></div></div><div class="attack-control"><span class="gesture"></span><button class="punch" disabled aria-label="拖动瞄准，松手出拳"><span class="aim-knob">${COMBAT_ICONS.punch}</span><span>出拳</span></button></div>
      <footer><a href="/">返回游戏</a><span>WASD 移动 · Shift 跑步 · 鼠标瞄准 · J／左键出拳</span></footer>
      <div hidden><button class="fire"></button><button class="kick"></button><button class="previous"></button><button class="next"></button></div>`;
    document.querySelector("#app")!.append(root);
    const button = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
    const element = (selector: string) => root.querySelector<HTMLElement>(selector)!;
    return { root, punch: button(".punch"), fire: button(".fire"), kick: button(".kick"), previous: button(".previous"), next: button(".next"),
      reset: button(".reset"), door: button(".door"), scenarios: [...root.querySelectorAll<HTMLButtonElement>("[data-scene]")],
      joystick: element(".joystick"), knob: element(".joystick-knob"), summary: element(".summary"), pose: element(".pose"),
      message: element(".message"), gesture: element(".gesture"), stats: element(".stats"), targetStats: [...root.querySelectorAll<HTMLElement>(".target-stat")] };
  }
}

new CombatPreviewScene();
