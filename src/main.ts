import * as THREE from "three";
import "./styles.css";
import { EnemyAiSystem } from "./ai/enemy-ai-system";
import type { EnemyAiRuntime } from "./ai/enemy-ai-runtime";
import { countActiveEnemyKinds } from "./ai/enemy-spawn-selection";
import {
  CharacterAssetStore,
  StaticCharacterVisual,
  type CharacterVisual,
  turnCharacterTowardMovement,
} from "./characters/animated-character";
import { CHARACTER_MODELS, ENEMY_CHARACTER_MODELS } from "./characters/catalog";
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
  WEAPON_UPGRADE_DEFINITIONS,
  getExpToNext,
  getSpawnStage,
  getWeaponRuntimeStats,
  type EnemyConfig,
  type EnemyKind,
  type WeaponUpgradeId,
  type WeaponUpgradeLevels,
} from "./config";
import { InputController, type InputState } from "./input";
import { NavigationWorld, type Obstacle } from "./navigation";
import { GamePerformanceMonitor } from "./performance/game-performance-monitor";
import { createDynamicPointLight } from "./performance/render-performance-profile";
import { GameMinimap } from "./ui/game-minimap";
import { WeaponSystem } from "./weapon";
import { EnemySpawnEffectSystem } from "./effects/enemy-spawn-effect";
import { ELEVATOR_FRAME_LAYOUT, type ElevatorBoxLayout } from "./elevator-layout";

type Enemy = {
  id: number;
  kind: EnemyKind;
  ai: EnemyAiRuntime;
  group: THREE.Group;
  healthBar: THREE.Group;
  healthFill: THREE.Mesh;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  expReward: number;
  contactCooldown: number;
  nextHitAt: number;
  hitFlashUntil: number;
  hitFlashActive: boolean;
  visual: CharacterVisual;
};

type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  size: number;
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
type SurfaceStyle = "concrete" | "tile" | "carpet" | "wall" | "wood" | "metal" | "plastic" | "paper";
const TEXTURE_URLS: Partial<Record<SurfaceStyle, string>> = {
  concrete: new URL("./assets/textures/concrete.png", import.meta.url).href,
  tile: new URL("./assets/textures/floor-tile.png", import.meta.url).href,
  carpet: new URL("./assets/textures/carpet.png", import.meta.url).href,
  wall: new URL("./assets/textures/wall.png", import.meta.url).href,
  wood: new URL("./assets/textures/wood.png", import.meta.url).href,
  metal: new URL("./assets/textures/metal.png", import.meta.url).href,
};

const CHARACTER_TEXTURE_URLS = {
  monkeyFur: new URL("./assets/textures/monkey-fur.png", import.meta.url).href,
  monkeyHoodie: new URL("./assets/textures/monkey-hoodie.png", import.meta.url).href,
  oxHide: new URL("./assets/textures/ox-hide.png", import.meta.url).href,
  horseHide: new URL("./assets/textures/horse-hide.png", import.meta.url).href,
  bossBull: new URL("./assets/textures/boss-bull.png", import.meta.url).href,
} as const;

const GAME_STATE_TRANSITIONS: Record<GameState, readonly GameState[]> = {
  ready: ["playing"],
  playing: ["levelUpPaused", "success", "failed"],
  levelUpPaused: ["playing", "success", "failed"],
  success: [],
  failed: [],
};

const MAX_ACTIVE_PARTICLES = 90;

class OfficeEscapeGame {
  private readonly app = document.querySelector<HTMLDivElement>("#app")!;
  private readonly scene = new THREE.Scene();
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly clock = new THREE.Clock();
  private readonly navigation = new NavigationWorld(MAP.width, MAP.depth);
  private readonly weapon = new WeaponSystem(DEFAULT_WEAPON);
  private readonly materialCache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly particleGeometry = new THREE.SphereGeometry(1, 6, 4);
  private readonly characterAssets = new CharacterAssetStore();
  private readonly enemyAi = new EnemyAiSystem(this.scene);
  private readonly enemySpawnEffects = new EnemySpawnEffectSystem(this.scene);
  private readonly performanceMonitor = new GamePerformanceMonitor(
    this.navigation,
    this.scene,
    () => this.enemyAi.takePerformanceSnapshot(this.elapsed),
  );

  private player = new THREE.Group();
  private playerLight?: THREE.PointLight;
  private playerVisual?: CharacterVisual;
  private readonly muzzleWorldPosition = new THREE.Vector3();
  private pendingShotAim?: { x: number; z: number };
  private input?: InputController;
  private crosshair?: THREE.Group;
  private enemies: Enemy[] = [];
  private particles: Particle[] = [];
  private shotEffects: ShotEffect[] = [];
  private bulletVisuals: BulletVisual[] = [];
  private impactDecals: THREE.Mesh[] = [];
  private ammoPickups: AmmoPickup[] = [];
  private accessCard?: THREE.Group;
  private accessCardBeacon?: THREE.Group;
  private elevatorZone?: THREE.Mesh;
  private elevatorBeacon?: THREE.Group;
  private elevatorDoors: THREE.Mesh[] = [];
  private elevatorDoorObstacle?: Obstacle;
  private bossAlertBeacon?: THREE.Group;
  private nextEnemyId = 1;
  private spawnTimer = 0;
  private elapsed = 0;
  private gameState: GameState = "ready";
  private accessCardSpawned = false;
  private hasAccessCard = false;
  private elevatorSoonShown = false;
  private elevatorOpen = false;
  private bossSpawned = false;
  private bossAlertUntil = 0;
  private evacuationProgress = 0;
  private evacuationComplete = false;
  private nextElevatorHintAt = 0;
  private slowUntil = 0;
  private lastHintTimer = 0;
  private nextWeaponHintAt = 0;
  private nextAmmoHintAt = 0;
  private cameraKick = 0;
  private playerInvincibleUntil = 0;
  private pendingLevelUps = 0;
  private currentUpgradeChoices: WeaponUpgradeId[] = [];
  private readonly weaponUpgradeLevels: WeaponUpgradeLevels = {
    firepowerCalibration: 0,
    magazineManagement: 0,
  };

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
  private readonly minimap = new GameMinimap(this.hud.minimap, this.navigation, MAP);

  constructor() {
    this.app.innerHTML = "";
    this.scene.background = new THREE.Color(0x17221f);
    this.scene.fog = new THREE.Fog(0x17221f, 1120, 2850);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.38;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.app.append(this.renderer.domElement, this.hud.root);

    this.setupCamera();
    this.createLights();
    this.createMap();
    this.minimap.update(0, this.playerState, this.enemies);
    const charactersReady = Promise.all([
      this.createPlayer(),
      this.characterAssets.preload(CHARACTER_MODELS.bug),
      this.characterAssets.preload(CHARACTER_MODELS.ppt),
      this.characterAssets.preload(CHARACTER_MODELS.changeRequest),
    ]);
    this.createFixedAmmoSupplies();
    this.createCrosshair();
    this.input = new InputController(this.renderer.domElement, this.camera, {
      base: this.hud.joystickBase,
      knob: this.hud.joystickKnob,
    }, this.hud.fireButton, this.hud.reloadButton);
    this.bindEvents();
    this.showHint("正在加载角色模型…");
    this.resize();
    this.animate();
    void charactersReady.then(() => {
      this.showHint("距离下班还有 120 秒");
      this.transitionTo("playing");
    }).catch((error: unknown) => {
      console.error("Failed to load character models", error);
      this.showHint("角色模型加载失败，请刷新重试");
    });
  }

  private setupCamera() {
    this.camera.position.set(890, 930, 1780);
    this.camera.lookAt(270, 0, 840);
  }

  private createLights() {
    const ambient = new THREE.HemisphereLight(0xfff2d2, 0x1d302b, 0.82);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffe4b0, 2.35);
    sun.position.set(-520, 980, 340);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00018;
    sun.shadow.normalBias = 0.035;
    sun.shadow.camera.left = -950;
    sun.shadow.camera.right = 950;
    sun.shadow.camera.top = 1200;
    sun.shadow.camera.bottom = -1200;
    sun.shadow.camera.near = 120;
    sun.shadow.camera.far = 2400;
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0xa6e7ff, 0.62);
    rim.position.set(740, 420, 1180);
    this.scene.add(rim);

    this.addAreaLight(270, 280, 0xffd27a, 1.08);
    this.addAreaLight(810, 840, 0xb9f5bf, 0.9);
    this.addAreaLight(540, 1440, 0x9fd0ff, 1.12);
  }

  private addAreaLight(x: number, z: number, color: number, intensity: number) {
    const light = new THREE.PointLight(color, intensity, 520, 1.4);
    light.position.set(x, 120, z);
    this.scene.add(light);
  }

  private createMap() {
    const ground = this.texturedBox(MAP.width, 8, MAP.depth, this.surfaceMaterial("foundation", COLORS.floor, 0x3d4942, 0.94, "concrete", 6, 9));
    ground.position.set(MAP.width / 2, -4, MAP.depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    const rooms = [
      { x: 270, z: 280, w: 520, d: 540, color: 0x33433d, style: "carpet" },
      { x: 810, z: 280, w: 520, d: 540, color: 0x403936, style: "carpet" },
      { x: 270, z: 840, w: 520, d: 540, color: 0x293f47, style: "tile" },
      { x: 810, z: 840, w: 520, d: 540, color: 0x354635, style: "tile" },
      { x: 540, z: 1420, w: 1040, d: 560, color: 0x313a44, style: "concrete" },
    ];

    for (const room of rooms) {
      const floor = this.texturedBox(room.w, 6, room.d, this.surfaceMaterial(`room-${room.x}-${room.z}`, room.color, 0x5f6a60, 0.94, room.style as SurfaceStyle, 4, 4));
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

    this.addDesk(250, 770, 270, 70, 42, 0xa66f3f);
    this.addDesk(260, 925, 240, 70, 42, 0xa66f3f);
    this.addDesk(270, 280, 280, 118, 46, 0x9a6a42);
    this.addDesk(820, 265, 260, 118, 54, 0x8f5a35);
    this.addCoffeeMachine(825, 805);
    this.addElevatorDoor();
    this.addChairs();
    this.addSceneDressing();
    this.addFloorNoise();
  }

  private addWall(x: number, z: number, width: number, depth: number) {
    const wall = this.texturedBox(width, 90, depth, this.surfaceMaterial("painted-wall", COLORS.wall, 0xb2b8aa, 1, "wall", 2, 1));
    wall.position.set(x, 45, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    this.scene.add(wall);
    this.navigation.addObstacle(x, z, width, depth);
  }

  private addDesk(x: number, z: number, width: number, depth: number, height: number, color: number) {
    const top = this.texturedBox(width, height, depth, this.surfaceMaterial(`desk-${color.toString(16)}`, color, 0xd4a15f, 1, "wood", 3, 1));
    top.position.set(x, height / 2, z);
    top.castShadow = true;
    top.receiveShadow = true;
    this.scene.add(top);
    this.navigation.addObstacle(x, z, width, depth);

    const highlight = this.box(width * 0.44, 3, depth * 0.12, 0xffe0a3, 0.26);
    highlight.position.set(x - width * 0.18, height + 2, z - depth * 0.22);
    this.scene.add(highlight);
  }

  private addCoffeeMachine(x: number, z: number) {
    this.addDesk(x, z, 94, 94, 72, 0x9b6739);
    const screen = this.box(48, 4, 28, 0x111816, 1);
    screen.position.set(x, 74, z - 48);
    this.scene.add(screen);
  }

  private addElevatorDoor() {
    this.addWallFromLayout(ELEVATOR_FRAME_LAYOUT.leftJamb);
    this.addWallFromLayout(ELEVATOR_FRAME_LAYOUT.rightJamb);
    this.addWallFromLayout(ELEVATOR_FRAME_LAYOUT.leftSideWall);
    this.addWallFromLayout(ELEVATOR_FRAME_LAYOUT.rightSideWall);
    this.addWallFromLayout(ELEVATOR_FRAME_LAYOUT.backWall);

    const elevatorMetal = this.surfaceMaterial("elevator-metal", COLORS.elevatorClosed, 0xaeb7c0, 1, "metal", 2, 1);
    const lintelLayout = ELEVATOR_FRAME_LAYOUT.lintel;
    const lintel = this.texturedBox(lintelLayout.width, lintelLayout.height, lintelLayout.depth, elevatorMetal);
    lintel.position.set(lintelLayout.x, lintelLayout.y, lintelLayout.z);
    this.scene.add(lintel);

    const leftDoor = this.texturedBox(124, 68, 18, elevatorMetal);
    const rightDoor = this.texturedBox(124, 68, 18, elevatorMetal);
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

  private addWallFromLayout(layout: ElevatorBoxLayout) {
    this.addWall(layout.x, layout.z, layout.width, layout.depth);
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
      const chair = this.texturedBox(34, 32, 34, this.surfaceMaterial("chair-fabric", 0x38424b, 0x6f7d86, 1, "carpet", 1, 1));
      chair.position.set(x, 16, z);
      chair.castShadow = true;
      chair.receiveShadow = true;
      this.scene.add(chair);
      this.navigation.addObstacle(x, z, 34, 34);
    }
  }

  private addSceneDressing() {
    this.addZonePanel(270, 840, 430, 370, 0x1d4f5c, 0.16);
    this.addZonePanel(270, 280, 410, 360, 0x5f4971, 0.14);
    this.addZonePanel(810, 280, 420, 360, 0x6b3f2e, 0.14);
    this.addZonePanel(810, 840, 410, 350, 0x315f3e, 0.15);
    this.addZonePanel(540, 1420, 470, 270, 0x334b62, 0.16);

    this.addFloorLabel(270, 610, "WORK", 0x8bdff2, 0.42);
    this.addFloorLabel(270, 95, "MEET", 0xd9b6ff, 0.38);
    this.addFloorLabel(810, 95, "BOSS", 0xffc08a, 0.4);
    this.addFloorLabel(840, 610, "SUPPLY", 0xa7f3c0, 0.36);
    this.addFloorLabel(540, 1320, "EXIT", 0xbdefff, 0.5);

    this.addGuideLine([
      [270, 840],
      [510, 1080],
      [540, 1320],
      [540, 1440],
    ], 0xffd166, 0.48);
    this.addGuideArrow(540, 1270, 0, 0xffd166);
    this.addGuideArrow(540, 1388, 0, 0xbdefff);

    this.addWorkstationDetails();
    this.addMeetingRoomDetails();
    this.addBossOfficeDetails();
    this.addSupplyRoomDetails();
    this.addElevatorDetails();

    this.addLightStrip(160, 560, 190, Math.PI / 2, 0xffdf91);
    this.addLightStrip(890, 560, 170, Math.PI / 2, 0xbdefff);
    this.addLightStrip(540, 1294, 260, 0, 0xc8f7ff);

    this.addFilingCabinet(105, 315, 0x4e6571);
    this.addFilingCabinet(930, 210, 0x566251);
    this.addFilingCabinet(792, 1000, 0x425b44);

    this.addCrateStack(120, 1320, 0.15);
    this.addCrateStack(895, 1200, -0.25);
    this.addCrateStack(735, 440, 0.7);

    this.addPottedPlant(70, 650);
    this.addPottedPlant(1000, 1080);
    this.addPottedPlant(420, 170);

    this.addCableCoil(660, 1040);
    this.addCableCoil(420, 1220);
    this.addPaperScatter(200, 860, 8);
    this.addPaperScatter(860, 360, 9);
    this.addPaperScatter(480, 1460, 11);
  }

  private addZonePanel(x: number, z: number, width: number, depth: number, color: number, opacity: number) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    panel.rotation.x = -Math.PI / 2;
    panel.position.set(x, 7.8, z);
    panel.renderOrder = 1;
    this.scene.add(panel);
  }

  private addFloorLabel(x: number, z: number, text: string, color: number, opacity: number) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "800 50px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    context.globalAlpha = opacity;
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 4);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 56),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 1, depthWrite: false }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(x, 8.5, z);
    label.renderOrder = 3;
    this.scene.add(label);
  }

  private addGuideLine(points: [number, number][], color: number, opacity: number) {
    for (let index = 0; index < points.length - 1; index += 1) {
      const [startX, startZ] = points[index];
      const [endX, endZ] = points[index + 1];
      this.addGuideSegment(startX, startZ, endX, endZ, 10, color, opacity);
    }
  }

  private addGuideSegment(startX: number, startZ: number, endX: number, endZ: number, width: number, color: number, opacity: number) {
    const deltaX = endX - startX;
    const deltaZ = endZ - startZ;
    const length = Math.hypot(deltaX, deltaZ);
    const segment = new THREE.Mesh(
      new THREE.PlaneGeometry(width, length),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    segment.rotation.x = -Math.PI / 2;
    segment.rotation.z = -Math.atan2(deltaX, deltaZ);
    segment.position.set((startX + endX) / 2, 9, (startZ + endZ) / 2);
    segment.renderOrder = 4;
    this.scene.add(segment);
  }

  private addGuideArrow(x: number, z: number, rotationY: number, color: number) {
    const shape = new THREE.Shape();
    shape.moveTo(0, -28);
    shape.lineTo(24, 24);
    shape.lineTo(7, 15);
    shape.lineTo(7, 28);
    shape.lineTo(-7, 28);
    shape.lineTo(-7, 15);
    shape.lineTo(-24, 24);
    shape.lineTo(0, -28);
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.68, depthWrite: false, side: THREE.DoubleSide }),
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.rotation.z = rotationY;
    arrow.position.set(x, 9.3, z);
    arrow.renderOrder = 5;
    this.scene.add(arrow);
  }

  private addWorkstationDetails() {
    this.addComputerSet(185, 740, 0, 0x7dd3fc);
    this.addComputerSet(320, 760, 0, 0x7dd3fc);
    this.addComputerSet(185, 915, Math.PI, 0x38bdf8);
    this.addComputerSet(330, 925, Math.PI, 0x38bdf8);
    this.addCableTrail(190, 820, 330, 870);
    this.addWallMarker(88, 840, Math.PI / 2, 0x7dd3fc);
  }

  private addMeetingRoomDetails() {
    this.addWhiteboard(70, 270, Math.PI / 2);
    this.addProjector(270, 505);
    this.addFloorDecal(270, 280, 92, 0x1f172a, 0.22);
    this.addComputerSet(270, 250, 0, 0xd9b6ff);
    this.addPaperScatter(215, 350, 7);
    this.addPaperScatter(335, 240, 6);
  }

  private addBossOfficeDetails() {
    this.addZonePanel(820, 265, 330, 190, 0x4a2516, 0.2);
    this.addComputerSet(820, 220, 0, 0xffb86b);
    this.addDeskLamp(910, 245, 0xffd27a);
    this.addWallMarker(1030, 280, -Math.PI / 2, 0xffb86b);
    this.addBookShelf(1000, 430, 0);
    this.addPaperScatter(760, 345, 8);
  }

  private addSupplyRoomDetails() {
    this.addSupplyPad(450, 1000, 0x32d583);
    this.addSupplyPad(950, 450, 0x32d583);
    this.addVendingMachine(990, 820);
    this.addFloorDecal(810, 840, 70, 0x10351f, 0.22);
    this.addWallMarker(1030, 850, -Math.PI / 2, 0xa7f3c0);
  }

  private addElevatorDetails() {
    this.addGuideSegment(420, 1370, 660, 1370, 8, 0xbdefff, 0.46);
    this.addGuideSegment(420, 1512, 660, 1512, 8, 0xbdefff, 0.46);
    this.addGuideSegment(420, 1370, 420, 1512, 8, 0xbdefff, 0.46);
    this.addGuideSegment(660, 1370, 660, 1512, 8, 0xbdefff, 0.46);
    this.addHazardStripes(540, 1305, 260);
    this.addWallMarker(540, 1585, Math.PI, 0xbdefff);
  }

  private addComputerSet(x: number, z: number, rotationY: number, glowColor: number) {
    const group = new THREE.Group();
    const monitor = this.mesh(new THREE.BoxGeometry(38, 24, 5), 0x0c1114);
    monitor.position.set(0, 28, -2);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 16),
      new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.62, depthWrite: false }),
    );
    screen.position.set(0, 28, -5.2);
    const stand = this.mesh(new THREE.BoxGeometry(6, 14, 6), 0x232d32);
    stand.position.set(0, 14, 0);
    const keyboard = this.mesh(new THREE.BoxGeometry(36, 3, 13), 0x151b1f);
    keyboard.position.set(0, 7, 24);
    group.add(monitor, screen, stand, keyboard);
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
  }

  private addCableTrail(startX: number, startZ: number, endX: number, endZ: number) {
    this.addGuideSegment(startX, startZ, endX, endZ, 5, 0x101718, 0.58);
    this.addGuideSegment(startX + 36, startZ - 24, endX + 10, endZ + 34, 4, 0x101718, 0.42);
  }

  private addWhiteboard(x: number, z: number, rotationY: number) {
    const group = new THREE.Group();
    const board = this.mesh(new THREE.BoxGeometry(8, 58, 142), 0xe8ead9);
    board.position.y = 62;
    const markerLine = this.mesh(new THREE.BoxGeometry(9, 3, 96), 0x60a5fa);
    markerLine.position.set(-5, 74, -6);
    const tray = this.mesh(new THREE.BoxGeometry(10, 5, 118), 0x737b86);
    tray.position.set(-5, 34, 0);
    group.add(board, markerLine, tray);
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
  }

  private addProjector(x: number, z: number) {
    const projector = this.mesh(new THREE.BoxGeometry(44, 18, 30), 0x2c3438);
    projector.position.set(x, 72, z);
    this.scene.add(projector);
    const light = new THREE.SpotLight(0xd9b6ff, 0.72, 250, 0.5, 0.5, 1.8);
    light.position.set(x, 74, z);
    light.target.position.set(x, 40, z - 120);
    this.scene.add(light, light.target);
  }

  private addDeskLamp(x: number, z: number, color: number) {
    const base = this.mesh(new THREE.CylinderGeometry(7, 9, 5, 8), 0x352113);
    base.position.set(x, 58, z);
    const shade = this.mesh(new THREE.ConeGeometry(16, 18, 10), color);
    shade.position.set(x, 75, z);
    shade.rotation.x = Math.PI;
    this.scene.add(base, shade);
    const light = new THREE.PointLight(color, 0.52, 160, 1.9);
    light.position.set(x, 72, z);
    this.scene.add(light);
  }

  private addBookShelf(x: number, z: number, rotationY: number) {
    const group = new THREE.Group();
    const shelf = this.texturedBox(126, 80, 22, this.surfaceMaterial("bookshelf", 0x5a3b22, 0xb08455, 1, "wood", 2, 1));
    shelf.position.y = 40;
    group.add(shelf);
    for (let index = 0; index < 9; index += 1) {
      const book = this.box(8, 34 + (index % 3) * 5, 14, index % 2 === 0 ? 0xffd166 : 0x60a5fa, 1);
      book.position.set(-48 + index * 12, 48, -13);
      group.add(book);
    }
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
  }

  private addSupplyPad(x: number, z: number, color: number) {
    this.addFloorDecal(x, z, 48, color, 0.18);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(36, 42, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.52, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 9.4, z);
    ring.renderOrder = 5;
    this.scene.add(ring);
  }

  private addVendingMachine(x: number, z: number) {
    const body = this.texturedBox(50, 92, 34, this.surfaceMaterial("vending", 0x1f5132, 0x8ff0a4, 1, "plastic", 1, 2));
    body.position.set(x, 46, z);
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(28, 46),
      new THREE.MeshBasicMaterial({ color: 0xa7f3c0, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    panel.position.set(x, 54, z - 17.4);
    this.scene.add(body, panel);
  }

  private addHazardStripes(x: number, z: number, width: number) {
    for (let index = 0; index < 9; index += 1) {
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(9, 42),
        new THREE.MeshBasicMaterial({ color: index % 2 === 0 ? 0xffd166 : 0x111816, transparent: true, opacity: 0.62, depthWrite: false }),
      );
      stripe.rotation.x = -Math.PI / 2;
      stripe.rotation.z = -0.68;
      stripe.position.set(x - width / 2 + 34 + index * 24, 9.2, z);
      stripe.renderOrder = 5;
      this.scene.add(stripe);
    }
  }

  private addWallMarker(x: number, z: number, rotationY: number, color: number) {
    const group = new THREE.Group();
    const frame = this.mesh(new THREE.BoxGeometry(72, 38, 5), 0x111816);
    frame.position.y = 66;
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(58, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    glow.position.set(0, 66, -3);
    group.add(frame, glow);
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
  }

  private addLightStrip(x: number, z: number, length: number, rotationY: number, color: number) {
    const group = new THREE.Group();
    const rail = this.mesh(new THREE.BoxGeometry(length, 5, 8), 0x1b2425);
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(length * 0.86, 3, 4),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 1.35,
        roughness: 0.38,
        metalness: 0.05,
      }),
    );
    rail.position.y = 92;
    glow.position.y = 96;
    group.add(rail, glow);
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);

    const light = new THREE.PointLight(color, 0.55, 260, 1.75);
    light.position.set(x, 112, z);
    this.scene.add(light);
  }

  private addFilingCabinet(x: number, z: number, color: number) {
    const cabinet = this.texturedBox(52, 76, 42, this.surfaceMaterial(`cabinet-${color.toString(16)}`, color, 0x9ba69d, 1, "metal", 1, 2));
    cabinet.position.set(x, 38, z);
    cabinet.castShadow = true;
    cabinet.receiveShadow = true;
    this.scene.add(cabinet);
    this.navigation.addObstacle(x, z, 52, 42);

    for (let index = 0; index < 3; index += 1) {
      const handle = this.box(28, 3, 4, 0xd8d4c8, 1);
      handle.position.set(x, 24 + index * 19, z - 23);
      this.scene.add(handle);
    }
  }

  private addCrateStack(x: number, z: number, rotationY: number) {
    const group = new THREE.Group();
    const crateMaterial = this.surfaceMaterial("dark-crate", 0x6f5632, 0xc28a4f, 1, "wood", 2, 1);
    const first = this.texturedBox(72, 42, 48, crateMaterial);
    const second = this.texturedBox(50, 34, 42, crateMaterial);
    const band = this.box(76, 4, 7, 0x202828, 1);
    first.position.set(0, 21, 0);
    second.position.set(11, 59, -3);
    band.position.set(0, 45, -25);
    group.add(first, second, band);
    group.position.set(x, 0, z);
    group.rotation.y = rotationY;
    this.scene.add(group);
    this.navigation.addObstacle(x, z, 84, 58);
  }

  private addPottedPlant(x: number, z: number) {
    const group = new THREE.Group();
    const pot = this.mesh(new THREE.CylinderGeometry(14, 18, 24, 8), 0x6b3f2e);
    pot.position.y = 12;
    for (let index = 0; index < 5; index += 1) {
      const leaf = this.mesh(new THREE.ConeGeometry(8, 42, 6), 0x4f8f5f);
      const angle = (index / 5) * Math.PI * 2;
      leaf.position.set(Math.cos(angle) * 8, 42, Math.sin(angle) * 8);
      leaf.rotation.z = Math.cos(angle) * 0.45;
      leaf.rotation.x = Math.sin(angle) * 0.45;
      group.add(leaf);
    }
    group.add(pot);
    group.position.set(x, 0, z);
    this.scene.add(group);
  }

  private addCableCoil(x: number, z: number) {
    const coil = this.mesh(new THREE.TorusGeometry(24, 4, 8, 28), 0x181f21);
    coil.position.set(x, 7, z);
    coil.rotation.x = Math.PI / 2;
    this.scene.add(coil);
  }

  private addPaperScatter(x: number, z: number, count: number) {
    const material = this.surfaceMaterial("loose-paper", 0xd8d0b6, 0x8f8468, 0.82, "paper", 1, 1);
    for (let index = 0; index < count; index += 1) {
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(20, 14), material);
      paper.rotation.x = -Math.PI / 2;
      paper.rotation.z = (index * 0.83) % Math.PI;
      paper.position.set(x + ((index * 37) % 94) - 47, 8.4, z + ((index * 53) % 76) - 38);
      paper.receiveShadow = true;
      this.scene.add(paper);
    }
  }

  private addFloorNoise() {
    const material = new THREE.MeshStandardMaterial({ color: 0xaeb7a9, transparent: true, opacity: 0.2, roughness: 1 });
    const geometry = new THREE.BoxGeometry(6, 1, 3);
    for (let i = 0; i < 180; i += 1) {
      const mark = new THREE.Mesh(geometry, material);
      mark.position.set(((i * 149) % (MAP.width - 90)) + 45, 5, ((i * 227) % (MAP.depth - 90)) + 45);
      mark.rotation.y = (i % 8) * 0.31;
      this.scene.add(mark);
    }

    for (let i = 0; i < 30; i += 1) {
      this.addFloorDecal(
        ((i * 193) % (MAP.width - 130)) + 65,
        ((i * 281) % (MAP.depth - 150)) + 75,
        THREE.MathUtils.randFloat(18, 42),
        i % 3 === 0 ? 0x0c1110 : 0x596158,
        i % 3 === 0 ? 0.18 : 0.12,
      );
    }
  }

  private async createPlayer() {
    this.player = new THREE.Group();

    const muzzleAccent = new THREE.PointLight(COLORS.muzzle, 0.18, 90, 1.9);
    const selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(25, 32, 32),
      new THREE.MeshBasicMaterial({ color: COLORS.playerAccent, transparent: true, opacity: 0.38, depthWrite: false }),
    );
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.position.y = 3;

    this.player.add(selectionRing);
    this.player.position.set(this.playerState.x, 0, this.playerState.z);
    this.scene.add(this.player);

    this.playerLight = new THREE.PointLight(0xaee8ff, 0.45, 260, 1.9);
    this.playerLight.position.set(this.playerState.x, 72, this.playerState.z);
    this.scene.add(this.playerLight);

    this.playerVisual = await this.characterAssets.createAsync(CHARACTER_MODELS.player, {
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.player.add(this.playerVisual.root);
    if (this.playerVisual.muzzleSocket) {
      this.playerVisual.muzzleSocket.add(muzzleAccent);
    } else {
      muzzleAccent.position.set(16, 44, 83);
      this.player.add(muzzleAccent);
    }
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
      const glow = createDynamicPointLight("ammo", COLORS.ammoBox, 0.65, 180, 1.7);
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
    window.addEventListener("keydown", this.onUpgradeKeyDown);
    this.app.addEventListener("dblclick", this.preventBrowserGesture);
    this.app.addEventListener("selectstart", this.preventBrowserGesture);
    this.app.addEventListener("gesturestart", this.preventBrowserGesture, { passive: false });
    this.app.addEventListener("gesturechange", this.preventBrowserGesture, { passive: false });
    this.app.addEventListener("gestureend", this.preventBrowserGesture, { passive: false });
    this.app.addEventListener("touchstart", this.preventMultiTouchGesture, { passive: false });
    this.app.addEventListener("touchmove", this.preventMultiTouchGesture, { passive: false });
  }

  private preventBrowserGesture = (event: Event) => {
    event.preventDefault();
  };

  private preventMultiTouchGesture = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault();
  };

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.performanceMonitor.beginFrame();
    const delta = Math.min(this.clock.getDelta(), 0.033);
    const updateStartedAt = this.performanceMonitor.startPhase();
    this.update(delta);
    this.performanceMonitor.finishPhase("update", updateStartedAt);
    const renderStartedAt = this.performanceMonitor.startPhase();
    this.renderer.render(this.scene, this.camera);
    this.performanceMonitor.finishPhase("render", renderStartedAt);
    if (this.performanceMonitor.enabled) {
      this.performanceMonitor.finishFrame({
        gameElapsed: this.elapsed,
        gameState: this.gameState,
        enemyCount: this.enemies.length,
        enemyKindCounts: countActiveEnemyKinds(this.enemies),
        animatedEnemyCount: this.enemies.reduce((count, enemy) => (
          count + (ENEMY_CHARACTER_MODELS[enemy.kind] ? 1 : 0)
        ), 0),
        rendererInfo: this.renderer.info,
      });
    }
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
    this.enemySpawnEffects.update(delta);
    this.spawnTimer -= delta;
    this.lastHintTimer -= delta;

    const input = this.input!.getState(this.playerState.x, this.playerState.z);
    this.updateTimeline();
    this.updatePlayer(delta, input);
    this.updateBulletVisuals(delta);
    const enemiesStartedAt = this.performanceMonitor.startPhase();
    this.updateEnemies(delta);
    this.performanceMonitor.finishPhase("enemies", enemiesStartedAt);
    const shotAim = this.updateWeapon(input);
    this.updatePlayerAnimation(delta, input);
    if (shotAim) this.fireWeapon(shotAim.x, shotAim.z);
    this.updateAmmoPickups(delta);
    this.updateAccessCard();
    this.updateEvacuation(delta);
    this.updateObjectiveBeacons(delta);
    this.updateParticles(delta);
    this.updateShotEffects(delta);
    this.trySpawnEnemies();
    this.minimap.update(delta, this.playerState, this.enemies);
    this.updateCamera(delta);
    this.updateObjectiveArrow();
    this.refreshHud();

    this.resolveGameResult();
    this.tryOpenUpgradePanel();
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
    // Keep the facing direction committed during the short Shoot windup so
    // a direction change before the firing frame cannot turn the gun away
    // from the shot that is already queued.
    const facingAim = this.pendingShotAim ?? { x: input.aimX, z: input.aimZ };
    this.player.rotation.y = Math.atan2(facingAim.x, facingAim.z);
    this.playerLight?.position.set(this.playerState.x, 72, this.playerState.z);
    this.crosshair?.position.set(input.aimPointX, 5, input.aimPointZ);
  }

  private updatePlayerAnimation(delta: number, input: InputState) {
    if (!this.playerVisual) return;
    this.playerVisual.setMovement(input.moveX, input.moveZ);
    this.playerVisual.update(delta);
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
      this.elevatorBeacon = this.createObjectiveBeacon(540, 1440, 0x7dd3fc, 56);
      this.showHint("电梯开放！快去下班！");
    }
    if (!this.bossSpawned && this.elapsed >= 90) {
      this.bossSpawned = true;
      this.performanceMonitor.measureSpawn("boss", this.elapsed, () => this.spawnBoss());
      this.showAlert("老板来了，立即撤离");
      this.showHint("老板来了！快跑！");
    }
  }

  private trySpawnEnemies() {
    if (this.enemies.length >= GAME.maxEnemies || this.spawnTimer > 0) return;
    const stage = getSpawnStage(this.elapsed);
    const reservedBossSlots = this.bossSpawned ? 0 : 1;
    const availableSlots = Math.max(0, GAME.maxEnemies - this.enemies.length - reservedBossSlots);
    const spawnCount = Math.min(stage.count, availableSlots);
    for (let i = 0; i < spawnCount; i += 1) {
      const kind = this.enemyAi.pickSpawnKind(stage.weights, this.enemies);
      if (!kind) break;
      this.performanceMonitor.measureSpawn(kind, this.elapsed, () => this.spawnEnemy(kind));
    }
    this.spawnTimer = stage.interval;
  }

  private spawnEnemy(kind: EnemyKind) {
    const radius = ENEMY_CONFIG[kind].radius;
    const margin = Math.max(42, radius + 16);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const side = this.enemyAi.randomInteger(4);
      let x = margin;
      let z = margin;
      if (side === 0) {
        x = this.enemyAi.randomRange(margin, MAP.width - margin);
      } else if (side === 1) {
        x = MAP.width - margin;
        z = this.enemyAi.randomRange(margin, MAP.depth - margin);
      } else if (side === 2) {
        x = this.enemyAi.randomRange(margin, MAP.width - margin);
        z = MAP.depth - margin;
      } else {
        z = this.enemyAi.randomRange(margin, MAP.depth - margin);
      }
      if (
        this.distanceToPlayer(x, z) < 300
        || !this.navigation.canOccupy(x, z, radius)
        || !this.navigation.canReach(x, z, this.playerState.x, this.playerState.z, radius)
      ) continue;
      this.createEnemy(kind, x, z);
      return;
    }
  }

  private spawnBoss() {
    this.createEnemy("boss", 820, 430);
    this.bossAlertBeacon = this.createObjectiveBeacon(820, 430, 0xff4b2f, 74);
  }

  private createEnemy(kind: EnemyKind, x: number, z: number) {
    const id = this.nextEnemyId;
    const config = ENEMY_CONFIG[kind];
    const group = new THREE.Group();
    const healthBarWidth = kind === "boss" ? 86 : 48;
    const healthBar = this.createEnemyHealthBar(healthBarWidth, kind === "boss" ? 0xff9f1c : config.color);
    const healthFill = healthBar.children[1] as THREE.Mesh;
    const animatedModel = ENEMY_CHARACTER_MODELS[kind];
    const visual = animatedModel
      ? this.characterAssets.create(animatedModel, {
        maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
      })
      : new StaticCharacterVisual();

    if (kind === "boss") {
      this.addBossModel(visual.root, config);
    }
    group.add(visual.root);

    group.position.set(x, 0, z);
    healthBar.position.set(x, config.height + (kind === "boss" ? 58 : 28), z);
    this.scene.add(group);
    this.scene.add(healthBar);

    const enemy: Enemy = {
      id,
      kind,
      ai: this.enemyAi.createRuntime(id, kind, x, z, this.elapsed, true),
      group,
      healthBar,
      healthFill,
      radius: config.radius,
      hp: config.hp,
      maxHp: config.hp,
      speed: config.speed,
      damage: config.damage,
      expReward: config.expReward,
      contactCooldown: config.contactCooldown,
      nextHitAt: 0,
      hitFlashUntil: 0,
      hitFlashActive: false,
      visual,
    };
    this.enemies.push(enemy);
    this.enemySpawnEffects.begin({
      id,
      x,
      z,
      radius: config.radius,
      height: config.height,
      color: config.color,
      target: group,
      healthBar,
      boss: kind === "boss",
      onComplete: () => this.enemyAi.activateSpawn(enemy.ai, this.elapsed),
    });
    this.nextEnemyId += 1;
  }

  private addBossModel(group: THREE.Group, config: EnemyConfig) {
    const hide = this.characterInstanceMaterial("bossBull");
    const body = this.meshWithMaterial(new THREE.CylinderGeometry(config.radius * 0.98, config.radius * 1.24, config.height, 24), hide);
    body.position.y = config.height / 2;
    const coat = this.mesh(new THREE.BoxGeometry(54, 58, 18), 0x4a2d16);
    coat.position.set(0, 49, 12);
    const head = this.meshWithMaterial(new THREE.SphereGeometry(22, 24, 16), hide);
    head.position.set(0, config.height + 18, 4);
    const snout = this.mesh(new THREE.SphereGeometry(1, 16, 10), 0xd08a4c);
    snout.scale.set(14, 6, 8);
    snout.position.set(0, config.height + 13, 22);
    const leftHorn = this.mesh(new THREE.ConeGeometry(6, 32, 12), 0xf6e6c2);
    leftHorn.position.set(-22, config.height + 25, 0);
    leftHorn.rotation.z = Math.PI / 2.25;
    const rightHorn = leftHorn.clone();
    rightHorn.position.x = 22;
    rightHorn.rotation.z = -Math.PI / 2.25;
    const crown = this.mesh(new THREE.BoxGeometry(42, 10, 28), 0x1f2933);
    crown.position.y = config.height + 40;
    const tie = this.mesh(new THREE.BoxGeometry(10, 30, 5), 0xffd166);
    tie.position.set(0, 58, 24);
    const briefcase = this.mesh(new THREE.BoxGeometry(18, 30, 28), 0x27170f);
    briefcase.position.set(-43, 38, 4);
    const rightArm = this.mesh(new THREE.BoxGeometry(13, 48, 13), 0x5a371c);
    rightArm.position.set(42, 54, 10);
    rightArm.rotation.x = -0.45;
    const warning = createDynamicPointLight("boss", 0xff7a1a, 0.48, 210, 1.7);
    warning.position.y = 84;
    group.add(body, coat, head, snout, leftHorn, rightHorn, crown, tie, briefcase, rightArm, warning);
  }

  private createEnemyHealthBar(width: number, color: number) {
    const group = new THREE.Group();
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 7, 8),
      new THREE.MeshBasicMaterial({ color: 0x070b0a, transparent: true, opacity: 0.82, depthWrite: false }),
    );
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 4.5),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    const shine = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 1.4),
      new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    fill.userData.width = width;
    fill.position.z = 0.2;
    shine.position.set(0, 1.1, 0.3);
    group.add(background, fill, shine);
    group.renderOrder = 40;
    group.visible = false;
    return group;
  }

  private updateEnemies(delta: number) {
    this.enemyAi.updateCrowd(
      delta,
      this.navigation,
      this.playerState.x,
      this.playerState.z,
      PLAYER_CONFIG.radius,
    );

    for (const enemy of this.enemies) {
      if (enemy.ai.state === "spawning") continue;
      const behavior = this.enemyAi.updateBehavior(enemy.ai, this.navigation, {
        now: this.elapsed,
        x: enemy.group.position.x,
        z: enemy.group.position.z,
        radius: enemy.radius,
        playerX: this.playerState.x,
        playerZ: this.playerState.z,
        playerRadius: PLAYER_CONFIG.radius,
      });
      const direction = this.enemyAi.getMovementDirection(enemy.ai, this.navigation, {
        now: this.elapsed,
        x: enemy.group.position.x,
        z: enemy.group.position.z,
        targetX: behavior.targetX,
        targetZ: behavior.targetZ,
        flowTargetX: behavior.flowTargetX,
        flowTargetZ: behavior.flowTargetZ,
        radius: enemy.radius,
        separationX: enemy.ai.separationX,
        separationZ: enemy.ai.separationZ,
      });
      const moveX = direction.x;
      const moveZ = direction.z;

      const movementLength = Math.hypot(moveX, moveZ);
      const length = Math.max(movementLength, 0.001);
      const nextPosition = this.navigation.moveCircle(
        enemy.group.position.x,
        enemy.group.position.z,
        (moveX / length) * enemy.speed * behavior.speedMultiplier * delta,
        (moveZ / length) * enemy.speed * behavior.speedMultiplier * delta,
        enemy.radius,
      );
      enemy.group.position.x = nextPosition.x;
      enemy.group.position.z = nextPosition.z;
      this.enemyAi.recordMovement(enemy.ai, {
        now: this.elapsed,
        x: nextPosition.x,
        z: nextPosition.z,
        targetX: behavior.targetX,
        targetZ: behavior.targetZ,
        desiredVelocityX: moveX * behavior.speedMultiplier,
        desiredVelocityZ: moveZ * behavior.speedMultiplier,
      }, ENEMY_CONFIG[enemy.kind].height);
      turnCharacterTowardMovement(enemy.group, moveX, moveZ, delta);
      enemy.visual.setMovement(moveX * behavior.speedMultiplier, moveZ * behavior.speedMultiplier);
      enemy.visual.update(delta);

      const contactDistance = this.distanceToPlayer(enemy.group.position.x, enemy.group.position.z);
      if (
        behavior.canAttack
        && contactDistance < PLAYER_CONFIG.radius + enemy.radius
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

    this.enemyAi.resolveCrowdOverlaps(this.navigation);
    for (const enemy of this.enemies) {
      if (enemy.ai.state === "spawning") continue;
      enemy.group.position.x = enemy.ai.currentX;
      enemy.group.position.z = enemy.ai.currentZ;
      this.updateEnemyVisualState(enemy);
    }
  }

  private updateEnemyVisualState(enemy: Enemy) {
    const config = ENEMY_CONFIG[enemy.kind];
    const barHeight = config.height + (enemy.kind === "boss" ? 58 : 28);
    enemy.healthBar.position.set(enemy.group.position.x, barHeight, enemy.group.position.z);
    enemy.healthBar.lookAt(this.camera.position);

    const healthRatio = THREE.MathUtils.clamp(enemy.hp / enemy.maxHp, 0, 1);
    const fillWidth = enemy.healthFill.userData.width as number;
    enemy.healthFill.scale.x = healthRatio;
    enemy.healthFill.position.x = -(fillWidth * (1 - healthRatio)) / 2;
    const shine = enemy.healthBar.children[2];
    shine.scale.x = healthRatio;
    shine.position.x = enemy.healthFill.position.x;
    enemy.healthBar.visible = enemy.kind === "boss" || enemy.hp < enemy.maxHp || this.distanceToPlayer(enemy.group.position.x, enemy.group.position.z) < 360;

    const hitAlpha = THREE.MathUtils.clamp((enemy.hitFlashUntil - this.elapsed) / 0.14, 0, 1);
    enemy.group.scale.setScalar(1 + hitAlpha * 0.13);
    if (hitAlpha <= 0 && !enemy.hitFlashActive) return;
    enemy.hitFlashActive = hitAlpha > 0;
    enemy.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.emissive.setHex(hitAlpha > 0 ? 0xfff1b8 : 0x000000);
        material.emissiveIntensity = hitAlpha * 0.72;
      }
    });
  }

  private updateWeapon(input: InputState) {
    const update = this.weapon.update(this.elapsed, input.fireHeld, input.reloadPressed);
    let shotAim: { x: number; z: number } | undefined;
    if (update.reloadStarted) {
      this.pendingShotAim = undefined;
      this.playerVisual?.stopOneShot("shoot");
    }
    if (update.shotStarted) {
      this.pendingShotAim = { x: input.aimX, z: input.aimZ };
      this.playerVisual?.playOneShot("shoot");
    }
    if (update.fired) {
      shotAim = this.pendingShotAim ?? { x: input.aimX, z: input.aimZ };
      this.pendingShotAim = undefined;
    }
    if (update.reloadStarted && this.elapsed >= this.nextWeaponHintAt) {
      this.nextWeaponHintAt = this.elapsed + 0.8;
      this.showHint("换弹中");
    }
    if (update.dryFire && this.elapsed >= this.nextWeaponHintAt) {
      this.nextWeaponHintAt = this.elapsed + 1.2;
      this.showHint("没子弹了，去找弹药箱");
    }
    this.removeDeadEnemies();
    return shotAim;
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
    const disposedGeometries = new WeakSet<THREE.BufferGeometry>();
    const disposedMaterials = new WeakSet<THREE.Material>();
    root.traverse((object) => {
      if (object instanceof THREE.Sprite) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material.userData.shared || disposedMaterials.has(material)) continue;
          material.dispose();
          disposedMaterials.add(material);
        }
        return;
      }
      if (!(object instanceof THREE.Mesh)) return;
      if (!object.geometry.userData.shared && !disposedGeometries.has(object.geometry)) {
        object.geometry.dispose();
        disposedGeometries.add(object.geometry);
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.userData.shared || disposedMaterials.has(material)) continue;
        material.dispose();
        disposedMaterials.add(material);
      }
    });
  }

  private fireWeapon(directionX: number, directionZ: number) {
    this.enemyAi.notifyGunshot(this.playerState.x, this.playerState.z, this.elapsed);
    const stats = this.weapon.getAttackStats();
    const spreadOffset = THREE.MathUtils.randFloatSpread(THREE.MathUtils.degToRad(stats.spreadDegrees));
    const spreadCos = Math.cos(spreadOffset);
    const spreadSin = Math.sin(spreadOffset);
    const shotDirectionX = directionX * spreadCos - directionZ * spreadSin;
    const shotDirectionZ = directionX * spreadSin + directionZ * spreadCos;
    const critical = Math.random() < stats.criticalChance;
    const originX = this.playerState.x + shotDirectionX * 34;
    const originZ = this.playerState.z + shotDirectionZ * 34;
    const hitCount = this.resolveAttack({
      sourceId: "player",
      weaponId: DEFAULT_WEAPON.id,
      mode: DEFAULT_WEAPON.attackMode,
      originX,
      originZ,
      directionX: shotDirectionX,
      directionZ: shotDirectionZ,
      range: DEFAULT_WEAPON.range,
      damage: stats.damage * (critical ? stats.criticalMultiplier : 1),
      maxHits: 1,
    });
    if (critical && hitCount > 0) this.showFloating("暴击", "#fde68a");
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
      this.enemies.filter((enemy) => enemy.hp > 0 && enemy.ai.state !== "spawning").map((enemy) => ({
        target: enemy,
        x: enemy.group.position.x,
        z: enemy.group.position.z,
        radius: enemy.radius,
      })),
      request.maxHits,
    );

    for (const hit of trace.hits) {
      hit.target.hp -= request.damage;
      hit.target.hitFlashUntil = this.elapsed + 0.14;
      this.enemyAi.notifyHit(
        hit.target.ai,
        this.playerState.x,
        this.playerState.z,
        this.elapsed,
      );
      this.updateEnemyVisualState(hit.target);
    }

    const endX = request.originX + request.directionX * trace.endDistance;
    const endZ = request.originZ + request.directionZ * trace.endDistance;
    const lastHit = trace.hits.at(-1);
    const impact = lastHit
      ? { x: lastHit.x, z: lastHit.z, color: ENEMY_CONFIG[lastHit.target.kind].color }
      : obstacleDistance < request.range
        ? { x: endX, z: endZ, color: 0xd8d4c8 }
        : undefined;
    const visualOrigin = this.playerVisual?.muzzleSocket
      ? this.playerVisual.muzzleSocket.getWorldPosition(this.muzzleWorldPosition)
      : this.muzzleWorldPosition.set(request.originX, 40, request.originZ);
    const forwardDistance = (endX - visualOrigin.x) * request.directionX
      + (endZ - visualOrigin.z) * request.directionZ;
    if (forwardDistance > 1) {
      this.createBulletVisual(
        visualOrigin, request.directionX, request.directionZ, forwardDistance, impact,
      );
    } else if (impact) {
      this.createImpactEffect(impact.x, impact.z, impact.color);
    }
    this.createMuzzleFlash(visualOrigin, request.directionX, request.directionZ);
    this.cameraKick = Math.min(7, this.cameraKick + 2.2);
    return trace.hits.length;
  }

  private createBulletVisual(
    origin: THREE.Vector3,
    directionX: number,
    directionZ: number,
    distance: number,
    impact?: BulletVisual["impact"],
  ) {
    if (this.bulletVisuals.length >= BULLET_VISUAL.maxActive) {
      const oldest = this.bulletVisuals.shift();
      if (oldest) this.disposeObject(oldest.group);
    }

    const direction = new THREE.Vector3(directionX, 0, directionZ);
    if (distance < 0.001) {
      if (impact) this.createImpactEffect(impact.x, impact.z, impact.color);
      return;
    }
    direction.normalize();
    const length = Math.max(8, Math.min(BULLET_VISUAL.length, distance * 0.72));
    const group = new THREE.Group();
    const glow = new THREE.Mesh(
      new THREE.CapsuleGeometry(BULLET_VISUAL.radius * 1.45, length * 1.18, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb84d, transparent: true, opacity: 0.36, depthWrite: false }),
    );
    const core = new THREE.Mesh(
      new THREE.CapsuleGeometry(BULLET_VISUAL.radius * 0.42, length * 0.72, 4, 8),
      new THREE.MeshStandardMaterial({
        color: 0xfff0b6,
        emissive: 0xff8f00,
        emissiveIntensity: 2.6,
        metalness: 0.5,
        roughness: 0.25,
      }),
    );
    const light = createDynamicPointLight("bullet", 0xffb84d, 0.35, 120, 2);
    group.add(glow, core, light);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    group.position.set(
      origin.x + direction.x * (length / 2),
      origin.y,
      origin.z + direction.z * (length / 2),
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
      if (bullet.impact) this.createImpactEffect(bullet.impact.x, bullet.impact.z, bullet.impact.color);
      completed.push(bullet);
    }
    for (const bullet of completed) this.disposeObject(bullet.group);
    if (completed.length > 0) this.bulletVisuals = this.bulletVisuals.filter((bullet) => !completed.includes(bullet));
  }

  private createMuzzleFlash(origin: THREE.Vector3, directionX: number, directionZ: number) {
    const flash = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(8, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff0a3, transparent: true, opacity: 1, depthWrite: false }),
    );
    const bloom = new THREE.Mesh(
      new THREE.SphereGeometry(18, 10, 8),
      new THREE.MeshBasicMaterial({ color: COLORS.muzzle, transparent: true, opacity: 0.34, depthWrite: false }),
    );
    const spark = new THREE.Mesh(
      new THREE.ConeGeometry(9, 38, 8),
      new THREE.MeshBasicMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.82, depthWrite: false }),
    );
    spark.rotation.x = Math.PI / 2;
    spark.position.z = 18;
    const light = createDynamicPointLight("muzzle", 0xffbd55, 1.35, 165, 1.8);
    flash.add(bloom, core, spark, light);
    flash.position.copy(origin);
    flash.rotation.y = Math.atan2(directionX, directionZ);
    this.scene.add(flash);
    this.shotEffects.push({ object: flash, life: 0.075, maxLife: 0.075 });
  }

  private updateShotEffects(delta: number) {
    for (const effect of this.shotEffects) {
      effect.life -= delta;
      const opacity = Math.max(0, effect.life / effect.maxLife);
      effect.object.scale.setScalar(0.72 + opacity * 0.6);
      effect.object.traverse((object) => {
        if (object instanceof THREE.PointLight) {
          object.intensity *= opacity;
          return;
        }
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if ("opacity" in material) {
            material.transparent = true;
            material.opacity = opacity;
          }
        }
      });
    }
    const expired = this.shotEffects.filter((effect) => effect.life <= 0);
    for (const effect of expired) {
      this.disposeObject(effect.object);
    }
    this.shotEffects = this.shotEffects.filter((effect) => effect.life > 0);
  }

  private createImpactEffect(x: number, z: number, color: number) {
    this.emitParticles(x, 34, z, color, 7, 58);
    this.emitParticles(x, 28, z, 0xffd166, 4, 38);
    this.addFloorDecal(x, z, THREE.MathUtils.randFloat(10, 18), 0x080b0a, 0.22, true);

    const flash = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(10, 18, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe6a3, transparent: true, opacity: 0.58, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    const light = createDynamicPointLight("impact", 0xffc65a, 0.65, 130, 1.8);
    light.position.y = 18;
    flash.add(ring, light);
    flash.position.set(x, 9, z);
    this.scene.add(flash);
    this.shotEffects.push({ object: flash, life: 0.12, maxLife: 0.12 });
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
      if (enemy.kind === "boss" && this.bossAlertBeacon) {
        this.disposeObject(this.bossAlertBeacon);
        this.bossAlertBeacon = undefined;
      }
      this.enemyAi.remove(enemy.ai, this.elapsed);
      enemy.visual.dispose();
      this.disposeObject(enemy.group);
      this.disposeObject(enemy.healthBar);
    }
    if (dead.length > 0) this.enemies = this.enemies.filter((enemy) => enemy.hp > 0);
  }

  private gainExp(amount: number) {
    this.playerState.exp += amount;
    while (this.playerState.exp >= this.playerState.expToNext) {
      this.playerState.exp -= this.playerState.expToNext;
      this.playerState.level += 1;
      this.playerState.expToNext = getExpToNext(this.playerState.level);
      this.pendingLevelUps += 1;
    }
  }

  private tryOpenUpgradePanel() {
    if (this.gameState !== "playing" || this.pendingLevelUps <= 0) return;
    this.openUpgradePanel();
  }

  private openUpgradePanel() {
    const available = (Object.keys(this.weaponUpgradeLevels) as WeaponUpgradeId[])
      .filter((id) => this.weaponUpgradeLevels[id] < 5);
    if (available.length === 0) {
      this.pendingLevelUps = 0;
      this.closeUpgradePanel();
      return;
    }

    for (let index = available.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [available[index], available[swapIndex]] = [available[swapIndex], available[index]];
    }
    this.currentUpgradeChoices = available.slice(0, 3);
    this.renderUpgradeChoices();
    this.hud.upgradePanel.classList.add("is-visible");
    if (this.gameState === "playing") this.transitionTo("levelUpPaused");
  }

  private renderUpgradeChoices() {
    this.hud.upgradeOptions.replaceChildren();
    for (const [index, id] of this.currentUpgradeChoices.entries()) {
      const definition = WEAPON_UPGRADE_DEFINITIONS[id];
      const currentLevel = this.weaponUpgradeLevels[id];
      const button = document.createElement("button");
      button.className = "upgrade-option";
      button.type = "button";
      button.innerHTML = `
        <span class="upgrade-key">${index + 1}</span>
        <span class="upgrade-name">${definition.title}</span>
        <span class="upgrade-level">Lv ${currentLevel} → Lv ${currentLevel + 1}</span>
        <span class="upgrade-description">${definition.descriptions[currentLevel]}</span>
      `;
      button.addEventListener("click", () => this.selectWeaponUpgrade(id));
      this.hud.upgradeOptions.append(button);
    }
  }

  private selectWeaponUpgrade(id: WeaponUpgradeId) {
    if (this.gameState !== "levelUpPaused" || !this.currentUpgradeChoices.includes(id)) return;
    this.weaponUpgradeLevels[id] = Math.min(5, this.weaponUpgradeLevels[id] + 1);
    this.weapon.applyStats(getWeaponRuntimeStats(this.weaponUpgradeLevels));
    this.pendingLevelUps = Math.max(0, this.pendingLevelUps - 1);
    const definition = WEAPON_UPGRADE_DEFINITIONS[id];
    this.showHint(`${definition.title} Lv ${this.weaponUpgradeLevels[id]}`);

    if (this.pendingLevelUps > 0) {
      this.openUpgradePanel();
    } else {
      this.closeUpgradePanel();
    }
  }

  private closeUpgradePanel() {
    this.currentUpgradeChoices = [];
    this.hud.upgradePanel.classList.remove("is-visible");
    if (this.gameState === "levelUpPaused") this.transitionTo("playing");
  }

  private onUpgradeKeyDown = (event: KeyboardEvent) => {
    if (this.gameState !== "levelUpPaused") return;
    const index = ["Digit1", "Digit2", "Digit3"].indexOf(event.code);
    if (index < 0 || index >= this.currentUpgradeChoices.length) return;
    event.preventDefault();
    this.selectWeaponUpgrade(this.currentUpgradeChoices[index]);
  };

  private spawnAccessCard() {
    this.accessCard = new THREE.Group();
    const card = this.mesh(new THREE.BoxGeometry(46, 8, 30), COLORS.accessCard);
    card.position.y = 18;
    const glow = createDynamicPointLight("objective", COLORS.accessCard, 0.85, 210, 1.6);
    glow.position.y = 44;
    this.accessCard.add(card, glow);
    this.accessCard.position.set(270, 0, 400);
    this.scene.add(this.accessCard);
    this.accessCardBeacon = this.createObjectiveBeacon(270, 400, COLORS.accessCard, 46);
  }

  private updateAccessCard() {
    if (!this.accessCard || this.hasAccessCard) return;
    this.accessCard.rotation.y += 0.04;
    this.accessCard.position.y = Math.sin(this.elapsed * 3) * 5;
    if (this.distanceToPlayer(this.accessCard.position.x, this.accessCard.position.z) <= PLAYER_CONFIG.radius + 30) {
      this.hasAccessCard = true;
      this.scene.remove(this.accessCard);
      this.accessCard = undefined;
      if (this.accessCardBeacon) {
        this.disposeObject(this.accessCardBeacon);
        this.accessCardBeacon = undefined;
      }
      this.showHint(this.elevatorOpen ? "门禁卡已获得，快去电梯" : "门禁卡已获得，等待电梯开放");
      this.showFloating("门禁卡", "#fff5c2");
    }
  }

  private createObjectiveBeacon(x: number, z: number, color: number, radius: number) {
    const group = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.28, radius * 0.52, 180, 24, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.y = 90;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.72, radius, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 10;
    const core = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 0.22, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, depthWrite: false }),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = 10.2;
    const light = createDynamicPointLight("objective", color, 0.86, 260, 1.6);
    light.position.y = 58;
    group.add(beam, ring, core, light);
    group.position.set(x, 0, z);
    group.renderOrder = 12;
    this.scene.add(group);
    return group;
  }

  private updateObjectiveBeacons(delta: number) {
    const time = this.elapsed * 2.4;
    for (const beacon of [this.accessCardBeacon, this.elevatorBeacon, this.bossAlertBeacon]) {
      if (!beacon) continue;
      const pulse = 0.92 + Math.sin(time) * 0.08;
      beacon.rotation.y += delta * 0.9;
      beacon.children[1].scale.setScalar(pulse);
      beacon.children[2].scale.setScalar(0.75 + Math.sin(time + 0.8) * 0.12);
      const light = beacon.children[3];
      if (light instanceof THREE.PointLight) light.intensity = 0.68 + Math.sin(time + 1.2) * 0.18;
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
    while (this.particles.length + count > MAX_ACTIVE_PARTICLES) {
      const oldest = this.particles.shift();
      if (oldest) this.disposeParticle(oldest);
    }

    for (let i = 0; i < count; i += 1) {
      const mesh = new THREE.Mesh(
        this.particleGeometry,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false }),
      );
      const size = THREE.MathUtils.randFloat(2, 5);
      mesh.scale.setScalar(size);
      mesh.position.set(x, y, z);
      const angle = Math.random() * Math.PI * 2;
      const speed = THREE.MathUtils.randFloat(spread * 0.8, spread * 1.4);
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, THREE.MathUtils.randFloat(40, 120), Math.sin(angle) * speed);
      this.scene.add(mesh);
      this.particles.push({ mesh, velocity, size, life: 0.45, maxLife: 0.45 });
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
      particle.mesh.scale.setScalar(particle.size * alpha);
    }

    const expired = this.particles.filter((particle) => particle.life <= 0);
    for (const particle of expired) this.disposeParticle(particle);
    this.particles = this.particles.filter((particle) => particle.life > 0);
  }

  private disposeParticle(particle: Particle) {
    this.scene.remove(particle.mesh);
    const materials = Array.isArray(particle.mesh.material) ? particle.mesh.material : [particle.mesh.material];
    for (const material of materials) material.dispose();
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

  private showAlert(message: string) {
    this.bossAlertUntil = this.elapsed + 3.4;
    this.hud.alert.textContent = message;
    this.hud.alert.classList.add("is-visible");
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
    this.hud.weaponPanel.classList.toggle("is-low-ammo", weapon.magazineAmmo <= Math.ceil(weapon.magazineSize * 0.25) && weapon.reserveAmmo > 0 && !weapon.isReloading);

    const mission = this.getMissionStatus();
    this.hud.missionTitle.textContent = mission.title;
    this.hud.missionBody.textContent = mission.body;
    this.hud.missionMeta.textContent = mission.meta;
    this.hud.root.classList.toggle("is-low-health", this.playerState.hp / this.playerState.maxHp <= 0.28);
    this.hud.alert.classList.toggle("is-visible", this.elapsed < this.bossAlertUntil);
  }

  private getMissionStatus() {
    if (this.gameState === "success") {
      return { title: "任务完成", body: "已成功撤离办公室", meta: "SAFE" };
    }
    if (this.gameState === "failed") {
      return { title: "任务失败", body: "今日下班失败", meta: "FAILED" };
    }
    if (this.bossSpawned) {
      return { title: "立即撤离", body: this.hasAccessCard ? "前往 EXIT 区域，坚持到进度完成" : "先拿门禁卡，再冲向电梯", meta: "BOSS" };
    }
    if (this.elevatorOpen && this.hasAccessCard) {
      return { title: "前往电梯", body: "跟随地面路线进入 EXIT 区域", meta: "EXIT OPEN" };
    }
    if (this.elevatorOpen) {
      return { title: "缺少门禁卡", body: "先取得黄色光柱处的门禁卡", meta: "CARD NEEDED" };
    }
    if (this.hasAccessCard) {
      return { title: "等待电梯", body: `电梯将在 ${Math.max(0, Math.ceil(80 - this.elapsed))} 秒后开放`, meta: "HOLD" };
    }
    if (this.accessCard) {
      return { title: "取得门禁卡", body: "前往黄色光柱处拾取门禁卡", meta: "CARD" };
    }
    return {
      title: "拿门禁卡，乘电梯撤离",
      body: "存活到电梯开放，进入 EXIT 区域完成撤离",
      meta: "门禁卡 → 电梯 → 下班",
    };
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
    const isLevelEntry = this.gameState === "ready" && nextState === "playing";
    this.gameState = nextState;
    this.hud.root.dataset.gameState = nextState;
    if (isLevelEntry) this.hud.missionPanel.classList.add("is-intro-visible");
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

  private texturedBox(width: number, height: number, depth: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private meshWithMaterial(geometry: THREE.BufferGeometry, material: THREE.Material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private mesh(geometry: THREE.BufferGeometry, color: number, opacity = 1) {
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.72,
      metalness: 0.04,
      transparent: opacity < 1,
      opacity,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private characterMaterial(key: keyof typeof CHARACTER_TEXTURE_URLS, tint = 0xffffff, roughness = 0.78) {
    const cacheKey = `character-${key}-${tint}-${roughness}`;
    const cached = this.materialCache.get(cacheKey);
    if (cached) return cached;

    const texture = this.textureLoader.load(CHARACTER_TEXTURE_URLS[key]);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    const material = new THREE.MeshStandardMaterial({
      color: tint,
      map: texture,
      roughness,
      metalness: 0.02,
    });
    material.userData.shared = true;
    this.materialCache.set(cacheKey, material);
    return material;
  }

  private characterInstanceMaterial(key: keyof typeof CHARACTER_TEXTURE_URLS, tint = 0xffffff, roughness = 0.78) {
    const material = this.characterMaterial(key, tint, roughness).clone();
    material.userData.shared = false;
    return material;
  }

  private surfaceMaterial(
    key: string,
    color: number,
    accent: number,
    opacity: number,
    style: SurfaceStyle = "concrete",
    repeatX = 1,
    repeatY = 1,
  ) {
    const cacheKey = `${key}-${color}-${accent}-${opacity}-${style}-${repeatX}-${repeatY}`;
    const cached = this.materialCache.get(cacheKey);
    if (cached) return cached;

    const assetTexture = this.assetSurfaceTexture(style, repeatX, repeatY);
    const texture = assetTexture ?? this.surfaceTexture(cacheKey, color, accent, style, repeatX, repeatY);
    const material = new THREE.MeshStandardMaterial({
      color: assetTexture ? this.surfaceTint(color) : 0xffffff,
      map: texture,
      roughness: style === "metal" ? 0.56 : style === "plastic" ? 0.62 : 0.88,
      metalness: style === "metal" ? 0.34 : 0.02,
      transparent: opacity < 1,
      opacity,
    });
    material.userData.shared = true;
    this.materialCache.set(cacheKey, material);
    return material;
  }

  private assetSurfaceTexture(style: SurfaceStyle, repeatX: number, repeatY: number) {
    const url = TEXTURE_URLS[style];
    if (!url) return undefined;
    const cacheKey = `asset-${style}-${repeatX}-${repeatY}`;
    const cached = this.textureCache.get(cacheKey);
    if (cached) return cached;

    const texture = this.textureLoader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.textureCache.set(cacheKey, texture);
    return texture;
  }

  private surfaceTint(color: number) {
    return new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.34);
  }

  private surfaceTexture(key: string, color: number, accent: number, style: SurfaceStyle, repeatX: number, repeatY: number) {
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d")!;
    const base = new THREE.Color(color);
    const detail = new THREE.Color(accent);
    const rng = this.seededRandom(key);

    context.fillStyle = this.colorToCss(base);
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.drawSurfacePattern(context, base, detail, style, rng);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.textureCache.set(key, texture);
    return texture;
  }

  private drawSurfacePattern(
    context: CanvasRenderingContext2D,
    base: THREE.Color,
    detail: THREE.Color,
    style: SurfaceStyle,
    rng: () => number,
  ) {
    if (style === "wood") {
      this.drawWoodPattern(context, base, detail, rng);
    } else if (style === "wall") {
      this.drawWallPattern(context, base, detail, rng);
    } else if (style === "metal") {
      this.drawMetalPattern(context, base, detail, rng);
    } else if (style === "tile") {
      this.drawTilePattern(context, base, detail, rng);
    } else if (style === "carpet") {
      this.drawCarpetPattern(context, base, detail, rng);
    } else if (style === "plastic") {
      this.drawPlasticPattern(context, base, detail, rng);
    } else if (style === "paper") {
      this.drawPaperPattern(context, base, detail, rng);
    } else {
      this.drawConcretePattern(context, base, detail, rng);
    }
  }

  private drawConcretePattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    this.drawSpeckles(context, base, detail, rng, 640, 0.1);
    context.globalAlpha = 0.12;
    context.strokeStyle = this.colorToCss(detail);
    for (let line = 0; line < 14; line += 1) {
      const x = rng() * 256;
      const y = rng() * 256;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + rng() * 86 - 43, y + rng() * 24 - 12);
      context.stroke();
    }
  }

  private drawTilePattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    const tile = 64;
    context.globalAlpha = 0.4;
    context.strokeStyle = "rgba(8, 12, 10, 0.52)";
    context.lineWidth = 3;
    for (let position = 0; position <= 256; position += tile) {
      context.beginPath();
      context.moveTo(position, 0);
      context.lineTo(position, 256);
      context.moveTo(0, position);
      context.lineTo(256, position);
      context.stroke();
    }
    context.lineWidth = 1;
    context.globalAlpha = 0.16;
    context.strokeStyle = this.colorToCss(detail);
    for (let position = tile / 2; position < 256; position += tile) {
      context.beginPath();
      context.moveTo(position, 0);
      context.lineTo(position, 256);
      context.moveTo(0, position);
      context.lineTo(256, position);
      context.stroke();
    }
    this.drawSpeckles(context, base, detail, rng, 360, 0.08);
  }

  private drawCarpetPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    this.drawSpeckles(context, base, detail, rng, 940, 0.08);
    context.globalAlpha = 0.13;
    context.strokeStyle = this.colorToCss(detail);
    context.lineWidth = 1;
    for (let y = 0; y < 256; y += 6) {
      context.beginPath();
      context.moveTo(0, y + rng() * 2);
      context.lineTo(256, y + rng() * 2);
      context.stroke();
    }
    context.globalAlpha = 0.08;
    for (let x = 0; x < 256; x += 18) {
      context.fillStyle = this.colorToCss(base.clone().offsetHSL(0, 0, rng() * 0.1 - 0.05));
      context.fillRect(x, 0, 4, 256);
    }
  }

  private drawWallPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    this.drawSpeckles(context, base, detail, rng, 380, 0.08);
    context.globalAlpha = 0.2;
    context.strokeStyle = "rgba(255, 247, 214, 0.35)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, 120);
    context.lineTo(256, 120);
    context.stroke();
    context.globalAlpha = 0.16;
    context.strokeStyle = this.colorToCss(detail);
    for (let crack = 0; crack < 8; crack += 1) {
      const x = rng() * 256;
      const y = rng() * 256;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + rng() * 28 - 14, y + rng() * 44);
      context.lineTo(x + rng() * 38 - 19, y + 32 + rng() * 40);
      context.stroke();
    }
    context.globalAlpha = 0.1;
    context.fillStyle = this.colorToCss(detail.clone().offsetHSL(0, -0.1, -0.12));
    for (let stain = 0; stain < 9; stain += 1) {
      context.beginPath();
      context.ellipse(rng() * 256, rng() * 256, 8 + rng() * 24, 5 + rng() * 16, rng() * Math.PI, 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawWoodPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    const gradient = context.createLinearGradient(0, 0, 256, 0);
    gradient.addColorStop(0, this.colorToCss(base.clone().offsetHSL(0, 0.04, -0.08)));
    gradient.addColorStop(0.5, this.colorToCss(base));
    gradient.addColorStop(1, this.colorToCss(detail.clone().offsetHSL(0, -0.03, -0.04)));
    context.globalAlpha = 1;
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 12) {
      context.globalAlpha = 0.18 + rng() * 0.12;
      context.strokeStyle = this.colorToCss(detail.clone().offsetHSL(0, 0, rng() * 0.14 - 0.12));
      context.lineWidth = 2 + rng() * 3;
      context.beginPath();
      context.moveTo(0, y + rng() * 6);
      for (let x = 0; x <= 256; x += 32) {
        context.lineTo(x, y + Math.sin(x * 0.035 + rng() * 2) * 7 + rng() * 5);
      }
      context.stroke();
    }
    context.globalAlpha = 0.22;
    for (let knot = 0; knot < 5; knot += 1) {
      context.strokeStyle = this.colorToCss(detail.clone().offsetHSL(0, 0, -0.18));
      context.lineWidth = 2;
      context.beginPath();
      context.ellipse(rng() * 256, rng() * 256, 10 + rng() * 16, 4 + rng() * 6, rng() * Math.PI, 0, Math.PI * 2);
      context.stroke();
    }
  }

  private drawMetalPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    const gradient = context.createLinearGradient(0, 0, 256, 256);
    gradient.addColorStop(0, this.colorToCss(base.clone().offsetHSL(0, -0.05, 0.12)));
    gradient.addColorStop(0.45, this.colorToCss(base));
    gradient.addColorStop(1, this.colorToCss(detail.clone().offsetHSL(0, -0.08, -0.1)));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    context.globalAlpha = 0.18;
    context.strokeStyle = "rgba(255, 255, 255, 0.55)";
    context.lineWidth = 1;
    for (let y = 0; y < 256; y += 7) {
      context.beginPath();
      context.moveTo(0, y + rng() * 2);
      context.lineTo(256, y + rng() * 2);
      context.stroke();
    }
    context.globalAlpha = 0.2;
    context.fillStyle = "rgba(0, 0, 0, 0.5)";
    for (let rivet = 0; rivet < 10; rivet += 1) {
      context.beginPath();
      context.arc(18 + (rivet % 5) * 54, 30 + Math.floor(rivet / 5) * 178, 3, 0, Math.PI * 2);
      context.fill();
    }
  }

  private drawPlasticPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    this.drawSpeckles(context, base, detail, rng, 260, 0.07);
    context.globalAlpha = 0.22;
    context.fillStyle = this.colorToCss(detail);
    context.fillRect(22, 20, 76, 142);
    context.globalAlpha = 0.16;
    context.fillStyle = "rgba(255, 255, 255, 0.7)";
    context.fillRect(32, 30, 54, 8);
    context.globalAlpha = 0.2;
    for (let slot = 0; slot < 5; slot += 1) {
      context.fillStyle = slot % 2 === 0 ? "rgba(5, 10, 8, 0.68)" : this.colorToCss(detail.clone().offsetHSL(0, 0.08, 0.04));
      context.fillRect(128, 32 + slot * 32, 86, 14);
    }
  }

  private drawPaperPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    context.fillStyle = this.colorToCss(base);
    context.fillRect(0, 0, 256, 256);
    this.drawSpeckles(context, base, detail, rng, 220, 0.06);
    context.globalAlpha = 0.22;
    context.strokeStyle = this.colorToCss(detail);
    context.lineWidth = 2;
    for (let y = 48; y < 214; y += 24) {
      context.beginPath();
      context.moveTo(34, y);
      context.lineTo(220, y + rng() * 4 - 2);
      context.stroke();
    }
    context.globalAlpha = 0.12;
    context.strokeRect(18, 18, 220, 220);
  }

  private drawSpeckles(
    context: CanvasRenderingContext2D,
    base: THREE.Color,
    detail: THREE.Color,
    rng: () => number,
    count: number,
    alpha: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      const value = rng() > 0.48 ? detail : base.clone().offsetHSL(0, 0, rng() * 0.2 - 0.1);
      context.globalAlpha = alpha * (0.45 + rng());
      context.fillStyle = this.colorToCss(value);
      context.fillRect(Math.floor(rng() * 256), Math.floor(rng() * 256), 1 + Math.floor(rng() * 3), 1 + Math.floor(rng() * 3));
    }
  }

  private colorToCss(color: THREE.Color) {
    return `#${color.getHexString()}`;
  }

  private seededRandom(key: string) {
    let seed = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      seed ^= key.charCodeAt(index);
      seed = Math.imul(seed, 16777619);
    }
    return () => {
      seed += 0x6d2b79f5;
      let value = seed;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  private addFloorDecal(x: number, z: number, radius: number, color: number, opacity: number, trackImpact = false) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    const decal = new THREE.Mesh(new THREE.CircleGeometry(radius, 18), material);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(x, 8.2, z);
    decal.renderOrder = 2;
    this.scene.add(decal);

    if (!trackImpact) return;
    this.impactDecals.push(decal);
    if (this.impactDecals.length <= 28) return;
    const oldest = this.impactDecals.shift();
    if (oldest) this.disposeObject(oldest);
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
      <div class="minimap-panel">
        <canvas class="minimap-canvas" width="240" height="336" aria-label="实时地图"></canvas>
      </div>
      <div class="timer-panel">
        <div class="timer">120</div>
        <div class="timer-caption">距离下班</div>
      </div>
      <div class="hud-panel">
        <div class="status-header"><div class="level">Lv 1</div><div class="card">无卡</div></div>
        <div class="health-row">
          <div class="hp-label">HP 100/100</div>
          <div class="hp-track"><div class="hp-fill"></div></div>
        </div>
        <div class="exp-track"><div class="exp-fill"></div></div>
        <div class="weapon-panel">
          <div class="weapon-status">冲锋枪</div>
          <div class="ammo">20 / 80</div>
          <div class="reload-track"><div class="reload-fill"></div></div>
        </div>
      </div>
      <div class="mission-panel">
        <div class="mission-kicker">通关目标</div>
        <div class="mission-title">拿门禁卡，乘电梯撤离</div>
        <div class="mission-body">存活到电梯开放，进入 EXIT 区域完成撤离</div>
        <div class="mission-meta">门禁卡 → 电梯 → 下班</div>
      </div>
      <div class="alert-banner">老板来了，立即撤离</div>
      <div class="hint">距离下班还有 120 秒</div>
      <div class="evac"><div>正在下班</div><div class="evac-track"><div class="evac-fill"></div></div></div>
      <div class="objective-arrow"></div>
      <div class="objective-label"></div>
      <div class="joystick"><div class="joystick-knob"></div></div>
      <button class="fire-button" type="button" aria-label="射击" title="射击"><span class="fire-icon"></span></button>
      <button class="reload-button" type="button" aria-label="换弹" title="换弹">R</button>
      <div class="controls">WASD / 方向键移动并转向 · J / 左键射击 · R 换弹</div>
      <div class="upgrade-panel" role="dialog" aria-modal="true" aria-label="选择强化">
        <div class="upgrade-box">
          <div class="upgrade-title">选择一项强化</div>
          <div class="upgrade-subtitle">游戏已暂停</div>
          <div class="upgrade-options"></div>
        </div>
      </div>
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
      minimap: root.querySelector<HTMLCanvasElement>(".minimap-canvas")!,
      hpText: root.querySelector<HTMLDivElement>(".hp-label")!,
      hpBar: root.querySelector<HTMLDivElement>(".hp-fill")!,
      expBar: root.querySelector<HTMLDivElement>(".exp-fill")!,
      timer: root.querySelector<HTMLDivElement>(".timer")!,
      level: root.querySelector<HTMLDivElement>(".level")!,
      card: root.querySelector<HTMLDivElement>(".card")!,
      missionPanel: root.querySelector<HTMLDivElement>(".mission-panel")!,
      missionTitle: root.querySelector<HTMLDivElement>(".mission-title")!,
      missionBody: root.querySelector<HTMLDivElement>(".mission-body")!,
      missionMeta: root.querySelector<HTMLDivElement>(".mission-meta")!,
      alert: root.querySelector<HTMLDivElement>(".alert-banner")!,
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
      upgradePanel: root.querySelector<HTMLDivElement>(".upgrade-panel")!,
      upgradeOptions: root.querySelector<HTMLDivElement>(".upgrade-options")!,
      result: root.querySelector<HTMLDivElement>(".result")!,
      resultTitle: root.querySelector<HTMLDivElement>(".result-title")!,
    };
  }
}

new OfficeEscapeGame();
