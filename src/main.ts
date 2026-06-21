import * as THREE from "three";
import "./styles.css";
import { traceCircleTargets, type AttackRequest } from "./combat";
import {
  AMMO_CONFIG,
  BULLET_VISUAL,
  COLORS,
  DEFAULT_WEAPON,
  ENEMY_CONFIG,
  GAME,
  MAP,
  PLAYER_CONFIG,
  getExpToNext,
  getSpawnStage,
  type EnemyKind,
} from "./config";
import { InputController, type InputState } from "./input";
import { NavigationWorld, type Obstacle } from "./navigation";
import { WeaponSystem } from "./weapon";

type Enemy = {
  id: number;
  kind: EnemyKind;
  group: THREE.Group;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  expReward: number;
  contactCooldown: number;
  nextHitAt: number;
  surroundAngle: number;
  surroundRadius: number;
};

type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
};

type ShotEffect = {
  object: THREE.Object3D;
  life: number;
  maxLife: number;
};

type BulletVisual = {
  group: THREE.Group;
  direction: THREE.Vector3;
  remainingDistance: number;
  impact?: { x: number; z: number; color: number };
};

type AmmoPickup = {
  group: THREE.Group;
  amount: number;
  radius: number;
  fixed: boolean;
  active: boolean;
  respawnAt: number;
  expiresAt: number;
  phase: number;
};

type GameState = "ready" | "playing" | "levelUpPaused" | "success" | "failed";

const GAME_STATE_TRANSITIONS: Record<GameState, readonly GameState[]> = {
  ready: ["playing"],
  playing: ["levelUpPaused", "success", "failed"],
  levelUpPaused: ["playing", "success", "failed"],
  success: [],
  failed: [],
};

class OfficeEscapeGame {
  private readonly app = document.querySelector<HTMLDivElement>("#app")!;
  private readonly scene = new THREE.Scene();
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly clock = new THREE.Clock();
  private readonly navigation = new NavigationWorld(MAP.width, MAP.depth);
  private readonly weapon = new WeaponSystem(DEFAULT_WEAPON);

  private player = new THREE.Group();
  private playerLight?: THREE.PointLight;
  private input?: InputController;
  private crosshair?: THREE.Group;
  private enemies: Enemy[] = [];
  private particles: Particle[] = [];
  private shotEffects: ShotEffect[] = [];
  private bulletVisuals: BulletVisual[] = [];
  private ammoPickups: AmmoPickup[] = [];
  private accessCard?: THREE.Group;
  private elevatorZone?: THREE.Mesh;
  private elevatorDoors: THREE.Mesh[] = [];
  private elevatorDoorObstacle?: Obstacle;
  private nextEnemyId = 1;
  private spawnTimer = 0;
  private elapsed = 0;
  private gameState: GameState = "ready";
  private accessCardSpawned = false;
  private hasAccessCard = false;
  private elevatorSoonShown = false;
  private elevatorOpen = false;
  private bossSpawned = false;
  private evacuationProgress = 0;
  private evacuationComplete = false;
  private nextElevatorHintAt = 0;
  private slowUntil = 0;
  private lastHintTimer = 0;
  private nextWeaponHintAt = 0;
  private nextAmmoHintAt = 0;
  private cameraKick = 0;
  private playerInvincibleUntil = 0;

  private readonly playerState = {
    x: 270,
    z: 840,
    hp: PLAYER_CONFIG.initialHp,
    maxHp: PLAYER_CONFIG.maxHp,
    speed: PLAYER_CONFIG.baseSpeed,
    exp: PLAYER_CONFIG.initialExp,
    expToNext: getExpToNext(PLAYER_CONFIG.initialLevel),
    level: PLAYER_CONFIG.initialLevel,
  };

  private readonly hud = this.createHud();

  constructor() {
    this.app.innerHTML = "";
    this.scene.background = new THREE.Color(0x111816);
    this.scene.fog = new THREE.Fog(0x111816, 1200, 2900);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.app.append(this.renderer.domElement, this.hud.root);

    this.setupCamera();
    this.createLights();
    this.createMap();
    this.createPlayer();
    this.createFixedAmmoSupplies();
    this.createCrosshair();
    this.input = new InputController(this.renderer.domElement, this.camera, {
      base: this.hud.joystickBase,
      knob: this.hud.joystickKnob,
    }, this.hud.fireButton, this.hud.reloadButton);
    this.bindEvents();
    this.showHint("距离下班还有 120 秒");
    this.resize();
    this.transitionTo("playing");
    this.animate();
  }

  private setupCamera() {
    this.camera.position.set(890, 930, 1780);
    this.camera.lookAt(270, 0, 840);
  }

  private createLights() {
    const ambient = new THREE.HemisphereLight(0xf6edd8, 0x1c2a25, 0.75);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff2d0, 1.25);
    sun.position.set(-450, 900, 400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -950;
    sun.shadow.camera.right = 950;
    sun.shadow.camera.top = 1200;
    sun.shadow.camera.bottom = -1200;
    this.scene.add(sun);

    this.addAreaLight(270, 280, 0xf8d98d, 0.7);
    this.addAreaLight(810, 840, 0xb9f5bf, 0.55);
    this.addAreaLight(540, 1440, 0x9fd0ff, 0.75);
  }

  private addAreaLight(x: number, z: number, color: number, intensity: number) {
    const light = new THREE.PointLight(color, intensity, 520, 1.4);
    light.position.set(x, 120, z);
    this.scene.add(light);
  }

  private createMap() {
    const ground = this.box(MAP.width, 8, MAP.depth, COLORS.floor, 0.92);
    ground.position.set(MAP.width / 2, -4, MAP.depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    const rooms = [
      { x: 270, z: 280, w: 520, d: 540, color: 0x33433d },
      { x: 810, z: 280, w: 520, d: 540, color: 0x403936 },
      { x: 270, z: 840, w: 520, d: 540, color: 0x293f47 },
      { x: 810, z: 840, w: 520, d: 540, color: 0x354635 },
      { x: 540, z: 1420, w: 1040, d: 560, color: 0x313a44 },
    ];

    for (const room of rooms) {
      const floor = this.box(room.w, 6, room.d, room.color, 0.9);
      floor.position.set(room.x, 1, room.z);
      floor.receiveShadow = true;
      this.scene.add(floor);
    }

    this.addWall(MAP.width / 2, 0, MAP.width, 22);
    this.addWall(MAP.width / 2, MAP.depth, MAP.width, 22);
    this.addWall(0, MAP.depth / 2, 22, MAP.depth);
    this.addWall(MAP.width, MAP.depth / 2, 22, MAP.depth);
    // Internal walls are segmented to leave visible, playable doorways between rooms.
    this.addWall(115, 560, 190, 24);
    this.addWall(535, 560, 370, 24);
    this.addWall(970, 560, 180, 24);
    this.addWall(235, 1120, 430, 24);
    this.addWall(845, 1120, 430, 24);
    this.addWall(540, 115, 24, 190);
    this.addWall(540, 449, 24, 198);
    this.addWall(540, 681, 24, 218);
    this.addWall(540, 1019, 24, 178);

    this.addDesk(250, 770, 270, 70, 42, 0x8a623a);
    this.addDesk(260, 925, 240, 70, 42, 0x8a623a);
    this.addDesk(270, 280, 280, 118, 46, 0x78634c);
    this.addDesk(820, 265, 260, 118, 54, 0x734d45);
    this.addCoffeeMachine(825, 805);
    this.addElevatorDoor();
    this.addChairs();
    this.addFloorNoise();
  }

  private addWall(x: number, z: number, width: number, depth: number) {
    const wall = this.box(width, 90, depth, COLORS.wall, 1);
    wall.position.set(x, 45, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    this.scene.add(wall);
    this.navigation.addObstacle(x, z, width, depth);
  }

  private addDesk(x: number, z: number, width: number, depth: number, height: number, color: number) {
    const top = this.box(width, height, depth, color, 1);
    top.position.set(x, height / 2, z);
    top.castShadow = true;
    top.receiveShadow = true;
    this.scene.add(top);
    this.navigation.addObstacle(x, z, width, depth);

    const highlight = this.box(width * 0.44, 3, depth * 0.12, 0xffffff, 0.18);
    highlight.position.set(x - width * 0.18, height + 2, z - depth * 0.22);
    this.scene.add(highlight);
  }

  private addCoffeeMachine(x: number, z: number) {
    this.addDesk(x, z, 94, 94, 72, 0x4f7658);
    const screen = this.box(48, 4, 28, 0x111816, 1);
    screen.position.set(x, 74, z - 48);
    this.scene.add(screen);
  }

  private addElevatorDoor() {
    this.addWall(398, 1295, 36, 28);
    this.addWall(682, 1295, 36, 28);
    this.addWall(380, 1425, 24, 260);
    this.addWall(700, 1425, 24, 260);
    this.addWall(540, 1555, 344, 24);

    const lintel = this.box(320, 24, 28, COLORS.elevatorClosed, 1);
    lintel.position.set(540, 80, 1295);
    this.scene.add(lintel);

    const leftDoor = this.box(124, 68, 18, COLORS.elevatorClosed, 1);
    const rightDoor = this.box(124, 68, 18, COLORS.elevatorClosed, 1);
    leftDoor.position.set(478, 34, 1295);
    rightDoor.position.set(602, 34, 1295);
    this.elevatorDoors = [leftDoor, rightDoor];
    this.scene.add(leftDoor, rightDoor);
    this.elevatorDoorObstacle = this.navigation.addObstacle(540, 1295, 248, 22);

    this.elevatorZone = this.box(300, 3, 180, COLORS.elevatorClosed, 0.36);
    this.elevatorZone.position.set(540, 3, 1440);
    this.elevatorZone.receiveShadow = true;
    this.scene.add(this.elevatorZone);
  }

  private addChairs() {
    const chairs = [
      [125, 720],
      [210, 720],
      [320, 845],
      [160, 995],
      [385, 890],
      [210, 215],
      [345, 335],
      [735, 195],
      [925, 335],
    ];

    for (const [x, z] of chairs) {
      const chair = this.box(34, 32, 34, 0x38424b, 1);
      chair.position.set(x, 16, z);
      chair.castShadow = true;
      chair.receiveShadow = true;
      this.scene.add(chair);
      this.navigation.addObstacle(x, z, 34, 34);
    }
  }

  private addFloorNoise() {
    const material = new THREE.MeshStandardMaterial({ color: 0x9ba69d, transparent: true, opacity: 0.22, roughness: 1 });
    const geometry = new THREE.BoxGeometry(6, 1, 3);
    for (let i = 0; i < 180; i += 1) {
      const mark = new THREE.Mesh(geometry, material);
      mark.position.set(((i * 149) % (MAP.width - 90)) + 45, 5, ((i * 227) % (MAP.depth - 90)) + 45);
      mark.rotation.y = (i % 8) * 0.31;
      this.scene.add(mark);
    }
  }

  private createPlayer() {
    this.player = new THREE.Group();
    const body = this.mesh(new THREE.CylinderGeometry(18, 22, 42, 10), COLORS.player);
    body.position.y = 30;
    const head = this.mesh(new THREE.SphereGeometry(15, 12, 10), 0xf2c9a8);
    head.position.y = 62;
    const bag = this.mesh(new THREE.BoxGeometry(28, 18, 16), COLORS.playerAccent);
    bag.position.set(-2, 26, -16);
    const weaponBody = this.mesh(new THREE.BoxGeometry(11, 11, 42), COLORS.weapon);
    weaponBody.position.set(13, 39, 25);
    const weaponStock = this.mesh(new THREE.BoxGeometry(9, 16, 18), 0x59636b);
    weaponStock.position.set(13, 36, 2);
    this.player.add(body, head, bag, weaponBody, weaponStock);
    this.player.position.set(this.playerState.x, 0, this.playerState.z);
    this.scene.add(this.player);

    this.playerLight = new THREE.PointLight(0xaee8ff, 0.45, 260, 1.9);
    this.playerLight.position.set(this.playerState.x, 72, this.playerState.z);
    this.scene.add(this.playerLight);
  }

  private createCrosshair() {
    this.crosshair = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xffe082, depthTest: false, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(11, 14, 24), material);
    ring.rotation.x = -Math.PI / 2;
    const horizontal = new THREE.Mesh(new THREE.BoxGeometry(38, 1, 3), material);
    horizontal.position.y = 1;
    const vertical = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 38), material);
    vertical.position.y = 1;
    this.crosshair.add(ring, horizontal, vertical);
    this.crosshair.position.set(this.playerState.x, 5, this.playerState.z - 360);
    this.crosshair.renderOrder = 20;
    this.scene.add(this.crosshair);
  }

  private createFixedAmmoSupplies() {
    for (const spawn of AMMO_CONFIG.fixedSpawns) {
      this.createAmmoPickup(spawn.x, spawn.z, AMMO_CONFIG.fixedAmount, true);
    }
  }

  private createAmmoPickup(x: number, z: number, amount: number, fixed: boolean) {
    const group = new THREE.Group();
    const color = fixed ? COLORS.ammoBox : COLORS.ammoPack;
    const base = this.mesh(new THREE.BoxGeometry(fixed ? 46 : 30, fixed ? 24 : 12, fixed ? 34 : 22), color);
    base.position.y = fixed ? 14 : 8;
    const lid = this.mesh(new THREE.BoxGeometry(fixed ? 50 : 32, 5, fixed ? 38 : 24), 0xdfffea);
    lid.position.y = fixed ? 28 : 15;
    group.add(base, lid);

    for (let index = -1; index <= 1; index += 1) {
      const round = this.mesh(new THREE.CylinderGeometry(2.5, 2.5, 14, 6), COLORS.muzzle);
      round.position.set(index * 9, fixed ? 38 : 24, 0);
      group.add(round);
    }

    if (fixed) {
      const glow = new THREE.PointLight(COLORS.ammoBox, 0.65, 180, 1.7);
      glow.position.y = 42;
      group.add(glow);
    }

    group.position.set(x, 0, z);
    this.scene.add(group);
    this.ammoPickups.push({
      group,
      amount,
      radius: fixed ? 28 : 20,
      fixed,
      active: true,
      respawnAt: 0,
      expiresAt: fixed ? Number.POSITIVE_INFINITY : this.elapsed + AMMO_CONFIG.droppedLifetime,
      phase: Math.random() * Math.PI * 2,
    });
  }

  private bindEvents() {
    window.addEventListener("resize", () => this.resize());
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.033);
    this.update(delta);
    this.renderer.render(this.scene, this.camera);
  };

  private update(delta: number) {
    if (this.gameState === "success" || this.gameState === "failed") {
      this.updateBulletVisuals(delta);
      this.updateParticles(delta);
      this.updateShotEffects(delta);
      return;
    }
    if (this.gameState !== "playing") {
      this.refreshHud();
      return;
    }

    this.elapsed += delta;
    this.spawnTimer -= delta;
    this.lastHintTimer -= delta;

    const input = this.input!.getState(this.playerState.x, this.playerState.z);
    this.updateTimeline();
    this.updatePlayer(delta, input);
    this.updateBulletVisuals(delta);
    this.updateEnemies(delta);
    this.updateWeapon(input);
    this.updateAmmoPickups(delta);
    this.updateAccessCard();
    this.updateEvacuation(delta);
    this.updateParticles(delta);
    this.updateShotEffects(delta);
    this.trySpawnEnemies();
    this.updateCamera(delta);
    this.updateObjectiveArrow();
    this.refreshHud();

    this.resolveGameResult();
  }

  private updatePlayer(delta: number, input: InputState) {
    const slowMultiplier = this.elapsed < this.slowUntil ? 0.7 : 1;
    const speed = this.playerState.speed * slowMultiplier;
    const nextPosition = this.navigation.moveCircle(
      this.playerState.x,
      this.playerState.z,
      input.moveX * speed * delta,
      input.moveZ * speed * delta,
      PLAYER_CONFIG.radius,
    );
    this.playerState.x = nextPosition.x;
    this.playerState.z = nextPosition.z;
    this.player.position.set(this.playerState.x, 0, this.playerState.z);
    this.player.rotation.y = Math.atan2(input.aimX, input.aimZ);
    this.playerLight?.position.set(this.playerState.x, 72, this.playerState.z);
    this.crosshair?.position.set(input.aimPointX, 5, input.aimPointZ);
  }

  private updateTimeline() {
    if (!this.accessCardSpawned && this.elapsed >= 35) {
      this.accessCardSpawned = true;
      this.spawnAccessCard();
      this.showHint("门禁卡出现了！");
    }
    if (!this.elevatorSoonShown && this.elapsed >= 70) {
      this.elevatorSoonShown = true;
      this.showHint("电梯即将开放");
    }
    if (!this.elevatorOpen && this.elapsed >= 80) {
      this.elevatorOpen = true;
      this.navigation.setObstacleActive(this.elevatorDoorObstacle, false);
      this.elevatorDoors[0].position.x = 416;
      this.elevatorDoors[1].position.x = 664;
      for (const door of this.elevatorDoors) this.setMeshColor(door, COLORS.elevatorOpen);
      this.setMeshColor(this.elevatorZone, COLORS.elevatorOpen, 0.5);
      this.showHint("电梯开放！快去下班！");
    }
    if (!this.bossSpawned && this.elapsed >= 90) {
      this.bossSpawned = true;
      this.spawnBoss();
      this.showHint("老板来了！快跑！");
    }
  }

  private trySpawnEnemies() {
    if (this.enemies.length >= GAME.maxEnemies || this.spawnTimer > 0) return;
    const stage = getSpawnStage(this.elapsed);
    const reservedBossSlots = this.bossSpawned ? 0 : 1;
    const availableSlots = Math.max(0, GAME.maxEnemies - this.enemies.length - reservedBossSlots);
    const spawnCount = Math.min(stage.count, availableSlots);
    for (let i = 0; i < spawnCount; i += 1) this.spawnEnemy(this.pickEnemyKind(stage.weights));
    this.spawnTimer = stage.interval;
  }

  private pickEnemyKind(weights: Record<Exclude<EnemyKind, "boss">, number>): Exclude<EnemyKind, "boss"> {
    const total = weights.bug + weights.changeRequest + weights.meeting;
    const roll = Math.random() * total;
    if (roll < weights.bug) return "bug";
    if (roll < weights.bug + weights.changeRequest) return "changeRequest";
    return "meeting";
  }

  private spawnEnemy(kind: Exclude<EnemyKind, "boss">) {
    const margin = 42;
    const radius = ENEMY_CONFIG[kind].radius;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const side = Math.floor(Math.random() * 4);
      let x = margin;
      let z = margin;
      if (side === 0) {
        x = THREE.MathUtils.randFloat(margin, MAP.width - margin);
      } else if (side === 1) {
        x = MAP.width - margin;
        z = THREE.MathUtils.randFloat(margin, MAP.depth - margin);
      } else if (side === 2) {
        x = THREE.MathUtils.randFloat(margin, MAP.width - margin);
        z = MAP.depth - margin;
      } else {
        z = THREE.MathUtils.randFloat(margin, MAP.depth - margin);
      }
      if (this.distanceToPlayer(x, z) < 300 || !this.navigation.canOccupy(x, z, radius)) continue;
      this.createEnemy(kind, x, z);
      return;
    }
  }

  private spawnBoss() {
    this.createEnemy("boss", 820, 430);
  }

  private createEnemy(kind: EnemyKind, x: number, z: number) {
    const config = ENEMY_CONFIG[kind];
    const group = new THREE.Group();
    const body = this.mesh(new THREE.CylinderGeometry(config.radius, config.radius * 1.08, config.height, kind === "boss" ? 12 : 8), config.color);
    body.position.y = config.height / 2;
    group.add(body);
    if (kind === "boss") {
      const head = this.mesh(new THREE.SphereGeometry(18, 12, 10), 0xf2c9a8);
      head.position.y = config.height + 16;
      group.add(head);
    } else if (kind === "changeRequest") {
      group.add(this.mesh(new THREE.BoxGeometry(22, 18, 12), 0xdbeafe));
      group.children[1].position.y = config.height + 6;
    } else if (kind === "meeting") {
      const halo = this.mesh(new THREE.TorusGeometry(config.radius * 0.9, 3, 6, 16), 0xe9d5ff);
      halo.position.y = config.height + 5;
      halo.rotation.x = Math.PI / 2;
      group.add(halo);
    }
    group.position.set(x, 0, z);
    this.scene.add(group);

    this.enemies.push({
      id: this.nextEnemyId,
      kind,
      group,
      radius: config.radius,
      hp: config.hp,
      maxHp: config.hp,
      speed: config.speed,
      damage: config.damage,
      expReward: config.expReward,
      contactCooldown: config.contactCooldown,
      nextHitAt: 0,
      surroundAngle: Math.random() * Math.PI * 2,
      surroundRadius: kind === "boss" ? 0 : THREE.MathUtils.randFloat(34, 118),
    });
    this.nextEnemyId += 1;
  }

  private updateEnemies(delta: number) {
    for (const enemy of this.enemies) {
      const playerDistance = this.distanceToPlayer(enemy.group.position.x, enemy.group.position.z);
      const orbitAngle = enemy.surroundAngle + this.elapsed * 0.18;
      const targetX = playerDistance < 210 ? this.playerState.x + Math.cos(orbitAngle) * enemy.surroundRadius : this.playerState.x;
      const targetZ = playerDistance < 210 ? this.playerState.z + Math.sin(orbitAngle) * enemy.surroundRadius : this.playerState.z;
      const direction = this.navigation.getDirection(enemy.group.position.x, enemy.group.position.z, targetX, targetZ, enemy.radius);
      let moveX = direction.x;
      let moveZ = direction.z;

      if (enemy.kind !== "boss") {
        const separation = this.getEnemySeparation(enemy);
        moveX += separation.x * 1.6;
        moveZ += separation.z * 1.6;
      }

      const length = Math.max(Math.hypot(moveX, moveZ), 0.001);
      const nextPosition = this.navigation.moveCircle(
        enemy.group.position.x,
        enemy.group.position.z,
        (moveX / length) * enemy.speed * delta,
        (moveZ / length) * enemy.speed * delta,
        enemy.radius,
      );
      enemy.group.position.x = nextPosition.x;
      enemy.group.position.z = nextPosition.z;
      enemy.group.rotation.y = Math.atan2(moveX, moveZ);

      const contactDistance = this.distanceToPlayer(enemy.group.position.x, enemy.group.position.z);
      if (
        contactDistance < PLAYER_CONFIG.radius + enemy.radius
        && this.elapsed >= enemy.nextHitAt
        && this.elapsed >= this.playerInvincibleUntil
      ) {
        enemy.nextHitAt = this.elapsed + enemy.contactCooldown;
        this.playerInvincibleUntil = this.elapsed + PLAYER_CONFIG.invincibleAfterHit;
        this.playerState.hp = Math.max(0, this.playerState.hp - enemy.damage);
        this.emitParticles(this.playerState.x, 26, this.playerState.z, 0xff6b6b, 5, 48);
        this.showFloating(`-${enemy.damage}`, "#ffb4a8");
        if (enemy.kind === "meeting") {
          this.slowUntil = Math.max(this.slowUntil, this.elapsed + 1);
          this.showFloating("减速", "#ddd6fe");
        }
      }
    }
  }

  private getEnemySeparation(enemy: Enemy) {
    let x = 0;
    let z = 0;
    for (const other of this.enemies) {
      if (other.id === enemy.id) continue;
      const dx = enemy.group.position.x - other.group.position.x;
      const dz = enemy.group.position.z - other.group.position.z;
      const distance = Math.hypot(dx, dz);
      const minDistance = enemy.radius + other.radius + 30;
      if (distance > 0.001 && distance < minDistance) {
        const strength = (minDistance - distance) / minDistance;
        x += (dx / distance) * strength;
        z += (dz / distance) * strength;
      }
    }
    return { x, z };
  }

  private updateWeapon(input: InputState) {
    const update = this.weapon.update(this.elapsed, input.fireHeld, input.reloadPressed);
    if (update.fired) this.fireWeapon(input.aimX, input.aimZ);
    if (update.reloadStarted && this.elapsed >= this.nextWeaponHintAt) {
      this.nextWeaponHintAt = this.elapsed + 0.8;
      this.showHint("换弹中");
    }
    if (update.dryFire && this.elapsed >= this.nextWeaponHintAt) {
      this.nextWeaponHintAt = this.elapsed + 1.2;
      this.showHint("没子弹了，去找弹药箱");
    }
    this.removeDeadEnemies();
  }

  private updateAmmoPickups(delta: number) {
    for (const pickup of this.ammoPickups) {
      if (!pickup.active) {
        if (pickup.fixed && this.elapsed >= pickup.respawnAt) {
          pickup.active = true;
          pickup.group.visible = true;
        }
        continue;
      }

      if (!pickup.fixed && this.elapsed >= pickup.expiresAt) {
        pickup.active = false;
        this.removeAmmoPickup(pickup);
        continue;
      }

      pickup.group.rotation.y += delta * (pickup.fixed ? 0.7 : 1.4);
      pickup.group.position.y = Math.sin(this.elapsed * 2.5 + pickup.phase) * 3;
      if (this.distanceToPlayer(pickup.group.position.x, pickup.group.position.z) > PLAYER_CONFIG.radius + pickup.radius) continue;

      const addedAmmo = this.weapon.addReserveAmmo(pickup.amount);
      if (addedAmmo <= 0) {
        if (this.elapsed >= this.nextAmmoHintAt) {
          this.nextAmmoHintAt = this.elapsed + 2;
          this.showHint("后备弹药已满");
        }
        continue;
      }

      this.emitParticles(pickup.group.position.x, 24, pickup.group.position.z, COLORS.ammoPack, 8, 52);
      this.showFloating(`弹药 +${addedAmmo}`, "#b9f9d4");
      if (pickup.fixed) {
        pickup.active = false;
        pickup.group.visible = false;
        pickup.respawnAt = this.elapsed + AMMO_CONFIG.fixedRespawnTime;
      } else {
        pickup.active = false;
        this.removeAmmoPickup(pickup);
      }
    }

    this.ammoPickups = this.ammoPickups.filter((pickup) => pickup.fixed || pickup.active);
  }

  private maybeDropAmmo(enemy: Enemy) {
    if (Math.random() >= AMMO_CONFIG.dropChance[enemy.kind]) return;
    const droppedCount = this.ammoPickups.filter((pickup) => !pickup.fixed && pickup.active).length;
    if (droppedCount >= AMMO_CONFIG.maxDroppedPacks) return;
    this.createAmmoPickup(enemy.group.position.x, enemy.group.position.z, AMMO_CONFIG.droppedAmount, false);
  }

  private removeAmmoPickup(pickup: AmmoPickup) {
    this.disposeObject(pickup.group);
  }

  private disposeObject(root: THREE.Object3D) {
    this.scene.remove(root);
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  }

  private fireWeapon(directionX: number, directionZ: number) {
    const originX = this.playerState.x + directionX * 34;
    const originZ = this.playerState.z + directionZ * 34;
    this.resolveAttack({
      sourceId: "player",
      weaponId: DEFAULT_WEAPON.id,
      mode: DEFAULT_WEAPON.attackMode,
      originX,
      originZ,
      directionX,
      directionZ,
      range: DEFAULT_WEAPON.range,
      damage: DEFAULT_WEAPON.damage,
      maxHits: 1,
    });
  }

  private resolveAttack(request: AttackRequest) {
    const obstacleDistance = this.navigation.raycastObstacleDistance(
      request.originX,
      request.originZ,
      request.directionX,
      request.directionZ,
      request.range,
    );
    const trace = traceCircleTargets(
      request.originX,
      request.originZ,
      request.directionX,
      request.directionZ,
      request.range,
      obstacleDistance,
      this.enemies.filter((enemy) => enemy.hp > 0).map((enemy) => ({
        target: enemy,
        x: enemy.group.position.x,
        z: enemy.group.position.z,
        radius: enemy.radius,
      })),
      request.maxHits,
    );

    for (const hit of trace.hits) {
      hit.target.hp -= request.damage;
      hit.target.group.scale.setScalar(1.1);
      window.setTimeout(() => {
        if (hit.target.hp > 0) hit.target.group.scale.setScalar(1);
      }, 65);
    }

    const endX = request.originX + request.directionX * trace.endDistance;
    const endZ = request.originZ + request.directionZ * trace.endDistance;
    const lastHit = trace.hits.at(-1);
    const impact = lastHit
      ? { x: lastHit.x, z: lastHit.z, color: ENEMY_CONFIG[lastHit.target.kind].color }
      : obstacleDistance < request.range
        ? { x: endX, z: endZ, color: 0xd8d4c8 }
        : undefined;
    this.createBulletVisual(request.originX, request.originZ, endX, endZ, impact);
    this.createMuzzleFlash(request.originX, request.originZ);
    this.cameraKick = Math.min(7, this.cameraKick + 2.2);
  }

  private createBulletVisual(
    originX: number,
    originZ: number,
    endX: number,
    endZ: number,
    impact?: BulletVisual["impact"],
  ) {
    if (this.bulletVisuals.length >= BULLET_VISUAL.maxActive) {
      const oldest = this.bulletVisuals.shift();
      if (oldest) this.disposeObject(oldest.group);
    }

    const direction = new THREE.Vector3(endX - originX, 0, endZ - originZ);
    const distance = direction.length();
    if (distance < 0.001) {
      if (impact) this.emitParticles(impact.x, 32, impact.z, impact.color, 4, 34);
      return;
    }
    direction.normalize();
    const length = Math.max(8, Math.min(BULLET_VISUAL.length, distance * 0.72));
    const group = new THREE.Group();
    const glow = new THREE.Mesh(
      new THREE.CapsuleGeometry(BULLET_VISUAL.radius, length, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xffc857, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    const core = new THREE.Mesh(
      new THREE.CapsuleGeometry(BULLET_VISUAL.radius * 0.55, length * 0.62, 4, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffe7a3,
        emissive: 0xffa000,
        emissiveIntensity: 1.8,
        metalness: 0.5,
        roughness: 0.25,
      }),
    );
    group.add(glow, core);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    group.position.set(
      originX + direction.x * (length / 2),
      39,
      originZ + direction.z * (length / 2),
    );
    this.scene.add(group);
    this.bulletVisuals.push({
      group,
      direction,
      remainingDistance: Math.max(0, distance - length),
      impact,
    });
  }

  private updateBulletVisuals(delta: number) {
    const completed: BulletVisual[] = [];
    for (const bullet of this.bulletVisuals) {
      const distance = Math.min(bullet.remainingDistance, BULLET_VISUAL.speed * delta);
      bullet.group.position.addScaledVector(bullet.direction, distance);
      bullet.remainingDistance -= distance;
      if (bullet.remainingDistance > 0.001) continue;
      if (bullet.impact) this.emitParticles(bullet.impact.x, 32, bullet.impact.z, bullet.impact.color, 4, 34);
      completed.push(bullet);
    }
    for (const bullet of completed) this.disposeObject(bullet.group);
    if (completed.length > 0) this.bulletVisuals = this.bulletVisuals.filter((bullet) => !completed.includes(bullet));
  }

  private createMuzzleFlash(x: number, z: number) {
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(7, 6, 4),
      new THREE.MeshBasicMaterial({ color: COLORS.muzzle, transparent: true, opacity: 1 }),
    );
    flash.position.set(x, 39, z);
    this.scene.add(flash);
    this.shotEffects.push({ object: flash, life: 0.05, maxLife: 0.05 });
  }

  private updateShotEffects(delta: number) {
    for (const effect of this.shotEffects) {
      effect.life -= delta;
      const opacity = Math.max(0, effect.life / effect.maxLife);
      const object = effect.object as THREE.Mesh | THREE.Line;
      const material = object.material as THREE.Material & { opacity: number };
      material.opacity = opacity;
    }
    const expired = this.shotEffects.filter((effect) => effect.life <= 0);
    for (const effect of expired) {
      this.disposeObject(effect.object);
    }
    this.shotEffects = this.shotEffects.filter((effect) => effect.life > 0);
  }

  private removeDeadEnemies() {
    const dead = this.enemies.filter((enemy) => enemy.hp <= 0);
    for (const enemy of dead) {
      this.emitParticles(enemy.group.position.x, 34, enemy.group.position.z, ENEMY_CONFIG[enemy.kind].color, enemy.kind === "boss" ? 24 : 10, enemy.kind === "boss" ? 110 : 64);
      this.maybeDropAmmo(enemy);
      if (enemy.expReward > 0) {
        this.gainExp(enemy.expReward);
        this.showFloating(`+${enemy.expReward}`, "#9be7ff");
      }
      this.scene.remove(enemy.group);
    }
    if (dead.length > 0) this.enemies = this.enemies.filter((enemy) => enemy.hp > 0);
  }

  private gainExp(amount: number) {
    this.playerState.exp += amount;
    while (this.playerState.exp >= this.playerState.expToNext) {
      this.playerState.exp -= this.playerState.expToNext;
      this.playerState.level += 1;
      this.playerState.expToNext = getExpToNext(this.playerState.level);
      this.showHint(`升级了！Lv ${this.playerState.level}`);
    }
  }

  private spawnAccessCard() {
    this.accessCard = new THREE.Group();
    const card = this.mesh(new THREE.BoxGeometry(46, 8, 30), COLORS.accessCard);
    card.position.y = 18;
    const glow = new THREE.PointLight(COLORS.accessCard, 0.85, 210, 1.6);
    glow.position.y = 44;
    this.accessCard.add(card, glow);
    this.accessCard.position.set(270, 0, 400);
    this.scene.add(this.accessCard);
  }

  private updateAccessCard() {
    if (!this.accessCard || this.hasAccessCard) return;
    this.accessCard.rotation.y += 0.04;
    this.accessCard.position.y = Math.sin(this.elapsed * 3) * 5;
    if (this.distanceToPlayer(this.accessCard.position.x, this.accessCard.position.z) <= PLAYER_CONFIG.radius + 30) {
      this.hasAccessCard = true;
      this.scene.remove(this.accessCard);
      this.accessCard = undefined;
      this.showHint(this.elevatorOpen ? "门禁卡已获得，快去电梯" : "门禁卡已获得，等待电梯开放");
      this.showFloating("门禁卡", "#fff5c2");
    }
  }

  private updateEvacuation(delta: number) {
    const inElevator = this.isPlayerInElevator();
    if (!inElevator) {
      this.evacuationProgress = 0;
      this.hud.evac.classList.remove("is-visible");
      return;
    }
    if (!this.hasAccessCard) {
      this.evacuationProgress = 0;
      this.hud.evac.classList.remove("is-visible");
      this.throttledElevatorHint("还没有门禁卡");
      return;
    }
    if (!this.elevatorOpen) {
      this.evacuationProgress = 0;
      this.hud.evac.classList.remove("is-visible");
      this.throttledElevatorHint("电梯还没开放");
      return;
    }

    this.evacuationProgress += delta;
    this.hud.evac.classList.add("is-visible");
    this.hud.evacBar.style.width = `${Math.min(100, (this.evacuationProgress / GAME.elevatorHoldTime) * 100)}%`;
    if (this.evacuationProgress >= GAME.elevatorHoldTime) this.evacuationComplete = true;
  }

  private resolveGameResult() {
    if (this.gameState !== "playing") return;
    if (this.playerState.hp <= 0) {
      this.finishGame("failed", "你被工作压垮了", "#ef4444");
    } else if (this.evacuationComplete) {
      this.finishGame("success", "下班成功！今日无事发生", "#22c55e");
    } else if (this.elapsed >= GAME.duration) {
      this.finishGame("failed", "你被迫加班了", "#f97316");
    }
  }

  private throttledElevatorHint(message: string) {
    if (this.elapsed < this.nextElevatorHintAt) return;
    this.nextElevatorHintAt = this.elapsed + 2.5;
    this.showHint(message);
  }

  private isPlayerInElevator() {
    return this.playerState.x >= 390 && this.playerState.x <= 690 && this.playerState.z >= 1350 && this.playerState.z <= 1530;
  }

  private updateCamera(delta: number) {
    const target = new THREE.Vector3(this.playerState.x + 620, 930, this.playerState.z + 940);
    if (this.cameraKick > 0.01) {
      target.x += THREE.MathUtils.randFloatSpread(this.cameraKick);
      target.z += THREE.MathUtils.randFloatSpread(this.cameraKick);
      this.cameraKick = Math.max(0, this.cameraKick - delta * 28);
    }
    this.camera.position.lerp(target, Math.min(1, delta * 5.8));
    this.camera.lookAt(this.playerState.x, 0, this.playerState.z);
  }

  private updateObjectiveArrow() {
    const target = this.getObjectiveTarget();
    if (!target) {
      this.hud.arrow.classList.remove("is-visible");
      this.hud.arrowLabel.classList.remove("is-visible");
      return;
    }

    const projected = new THREE.Vector3(target.x, 32, target.z).project(this.camera);
    const screenX = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-projected.y * 0.5 + 0.5) * window.innerHeight;
    const margin = 76;
    const visible = screenX >= margin && screenX <= window.innerWidth - margin && screenY >= margin && screenY <= window.innerHeight - margin;
    if (visible) {
      this.hud.arrow.classList.remove("is-visible");
      this.hud.arrowLabel.classList.remove("is-visible");
      return;
    }

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const angle = Math.atan2(screenY - centerY, screenX - centerX);
    const x = THREE.MathUtils.clamp(centerX + Math.cos(angle) * window.innerWidth * 0.38, margin, window.innerWidth - margin);
    const y = THREE.MathUtils.clamp(centerY + Math.sin(angle) * window.innerHeight * 0.4, margin + 80, window.innerHeight - margin);
    this.hud.arrow.style.transform = `translate(${x}px, ${y}px) rotate(${angle}rad)`;
    this.hud.arrowLabel.textContent = target.label;
    this.hud.arrowLabel.style.transform = `translate(${x}px, ${y + 42}px)`;
    this.hud.arrow.classList.add("is-visible");
    this.hud.arrowLabel.classList.add("is-visible");
  }

  private getObjectiveTarget() {
    if (this.accessCard && !this.hasAccessCard) return { x: this.accessCard.position.x, z: this.accessCard.position.z, label: "门禁卡" };
    if (this.hasAccessCard) return { x: 540, z: 1440, label: this.elevatorOpen ? "电梯" : "等电梯" };
    return undefined;
  }

  private emitParticles(x: number, y: number, z: number, color: number, count: number, spread: number) {
    for (let i = 0; i < count; i += 1) {
      const mesh = this.mesh(new THREE.SphereGeometry(THREE.MathUtils.randFloat(2, 5), 6, 4), color);
      mesh.position.set(x, y, z);
      const angle = Math.random() * Math.PI * 2;
      const speed = THREE.MathUtils.randFloat(spread * 0.8, spread * 1.4);
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, THREE.MathUtils.randFloat(40, 120), Math.sin(angle) * speed);
      this.scene.add(mesh);
      this.particles.push({ mesh, velocity, life: 0.45, maxLife: 0.45 });
    }
  }

  private updateParticles(delta: number) {
    for (const particle of this.particles) {
      particle.life -= delta;
      particle.velocity.y -= 180 * delta;
      particle.mesh.position.addScaledVector(particle.velocity, delta);
      const alpha = Math.max(0, particle.life / particle.maxLife);
      const material = particle.mesh.material as THREE.MeshStandardMaterial;
      material.opacity = alpha;
      particle.mesh.scale.setScalar(alpha);
    }

    const expired = this.particles.filter((particle) => particle.life <= 0);
    for (const particle of expired) this.scene.remove(particle.mesh);
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }

  private showFloating(message: string, color: string) {
    const el = document.createElement("div");
    el.className = "float-text";
    el.textContent = message;
    el.style.color = color;
    this.hud.root.append(el);
    setTimeout(() => el.remove(), 720);
  }

  private showHint(message: string) {
    this.hud.hint.textContent = message;
    this.hud.hint.classList.remove("is-fading");
    window.setTimeout(() => this.hud.hint.classList.add("is-fading"), 40);
    this.lastHintTimer = 2;
  }

  private refreshHud() {
    const remaining = Math.max(0, Math.ceil(GAME.duration - this.elapsed));
    this.hud.timer.textContent = `${remaining}`;
    this.hud.hpText.textContent = `HP ${Math.ceil(this.playerState.hp)}/${this.playerState.maxHp}`;
    this.hud.level.textContent = `Lv ${this.playerState.level}`;
    this.hud.card.textContent = this.hasAccessCard ? "门禁卡" : "无卡";
    this.hud.hpBar.style.width = `${(this.playerState.hp / this.playerState.maxHp) * 100}%`;
    this.hud.expBar.style.width = `${(this.playerState.exp / this.playerState.expToNext) * 100}%`;
    const weapon = this.weapon.getSnapshot(this.elapsed);
    this.hud.ammo.textContent = `${weapon.magazineAmmo} / ${weapon.reserveAmmo}`;
    this.hud.weaponStatus.textContent = weapon.isReloading ? "换弹中" : weapon.magazineAmmo === 0 ? "弹匣空" : "冲锋枪";
    this.hud.reloadBar.style.width = `${weapon.reloadProgress * 100}%`;
    this.hud.weaponPanel.classList.toggle("is-reloading", weapon.isReloading);
    this.hud.weaponPanel.classList.toggle("is-empty", weapon.magazineAmmo === 0);
  }

  private finishGame(state: "success" | "failed", message: string, color: string) {
    this.transitionTo(state);
    this.hud.resultTitle.textContent = message;
    this.hud.resultTitle.style.color = color;
    this.hud.result.classList.add("is-visible");
    this.hud.arrow.classList.remove("is-visible");
    this.hud.arrowLabel.classList.remove("is-visible");
  }

  private transitionTo(nextState: GameState) {
    if (nextState === this.gameState) return;
    if (!GAME_STATE_TRANSITIONS[this.gameState].includes(nextState)) {
      throw new Error(`Invalid game state transition: ${this.gameState} -> ${nextState}`);
    }
    this.gameState = nextState;
    this.hud.root.dataset.gameState = nextState;
  }

  private resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const viewHeight = 900;
    this.camera.left = (-viewHeight * aspect) / 2;
    this.camera.right = (viewHeight * aspect) / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
  }

  private distanceToPlayer(x: number, z: number) {
    return Math.hypot(this.playerState.x - x, this.playerState.z - z);
  }

  private box(width: number, height: number, depth: number, color: number, opacity = 1) {
    return this.mesh(new THREE.BoxGeometry(width, height, depth), color, opacity);
  }

  private mesh(geometry: THREE.BufferGeometry, color: number, opacity = 1) {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.78,
      metalness: 0.03,
      transparent: opacity < 1,
      opacity,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private setMeshColor(mesh: THREE.Mesh | undefined, color: number, opacity = 1) {
    if (!mesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    material.color.setHex(color);
    material.opacity = opacity;
    material.transparent = opacity < 1;
  }

  private createHud() {
    const root = document.createElement("div");
    root.className = "ui-root";
    root.innerHTML = `
      <div class="hud-panel">
        <div class="hp-label">HP 100/100</div>
        <div class="hp-track"><div class="hp-fill"></div></div>
        <div class="timer">120</div>
        <div class="level">Lv 1</div>
        <div class="card">无卡</div>
        <div class="exp-track"><div class="exp-fill"></div></div>
      </div>
      <div class="hint">距离下班还有 120 秒</div>
      <div class="evac"><div>正在下班</div><div class="evac-track"><div class="evac-fill"></div></div></div>
      <div class="objective-arrow"></div>
      <div class="objective-label"></div>
      <div class="joystick"><div class="joystick-knob"></div></div>
      <div class="weapon-panel">
        <div class="weapon-status">冲锋枪</div>
        <div class="ammo">20 / 80</div>
        <div class="reload-track"><div class="reload-fill"></div></div>
      </div>
      <button class="fire-button" type="button" aria-label="射击" title="射击"><span class="fire-icon"></span></button>
      <button class="reload-button" type="button" aria-label="换弹" title="换弹">R</button>
      <div class="controls">WASD / 方向键移动并转向 · J / 左键射击 · R 换弹</div>
      <div class="result">
        <div class="result-box">
          <div class="result-title"></div>
          <button class="restart-button" type="button">重新开始</button>
        </div>
      </div>
    `;

    const resultButton = root.querySelector<HTMLButtonElement>(".restart-button")!;
    resultButton.addEventListener("click", () => window.location.reload());

    return {
      root,
      hpText: root.querySelector<HTMLDivElement>(".hp-label")!,
      hpBar: root.querySelector<HTMLDivElement>(".hp-fill")!,
      expBar: root.querySelector<HTMLDivElement>(".exp-fill")!,
      timer: root.querySelector<HTMLDivElement>(".timer")!,
      level: root.querySelector<HTMLDivElement>(".level")!,
      card: root.querySelector<HTMLDivElement>(".card")!,
      hint: root.querySelector<HTMLDivElement>(".hint")!,
      evac: root.querySelector<HTMLDivElement>(".evac")!,
      evacBar: root.querySelector<HTMLDivElement>(".evac-fill")!,
      arrow: root.querySelector<HTMLDivElement>(".objective-arrow")!,
      arrowLabel: root.querySelector<HTMLDivElement>(".objective-label")!,
      joystickBase: root.querySelector<HTMLDivElement>(".joystick")!,
      joystickKnob: root.querySelector<HTMLDivElement>(".joystick-knob")!,
      weaponPanel: root.querySelector<HTMLDivElement>(".weapon-panel")!,
      weaponStatus: root.querySelector<HTMLDivElement>(".weapon-status")!,
      ammo: root.querySelector<HTMLDivElement>(".ammo")!,
      reloadBar: root.querySelector<HTMLDivElement>(".reload-fill")!,
      fireButton: root.querySelector<HTMLButtonElement>(".fire-button")!,
      reloadButton: root.querySelector<HTMLButtonElement>(".reload-button")!,
      result: root.querySelector<HTMLDivElement>(".result")!,
      resultTitle: root.querySelector<HTMLDivElement>(".result-title")!,
    };
  }
}

new OfficeEscapeGame();
