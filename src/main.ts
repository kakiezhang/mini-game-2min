import * as THREE from "three";
import "./styles.css";
import { NavigationWorld, type Obstacle } from "./navigation";

const MAP = {
  width: 1080,
  depth: 1720,
};

const GAME = {
  duration: 120,
  maxEnemies: 55,
  playerRadius: 20,
  elevatorHoldTime: 2,
};

const COLORS = {
  floor: 0x29322f,
  wall: 0x8a938a,
  player: 0xf4f0da,
  playerAccent: 0x2fbf71,
  bug: 0xff6f61,
  changeRequest: 0x60a5fa,
  meeting: 0xa78bfa,
  boss: 0xb45309,
  dart: 0xffd166,
  accessCard: 0xfacc15,
  elevatorClosed: 0x737b86,
  elevatorOpen: 0x22c55e,
};

type EnemyKind = "bug" | "changeRequest" | "meeting" | "boss";

type EnemyConfig = {
  color: number;
  radius: number;
  height: number;
  hp: number;
  speed: number;
  damage: number;
  expReward: number;
  contactCooldown: number;
};

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

type InputState = {
  moveX: number;
  moveZ: number;
};

const ENEMY_CONFIG: Record<EnemyKind, EnemyConfig> = {
  bug: {
    color: COLORS.bug,
    radius: 15,
    height: 34,
    hp: 12,
    speed: 70,
    damage: 5,
    expReward: 5,
    contactCooldown: 0.6,
  },
  changeRequest: {
    color: COLORS.changeRequest,
    radius: 17,
    height: 46,
    hp: 28,
    speed: 95,
    damage: 8,
    expReward: 10,
    contactCooldown: 0.7,
  },
  meeting: {
    color: COLORS.meeting,
    radius: 18,
    height: 40,
    hp: 35,
    speed: 60,
    damage: 4,
    expReward: 12,
    contactCooldown: 0.8,
  },
  boss: {
    color: COLORS.boss,
    radius: 30,
    height: 88,
    hp: 2000,
    speed: 115,
    damage: 20,
    expReward: 0,
    contactCooldown: 0.75,
  },
};

class OfficeEscapeGame {
  private readonly app = document.querySelector<HTMLDivElement>("#app")!;
  private readonly scene = new THREE.Scene();
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly clock = new THREE.Clock();
  private readonly keys = new Set<string>();
  private readonly navigation = new NavigationWorld(MAP.width, MAP.depth);

  private player = new THREE.Group();
  private playerLight?: THREE.PointLight;
  private darts: THREE.Group[] = [];
  private enemies: Enemy[] = [];
  private particles: Particle[] = [];
  private accessCard?: THREE.Group;
  private elevatorZone?: THREE.Mesh;
  private elevatorDoors: THREE.Mesh[] = [];
  private elevatorDoorObstacle?: Obstacle;
  private nextEnemyId = 1;
  private spawnTimer = 0;
  private elapsed = 0;
  private gameOver = false;
  private accessCardSpawned = false;
  private hasAccessCard = false;
  private elevatorSoonShown = false;
  private elevatorOpen = false;
  private bossSpawned = false;
  private evacuationProgress = 0;
  private nextElevatorHintAt = 0;
  private slowUntil = 0;
  private lastHintTimer = 0;

  private readonly playerState = {
    x: 270,
    z: 840,
    hp: 100,
    maxHp: 100,
    speed: 220,
    exp: 0,
    expToNext: 20,
    level: 1,
  };

  private readonly hud = this.createHud();
  private readonly joystick = {
    active: false,
    pointerId: -1,
    centerX: 0,
    centerY: 0,
    x: 0,
    z: 0,
  };

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
    this.createDarts();
    this.bindEvents();
    this.showHint("距离下班还有 120 秒");
    this.resize();
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
    bag.position.set(0, 26, 19);
    this.player.add(body, head, bag);
    this.player.position.set(this.playerState.x, 0, this.playerState.z);
    this.scene.add(this.player);

    this.playerLight = new THREE.PointLight(0xaee8ff, 0.45, 260, 1.9);
    this.playerLight.position.set(this.playerState.x, 72, this.playerState.z);
    this.scene.add(this.playerLight);
  }

  private createDarts() {
    this.darts = [];
    this.addDart();
    this.addDart();
  }

  private addDart() {
    const dart = new THREE.Group();
    const cap = this.mesh(new THREE.BoxGeometry(28, 10, 22), COLORS.dart);
    cap.castShadow = true;
    dart.add(cap);
    this.scene.add(dart);
    this.darts.push(dart);
  }

  private bindEvents() {
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (event) => {
      this.keys.add(event.code);
      if (event.code === "KeyR") window.location.reload();
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));

    const base = this.hud.joystickBase;
    const knob = this.hud.joystickKnob;
    base.addEventListener("pointerdown", (event) => {
      this.joystick.active = true;
      this.joystick.pointerId = event.pointerId;
      const rect = base.getBoundingClientRect();
      this.joystick.centerX = rect.left + rect.width / 2;
      this.joystick.centerY = rect.top + rect.height / 2;
      base.setPointerCapture(event.pointerId);
      this.updateJoystick(event.clientX, event.clientY);
    });
    base.addEventListener("pointermove", (event) => {
      if (!this.joystick.active || this.joystick.pointerId !== event.pointerId) return;
      this.updateJoystick(event.clientX, event.clientY);
    });
    const release = () => {
      this.joystick.active = false;
      this.joystick.x = 0;
      this.joystick.z = 0;
      knob.style.transform = "translate(-50%, -50%)";
    };
    base.addEventListener("pointerup", release);
    base.addEventListener("pointercancel", release);
  }

  private updateJoystick(clientX: number, clientY: number) {
    const maxDistance = 58;
    const dx = clientX - this.joystick.centerX;
    const dy = clientY - this.joystick.centerY;
    const distance = Math.min(Math.hypot(dx, dy), maxDistance);
    const angle = Math.atan2(dy, dx);
    this.joystick.x = (Math.cos(angle) * distance) / maxDistance;
    this.joystick.z = (Math.sin(angle) * distance) / maxDistance;
    this.hud.joystickKnob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance}px))`;
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.033);
    this.update(delta);
    this.renderer.render(this.scene, this.camera);
  };

  private update(delta: number) {
    if (this.gameOver) {
      this.updateParticles(delta);
      return;
    }

    this.elapsed += delta;
    this.spawnTimer -= delta;
    this.lastHintTimer -= delta;

    this.updateTimeline();
    this.updatePlayer(delta);
    this.updateEnemies(delta);
    this.updateDarts(delta);
    this.updateAccessCard();
    this.updateEvacuation(delta);
    this.updateParticles(delta);
    this.trySpawnEnemies();
    this.updateCamera(delta);
    this.updateObjectiveArrow();
    this.refreshHud();

    if (this.gameOver) return;
    if (this.playerState.hp <= 0) this.finish("你被工作压垮了", "#ef4444");
    else if (this.elapsed >= GAME.duration) this.finish("你被迫加班了", "#f97316");
  }

  private updatePlayer(delta: number) {
    const input = this.getInput();
    const slowMultiplier = this.elapsed < this.slowUntil ? 0.7 : 1;
    const speed = this.playerState.speed * slowMultiplier;
    const nextPosition = this.navigation.moveCircle(
      this.playerState.x,
      this.playerState.z,
      input.moveX * speed * delta,
      input.moveZ * speed * delta,
      GAME.playerRadius,
    );
    this.playerState.x = nextPosition.x;
    this.playerState.z = nextPosition.z;
    this.player.position.set(this.playerState.x, 0, this.playerState.z);
    this.player.rotation.y = Math.atan2(input.moveX, input.moveZ || 0.001);
    this.playerLight?.position.set(this.playerState.x, 72, this.playerState.z);
  }

  private getInput(): InputState {
    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) moveX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) moveX += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) moveZ -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) moveZ += 1;
    moveX += this.joystick.x;
    moveZ += this.joystick.z;

    const length = Math.hypot(moveX, moveZ);
    if (length > 0.001) {
      moveX /= length;
      moveZ /= length;
    }
    return { moveX, moveZ };
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
    const stage = this.getSpawnStage();
    const reservedBossSlots = this.bossSpawned ? 0 : 1;
    const availableSlots = Math.max(0, GAME.maxEnemies - this.enemies.length - reservedBossSlots);
    const spawnCount = Math.min(stage.count, availableSlots);
    for (let i = 0; i < spawnCount; i += 1) this.spawnEnemy(this.pickEnemyKind(stage.weights));
    this.spawnTimer = stage.interval;
  }

  private getSpawnStage() {
    if (this.elapsed < 15) return { interval: 1.15, count: 2, weights: { bug: 100, changeRequest: 0, meeting: 0 } };
    if (this.elapsed < 40) return { interval: 1.0, count: 2, weights: { bug: 75, changeRequest: 25, meeting: 0 } };
    if (this.elapsed < 80) return { interval: 0.9, count: 2, weights: { bug: 55, changeRequest: 30, meeting: 15 } };
    if (this.elapsed < 90) return { interval: 0.8, count: 3, weights: { bug: 45, changeRequest: 35, meeting: 20 } };
    return { interval: 0.7, count: 3, weights: { bug: 40, changeRequest: 40, meeting: 20 } };
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
      if (contactDistance < GAME.playerRadius + enemy.radius && this.elapsed >= enemy.nextHitAt) {
        enemy.nextHitAt = this.elapsed + enemy.contactCooldown;
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

  private updateDarts(delta: number) {
    const orbitRadius = 58 + Math.min(this.playerState.level - 1, 4) * 5;
    const damage = 8 + Math.max(0, this.playerState.level - 1) * 2;
    const angleBase = this.elapsed * 3.2;

    this.darts.forEach((dart, index) => {
      const angle = angleBase + (index * Math.PI * 2) / this.darts.length;
      const x = this.playerState.x + Math.cos(angle) * orbitRadius;
      const z = this.playerState.z + Math.sin(angle) * orbitRadius;
      dart.position.set(x, 42, z);
      dart.rotation.y += delta * 5;

      for (const enemy of this.enemies) {
        const distance = Math.hypot(x - enemy.group.position.x, z - enemy.group.position.z);
        if (distance <= enemy.radius + 18) {
          enemy.hp -= damage * delta * 4;
          enemy.group.scale.setScalar(1.08);
          setTimeout(() => enemy.group.scale.setScalar(1), 70);
          if (Math.random() < 0.055) this.emitParticles(x, 36, z, ENEMY_CONFIG[enemy.kind].color, 3, 26);
        }
      }
    });

    const dead = this.enemies.filter((enemy) => enemy.hp <= 0);
    for (const enemy of dead) {
      this.emitParticles(enemy.group.position.x, 34, enemy.group.position.z, ENEMY_CONFIG[enemy.kind].color, enemy.kind === "boss" ? 24 : 10, enemy.kind === "boss" ? 110 : 64);
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
      this.playerState.expToNext = Math.round(this.playerState.expToNext * 1.55 + 12);
      this.showHint(`升级了！键盘飞镖 Lv ${Math.min(this.playerState.level, 5)}`);
      if (this.playerState.level === 2) this.addDart();
      if (this.playerState.level === 5) {
        this.addDart();
        this.addDart();
      }
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
    if (this.distanceToPlayer(this.accessCard.position.x, this.accessCard.position.z) <= GAME.playerRadius + 30) {
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
    if (this.evacuationProgress >= GAME.elevatorHoldTime) this.finish("下班成功！今日无事发生", "#22c55e");
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
  }

  private finish(message: string, color: string) {
    if (this.gameOver) return;
    this.gameOver = true;
    this.hud.resultTitle.textContent = message;
    this.hud.resultTitle.style.color = color;
    this.hud.result.classList.add("is-visible");
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
      <div class="controls">WASD / 方向键移动 · 左下角摇杆 · R 重开</div>
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
      result: root.querySelector<HTMLDivElement>(".result")!,
      resultTitle: root.querySelector<HTMLDivElement>(".result-title")!,
    };
  }
}

new OfficeEscapeGame();
