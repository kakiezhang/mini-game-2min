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
  SUPPLY_CONFIG,
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
import { WeaponSystem, type WeaponSnapshot } from "./weapon";
import { EnemySpawnEffectSystem } from "./effects/enemy-spawn-effect";
import { ELEVATOR_FRAME_LAYOUT, type ElevatorBoxLayout } from "./elevator-layout";
import { chooseSupplyKind, pickSupplyPosition, type SupplyKind } from "./supplies";
import { AttackLoadout, ATTACK_MODE_LABELS, type AttackMode } from "./attack-modes";
import { MeleeSystem, type ActiveMelee } from "./melee";
import { COMBAT_ICONS } from "./ui/combat-icons";

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

type SupplyPickup = {
  group: THREE.Group;
  item: THREE.Group;
  kind: SupplyKind;
  amount: number;
  radius: number;
  source: "supply" | "drop";
  expiresAt: number;
  phase: number;
};

type GameState = "ready" | "playing" | "success" | "failed";
type SurfaceStyle = "concrete" | "tile" | "carpet" | "wall" | "wood" | "metal" | "plastic" | "paper";
const TEXTURE_URLS: Partial<Record<SurfaceStyle, string>> = {
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
  playing: ["success", "failed"],
  success: [],
  failed: [],
};

const MAX_ACTIVE_PARTICLES = 90;
const TOUCH_SHOT_HIT_MARGIN = 8;
const UPGRADE_OFFER_SECONDS = 5;

class OfficeEscapeGame {
  private readonly app = document.querySelector<HTMLDivElement>("#app")!;
  private readonly scene = new THREE.Scene();
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 5000);
  private readonly coarsePointer = window.matchMedia("(hover: none) and (pointer: coarse)");
  private readonly clock = new THREE.Clock();
  private readonly navigation = new NavigationWorld(MAP.width, MAP.depth);
  private readonly weapon = new WeaponSystem({ ...DEFAULT_WEAPON, initialReserveAmmo: 0 });
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
  private readonly crosshairScreenOrigin = new THREE.Vector3();
  private readonly crosshairScreenTarget = new THREE.Vector3();
  private enemies: Enemy[] = [];
  private particles: Particle[] = [];
  private shotEffects: ShotEffect[] = [];
  private bulletVisuals: BulletVisual[] = [];
  private impactDecals: THREE.Mesh[] = [];
  private supplies: SupplyPickup[] = [];
  private readonly loadout = new AttackLoadout();
  private readonly melee = new MeleeSystem();
  private get hasSmg() { return this.loadout.has("smg"); }
  private get isArmed() { return this.loadout.current === "smg"; }
  private nextSupplyAt: number = SUPPLY_CONFIG.respawnInterval;
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
  private moveSpeedMultiplier = 1;
  private lastHintTimer = 0;
  private nextWeaponHintAt = 0;
  private nextAmmoHintAt = 0;
  private cameraKick = 0;
  private playerInvincibleUntil = 0;
  private upgradePending = false;
  private currentUpgradeChoices: WeaponUpgradeId[] = [];
  private upgradeOfferId = 0;
  private upgradeOfferEndsAt = 0;
  private readonly weaponUpgradeLevels: WeaponUpgradeLevels = {
    firepowerCalibration: 0,
    magazineManagement: 0,
  };

  private readonly playerState = {
    x: 1200,
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
    this.scene.background = new THREE.Color(0xdcecf3);
    this.scene.fog = new THREE.Fog(0xdcecf3, 1500, 3400);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.app.append(this.renderer.domElement, this.hud.root);

    this.setupCamera();
    this.createLights();
    this.createMap();
    this.minimap.update(0, this.playerState, this.enemies);
    const charactersReady = Promise.all([
      this.createPlayer(),
      this.characterAssets.preload(CHARACTER_MODELS.player),
      this.characterAssets.preload(CHARACTER_MODELS.bug),
      this.characterAssets.preload(CHARACTER_MODELS.ppt),
      this.characterAssets.preload(CHARACTER_MODELS.changeRequest),
    ]);
    this.spawnSupply("smg", true);
    this.spawnSupply("ammo", true);
    this.spawnSupply("medkit", true);
    this.createCrosshair();
    this.input = new InputController(this.renderer.domElement, this.camera, {
      base: this.hud.joystickBase,
      knob: this.hud.joystickKnob,
    }, {
      fire: this.hud.fireButton, punch: this.hud.punchButton, kick: this.hud.kickButton,
      previous: this.hud.previousMode, next: this.hud.nextMode,
    });
    this.refreshAttackControls();
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
    this.camera.position.set(this.playerState.x + 620, 930, this.playerState.z + 940);
    this.camera.lookAt(this.playerState.x, 0, this.playerState.z);
  }

  private createLights() {
    const ambient = new THREE.HemisphereLight(0xf5faff, 0xb8c6b8, 1.65);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffefd6, 2.25);
    sun.position.set(-520, 980, 340);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00018;
    sun.shadow.normalBias = 0.035;
    sun.shadow.camera.left = -1600;
    sun.shadow.camera.right = 1600;
    sun.shadow.camera.top = 1200;
    sun.shadow.camera.bottom = -1200;
    sun.shadow.camera.near = 120;
    sun.shadow.camera.far = 2400;
    this.scene.add(sun);

    const rim = new THREE.DirectionalLight(0xd4edff, 0.72);
    rim.position.set(740, 420, 1180);
    this.scene.add(rim);

    this.addAreaLight(270, 280, 0xffead0, 0.55);
    this.addAreaLight(810, 840, 0xffead0, 0.52);
    this.addAreaLight(1390, 840, 0xe4f3ff, 0.5);
    this.addAreaLight(540, 1440, 0xe4f3ff, 0.56);
  }

  private addAreaLight(x: number, z: number, color: number, intensity: number) {
    const light = new THREE.PointLight(color, intensity, 520, 1.4);
    light.position.set(x, 120, z);
    this.scene.add(light);
  }

  private createMap() {
    const ground = this.texturedBox(MAP.width, 8, MAP.depth, this.surfaceMaterial("foundation", COLORS.floor, 0xaeb6ad, 1, "concrete", 9, 9));
    ground.position.set(MAP.width / 2, -4, MAP.depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    const rooms = [
      { x: 270, z: 280, w: 520, d: 540, color: 0x969a91, style: "carpet" },
      { x: 810, z: 280, w: 520, d: 540, color: 0xa49b91, style: "carpet" },
      { x: 270, z: 840, w: 520, d: 540, color: 0x91a4a0, style: "tile" },
      { x: 810, z: 840, w: 520, d: 540, color: 0x9ca596, style: "tile" },
      { x: 540, z: 1420, w: 1040, d: 560, color: 0x91a0a4, style: "concrete" },
      { x: 1390, z: 280, w: 660, d: 540, color: 0x9b9b96, style: "carpet" },
      { x: 1390, z: 840, w: 660, d: 540, color: 0x94a69b, style: "tile" },
      { x: 1390, z: 1420, w: 660, d: 560, color: 0x9f9d93, style: "concrete" },
    ];

    for (const room of rooms) {
      const floor = this.texturedBox(room.w, 6, room.d, this.surfaceMaterial(`room-${room.x}-${room.z}`, room.color, 0xaeb6ad, 1, room.style as SurfaceStyle, 4, 4));
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
    // Two broad doorways connect the added east rooms without forming another long corridor.
    this.addWall(1210, 560, 220, 24);
    this.addWall(1580, 560, 240, 24);
    this.addWall(1220, 1120, 240, 24);
    this.addWall(1580, 1120, 240, 24);

    this.addDesk(250, 770, 270, 70, 42, 0xc59b6c);
    this.addDesk(260, 925, 240, 70, 42, 0xc59b6c);
    this.addDesk(270, 280, 280, 118, 46, 0xcbb28d);
    this.addDesk(820, 265, 260, 118, 54, 0xb98b63);
    this.addDesk(1390, 270, 250, 100, 48, 0xc6ad89);
    this.addDesk(1330, 760, 210, 72, 42, 0xc59b6c);
    this.addDesk(1550, 910, 200, 72, 42, 0xc59b6c);
    this.addDesk(1400, 1420, 210, 100, 38, 0xc6ad89);
    this.addCoffeeMachine(825, 805);
    this.addElevatorDoor();
    this.addChairs();
    this.addSceneDressing();
    this.addDaylightDetails();
  }

  private addWall(x: number, z: number, width: number, depth: number, withTrim = true) {
    const wall = this.texturedBox(width, 90, depth, this.surfaceMaterial("painted-wall", COLORS.wall, 0xffffff, 1, "wall", 2, 1));
    wall.position.set(x, 45, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    this.scene.add(wall);
    if (withTrim) {
      // Extend trim past every wall face so vertical wall segments never share a coplanar surface with it.
      const baseboard = this.box(width + 4, 8, depth + 4, 0xd3c6b5);
      baseboard.position.set(x, 4, z);
      baseboard.castShadow = false;
      baseboard.receiveShadow = false;
      const cap = this.box(width + 6, 4, depth + 6, 0xffffff);
      cap.position.set(x, 90, z);
      cap.castShadow = false;
      cap.receiveShadow = false;
      this.scene.add(baseboard, cap);
    }
    this.navigation.addObstacle(x, z, width, depth);
  }

  private addDesk(x: number, z: number, width: number, depth: number, height: number, color: number) {
    const top = this.texturedBox(width, 7, depth, this.surfaceMaterial(`desk-${color.toString(16)}`, color, 0xe9cfaa, 1, "wood", 3, 1));
    top.position.set(x, height - 3.5, z);
    this.scene.add(top);
    const legMaterial = 0xe9e7dd;
    for (const sideX of [-1, 1]) {
      for (const sideZ of [-1, 1]) {
        const leg = this.box(7, height - 7, 7, legMaterial);
        leg.position.set(x + sideX * (width / 2 - 12), (height - 7) / 2, z + sideZ * (depth / 2 - 10));
        this.scene.add(leg);
      }
    }
    const modestyPanel = this.box(width * 0.68, height * 0.34, 4, 0xe6ddce);
    modestyPanel.position.set(x, height * 0.64, z + depth / 2 - 7);
    this.scene.add(modestyPanel);
    this.navigation.addObstacle(x, z, width, depth);
  }

  private addCoffeeMachine(x: number, z: number) {
    const counter = this.box(94, 68, 94, 0xe8e0d0);
    counter.position.set(x, 34, z);
    const top = this.texturedBox(100, 6, 100, this.surfaceMaterial("coffee-counter", 0xc8a17b, 0xe8caa5, 1, "wood"));
    top.position.set(x, 71, z);
    const machine = this.box(40, 32, 30, 0xf8f7f0);
    machine.position.set(x, 90, z - 17);
    const display = this.box(24, 12, 2, 0x70aab7);
    display.position.set(x, 96, z - 33);
    this.scene.add(counter, top, machine, display);
    this.navigation.addObstacle(x, z, 94, 94);
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
    // Elevator frame pieces meet edge-to-edge; expanded wall trim would overlap the jambs and lintel.
    this.addWall(layout.x, layout.z, layout.width, layout.depth, false);
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
      const chair = new THREE.Group();
      const seat = this.mesh(new THREE.CylinderGeometry(19, 18, 7, 12), 0x728e91);
      seat.position.y = 25;
      const back = this.mesh(new THREE.BoxGeometry(34, 33, 7), 0x829da0);
      back.position.set(0, 45, 15);
      back.rotation.x = -0.1;
      const post = this.mesh(new THREE.CylinderGeometry(3, 3, 20, 8), 0xb9c1bd);
      post.position.y = 12;
      const base = this.mesh(new THREE.CylinderGeometry(17, 18, 4, 10), 0x687b7a);
      base.position.y = 3;
      chair.add(seat, back, post, base);
      chair.position.set(x, 0, z);
      this.scene.add(chair);
      this.navigation.addObstacle(x, z, 34, 34);
    }
  }

  private addDaylightDetails() {
    for (const x of [170, 450, 730, 1010, 1320, 1580]) {
      this.addOfficeWindow(x, 0);
      const sunPatch = new THREE.Mesh(
        new THREE.PlaneGeometry(124, 160),
        new THREE.MeshBasicMaterial({ color: 0xfff4d8, transparent: true, opacity: 0.12, depthWrite: false }),
      );
      sunPatch.rotation.x = -Math.PI / 2;
      sunPatch.position.set(x + 34, 8.1, 132);
      sunPatch.renderOrder = 2;
      this.scene.add(sunPatch);
    }
    for (const [x, z] of [[270, 280], [810, 280], [270, 840], [810, 840], [1390, 280], [1390, 840], [540, 1420]] as const) {
      this.addCeilingPanel(x, z);
    }
  }

  private addOfficeWindow(x: number, z: number) {
    const frame = this.box(146, 56, 5, 0xfaf8ef);
    frame.position.set(x, 59, z + 14);
    const glass = this.box(132, 42, 2, 0xa9d8e6);
    glass.position.set(x, 60, z + 18);
    glass.castShadow = false;
    const divider = this.box(4, 42, 3, 0xfaf8ef);
    divider.position.set(x, 60, z + 20);
    const sill = this.box(154, 5, 15, 0xe9e4d8);
    sill.position.set(x, 30, z + 18);
    this.scene.add(frame, glass, divider, sill);
  }

  private addCeilingPanel(x: number, z: number) {
    const housing = this.box(108, 4, 24, 0xe8e8df);
    housing.position.set(x, 123, z);
    housing.castShadow = false;
    const diffuser = new THREE.Mesh(
      new THREE.BoxGeometry(96, 2, 17),
      new THREE.MeshBasicMaterial({ color: 0xfff8dc }),
    );
    diffuser.position.set(x, 126, z);
    this.scene.add(housing, diffuser);
  }

  private addSceneDressing() {
    this.addZonePanel(270, 840, 430, 370, 0xbddad7, 0.09);
    this.addZonePanel(270, 280, 410, 360, 0xd2c5df, 0.08);
    this.addZonePanel(810, 280, 420, 360, 0xe8c9ad, 0.09);
    this.addZonePanel(810, 840, 410, 350, 0xc7dfc3, 0.08);
    this.addZonePanel(540, 1420, 470, 270, 0xc7dbe7, 0.08);
    this.addZonePanel(1390, 280, 490, 350, 0xd8d0e3, 0.08);
    this.addZonePanel(1390, 840, 520, 380, 0xc1ddd1, 0.08);
    this.addZonePanel(1390, 1420, 490, 290, 0xc6d9df, 0.08);

    this.addFloorLabel(270, 610, "工位区", 0x8bdff2, 0.58);
    this.addFloorLabel(270, 95, "会议室", 0xd9b6ff, 0.56);
    this.addFloorLabel(810, 95, "老板办公室", 0xffc08a, 0.58);
    this.addFloorLabel(840, 610, "补给区", 0xa7f3c0, 0.54);
    this.addFloorLabel(540, 1320, "电梯口", 0xbdefff, 0.64);
    this.addFloorLabel(1390, 95, "档案室", 0xd9b6ff, 0.54);
    this.addFloorLabel(1390, 620, "工位区", 0x8bdff2, 0.58);
    this.addFloorLabel(1390, 1210, "休息区", 0xbdefff, 0.54);

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
    this.addEastWingDetails();

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
    canvas.width = 384;
    canvas.height = 128;
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, canvas.width, canvas.height);
    let fontSize = 78;
    context.font = `900 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    while (context.measureText(text).width > canvas.width - 32 && fontSize > 54) {
      fontSize -= 2;
      context.font = `900 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    }
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    context.globalAlpha = opacity;
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 4);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(205, 68),
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
    this.addFloorDecal(270, 280, 92, 0xb8aed1, 0.1);
    this.addComputerSet(270, 250, 0, 0xd9b6ff);
    this.addPaperScatter(215, 350, 7);
    this.addPaperScatter(335, 240, 6);
  }

  private addBossOfficeDetails() {
    this.addZonePanel(820, 265, 330, 190, 0xd5ad88, 0.1);
    this.addComputerSet(820, 220, 0, 0xffb86b);
    this.addDeskLamp(910, 245, 0xffd27a);
    this.addWallMarker(1030, 280, -Math.PI / 2, 0xffb86b);
    this.addBookShelf(1000, 430, 0);
    this.addPaperScatter(760, 345, 8);
  }

  private addSupplyRoomDetails() {
    this.addVendingMachine(990, 820);
    this.addFloorDecal(810, 840, 70, 0xa9cdae, 0.1);
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

  private addEastWingDetails() {
    this.addComputerSet(1320, 245, 0, 0xd9b6ff);
    this.addComputerSet(1450, 280, Math.PI, 0xd9b6ff);
    this.addComputerSet(1270, 750, 0, 0x7dd3fc);
    this.addComputerSet(1510, 900, Math.PI, 0x38bdf8);
    this.addFilingCabinet(1640, 270, 0x566251);
    this.addFilingCabinet(1630, 1010, 0x4e6571);
    this.addCrateStack(1250, 1450, 0.3);
    this.addPottedPlant(1130, 340);
    this.addPottedPlant(1610, 1350);
    this.addPaperScatter(1390, 370, 8);
    this.addPaperScatter(1380, 1440, 9);
    this.addLightStrip(1390, 560, 170, Math.PI / 2, 0xbdefff);
    this.addLightStrip(1390, 1120, 170, Math.PI / 2, 0xbdefff);
  }

  private addComputerSet(x: number, z: number, rotationY: number, glowColor: number) {
    const group = new THREE.Group();
    const monitor = this.mesh(new THREE.BoxGeometry(38, 24, 5), 0x657980);
    monitor.position.set(0, 28, -2);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 16),
      new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.48, depthWrite: false }),
    );
    screen.position.set(0, 28, -5.2);
    const stand = this.mesh(new THREE.BoxGeometry(6, 14, 6), 0x8a9897);
    stand.position.set(0, 14, 0);
    const keyboard = this.mesh(new THREE.BoxGeometry(36, 3, 13), 0xaab5af);
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
    const rail = this.mesh(new THREE.BoxGeometry(length, 5, 8), 0xe8e6dc);
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry(length * 0.86, 3, 4),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.65,
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

    const light = new THREE.PointLight(color, 0.38, 260, 1.75);
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
    const pot = this.mesh(new THREE.CylinderGeometry(14, 18, 24, 16), 0xbe8061);
    pot.position.y = 12;
    const soil = this.mesh(new THREE.CylinderGeometry(13, 13, 2, 16), 0x75543f);
    soil.position.y = 24;
    const stem = this.mesh(new THREE.CylinderGeometry(2, 3, 31, 8), 0x6c956c);
    stem.position.y = 39;
    const leafGeometry = new THREE.SphereGeometry(10, 12, 8);
    const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x65a97b, roughness: 0.9 });
    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * Math.PI * 2;
      const leaf = this.meshWithMaterial(leafGeometry, leafMaterial);
      leaf.scale.set(0.7, 1.5, 0.42);
      leaf.position.set(Math.cos(angle) * 13, 49 + (index % 2) * 7, Math.sin(angle) * 13);
      leaf.rotation.z = -Math.cos(angle) * 0.5;
      leaf.rotation.x = Math.sin(angle) * 0.5;
      group.add(leaf);
    }
    group.add(pot, soil, stem);
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

  private async createPlayer() {
    this.player = new THREE.Group();

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

    this.playerVisual = await this.characterAssets.createAsync(CHARACTER_MODELS.playerUnarmed, {
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.player.add(this.playerVisual.root);
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

  private spawnSupply(kind: SupplyKind, nearPlayer = false) {
    const origin = { x: this.playerState.x, z: this.playerState.z };
    const isValid = (position: { x: number; z: number }) => (
      this.navigation.canOccupy(position.x, position.z, 38)
      && this.navigation.canMoveDirectly(origin.x, origin.z, position.x, position.z, PLAYER_CONFIG.radius)
      && this.supplies.every(pickup => Math.hypot(
        pickup.group.position.x - position.x, pickup.group.position.z - position.z,
      ) > 110)
    );
    const position = pickSupplyPosition(origin, nearPlayer ? 100 : 170, nearPlayer ? 270 : 510, isValid)
      ?? pickSupplyPosition(origin, 80, 650, isValid)
      ?? (nearPlayer ? pickSupplyPosition(origin, 65, 100, isValid) : undefined);
    if (!position) return false;
    this.createSupplyPickup(position.x, position.z, kind, "supply");
    return true;
  }

  private createSupplyPickup(x: number, z: number, kind: SupplyKind, source: "supply" | "drop") {
    const group = new THREE.Group();
    const item = new THREE.Group();
    const color = kind === "smg" ? 0xffd166 : kind === "medkit" ? 0xff7979 : COLORS.ammoBox;
    if (source === "supply") {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(35, 41, 28),
        new THREE.MeshBasicMaterial({ color: COLORS.ammoBox, transparent: true, opacity: 0.6, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 9.4;
      ring.renderOrder = 5;
      group.add(ring);
    }
    if (kind === "smg") {
      const body = this.mesh(new THREE.BoxGeometry(48, 9, 12), 0x3a4247);
      body.position.y = 32;
      const barrel = this.mesh(new THREE.BoxGeometry(28, 5, 6), color);
      barrel.position.set(34, 33, 0);
      const grip = this.mesh(new THREE.BoxGeometry(10, 19, 9), 0x283036);
      grip.position.set(-5, 20, 0);
      item.add(body, barrel, grip);
    } else {
      const base = this.mesh(new THREE.BoxGeometry(source === "drop" ? 30 : 44, 20, source === "drop" ? 22 : 34), color);
      base.position.y = 18;
      const lid = this.mesh(new THREE.BoxGeometry(source === "drop" ? 33 : 48, 5, source === "drop" ? 25 : 38), 0xf3f4ec);
      lid.position.y = 30;
      item.add(base, lid);
      if (kind === "medkit") {
        const horizontal = this.mesh(new THREE.BoxGeometry(22, 4, 2), 0xe94352);
        const vertical = this.mesh(new THREE.BoxGeometry(4, 20, 2), 0xe94352);
        horizontal.position.set(0, 18, 18);
        vertical.position.set(0, 18, 18);
        item.add(horizontal, vertical);
      } else {
        for (let index = -1; index <= 1; index += 1) {
          const round = this.mesh(new THREE.CylinderGeometry(2.5, 2.5, 14, 6), COLORS.muzzle);
          round.position.set(index * 9, 39, 0);
          item.add(round);
        }
      }
    }
    group.add(item);
    group.position.set(x, 0, z);
    this.scene.add(group);
    this.supplies.push({
      group, item, kind,
      amount: source === "drop" ? AMMO_CONFIG.droppedAmount : kind === "medkit" ? SUPPLY_CONFIG.medkitHeal : AMMO_CONFIG.supplyAmount,
      radius: source === "drop" ? 20 : SUPPLY_CONFIG.pickupRadius,
      source,
      expiresAt: this.elapsed + (source === "drop" ? AMMO_CONFIG.droppedLifetime : SUPPLY_CONFIG.lifetime),
      phase: Math.random() * Math.PI * 2,
    });
  }

  private bindEvents() {
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", this.onUpgradeKeyDown);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.hud.statusDetails.hidden) this.closeStatusDetails(true);
    });
    this.hud.hudPanel.addEventListener("click", () => this.toggleStatusDetails());
    this.hud.hudPanel.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.toggleStatusDetails();
    });
    this.hud.detailsClose.addEventListener("click", () => this.closeStatusDetails(true));
    window.addEventListener("pointerdown", (event) => {
      if (this.hud.statusDetails.hidden || this.hud.detailsCard.contains(event.target as Node)
        || this.hud.hudPanel.contains(event.target as Node)) return;
      this.closeStatusDetails();
    }, true);
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

    let input = this.input!.getState(this.playerState.x, this.playerState.z);
    if (input.modeStep) {
      const mode = this.loadout.neighbor(input.modeStep);
      if (mode && this.selectAttackMode(mode)) input = this.input!.getState(this.playerState.x, this.playerState.z);
    }
    for (const [button, charge] of [[this.hud.punchButton, input.punchCharge], [this.hud.kickButton, input.kickCharge]] as const) {
      button.style.setProperty("--charge", `${charge * 360}deg`);
      button.classList.toggle("is-charged", charge >= 1);
    }
    this.updateTimeline();
    if (!this.isArmed) this.updateUnarmedAttack(input);
    this.updatePlayer(delta, input);
    this.updateBulletVisuals(delta);
    const enemiesStartedAt = this.performanceMonitor.startPhase();
    this.updateEnemies(delta);
    this.performanceMonitor.finishPhase("enemies", enemiesStartedAt);
    const shotAim = this.updateWeapon(input);
    this.updatePlayerAnimation(delta, input);
    if (shotAim) this.fireWeapon(shotAim.x, shotAim.z);
    this.updateSupplies(delta);
    this.updateAccessCard();
    this.updateEvacuation(delta);
    this.updateObjectiveBeacons(delta);
    this.updateParticles(delta);
    this.updateShotEffects(delta);
    this.trySpawnEnemies();
    this.minimap.update(delta, this.playerState, this.enemies);
    this.updateCamera(delta);
    for (const enemy of this.enemies) enemy.healthBar.quaternion.copy(this.camera.quaternion);
    this.updateCrosshair(input);
    this.updateObjectiveArrow();
    this.resolveGameResult();
    this.updateUpgradeOffer();
    this.tryOpenUpgradePanel();
    this.refreshHud();
  }

  private updatePlayer(delta: number, input: InputState) {
    const slowMultiplier = this.elapsed < this.slowUntil ? 0.7 : 1;
    const targetMultiplier = input.moveSpeedMultiplier;
    this.moveSpeedMultiplier = targetMultiplier <= 1
      ? targetMultiplier || 1
      : THREE.MathUtils.lerp(this.moveSpeedMultiplier, targetMultiplier, 1 - Math.exp(-delta * 10));
    const speed = this.melee.locksMovement ? 0 : this.playerState.speed * slowMultiplier * this.moveSpeedMultiplier;
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
    const meleeAim = this.melee.active;
    const facingAim = this.pendingShotAim ?? (meleeAim ? { x: meleeAim.aimX, z: meleeAim.aimZ } : { x: input.aimX, z: input.aimZ });
    this.player.rotation.y = Math.atan2(facingAim.x, facingAim.z);
    this.playerLight?.position.set(this.playerState.x, 72, this.playerState.z);
  }

  private updateCrosshair(input: InputState) {
    if (!this.crosshair) return;
    if (window.innerHeight <= window.innerWidth || !this.coarsePointer.matches) {
      this.crosshair.position.set(input.aimPointX, 5, input.aimPointZ);
      return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    const { x, z } = this.playerState;
    const origin = this.crosshairScreenOrigin.set(x, 5, z).project(this.camera);
    const target = this.crosshairScreenTarget.set(x + input.aimX * 360, 5, z + input.aimZ * 360)
      .project(this.camera);
    const originX = (origin.x * 0.5 + 0.5) * width;
    const originY = (1 - origin.y) * 0.5 * height;
    const deltaX = (target.x - origin.x) * 0.5 * width;
    const deltaY = (origin.y - target.y) * 0.5 * height;
    const screenDistance = Math.hypot(deltaX, deltaY);
    const margin = 34;
    let fraction = Math.min(1, Math.min(width * 0.4, 160) / Math.max(screenDistance, 1));
    if (deltaX > 0) fraction = Math.min(fraction, (width - margin - originX) / deltaX);
    if (deltaX < 0) fraction = Math.min(fraction, (margin - originX) / deltaX);
    if (deltaY > 0) fraction = Math.min(fraction, (height - margin - originY) / deltaY);
    if (deltaY < 0) fraction = Math.min(fraction, (margin - originY) / deltaY);
    fraction = THREE.MathUtils.clamp(fraction, 0, 1);
    this.crosshair.position.set(x + input.aimX * 360 * fraction, 5, z + input.aimZ * 360 * fraction);
  }

  private updatePlayerAnimation(delta: number, input: InputState) {
    if (!this.playerVisual) return;
    this.playerVisual.setMovement(input.moveX, input.moveZ);
    this.playerVisual.setMovementSpeedScale(this.moveSpeedMultiplier * (this.elapsed < this.slowUntil ? 0.7 : 1));
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
    const healthBar = this.createEnemyHealthBar(healthBarWidth);
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

  private createEnemyHealthBar(width: number) {
    const group = new THREE.Group();
    const background = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 7, 8),
      new THREE.MeshBasicMaterial({ color: 0x070b0a, transparent: true, opacity: 0.82, depthWrite: false }),
    );
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 4.5),
      new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
    );
    const shine = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 1.4),
      new THREE.MeshBasicMaterial({ color: 0xffd5d5, transparent: true, opacity: 0.26, depthWrite: false, toneMapped: false }),
    );
    fill.userData.width = width;
    fill.position.z = 0.2;
    shine.position.set(0, 1.1, 0.3);
    background.renderOrder = 0;
    fill.renderOrder = 1;
    shine.renderOrder = 2;
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
      const previousX = enemy.group.position.x;
      const previousZ = enemy.group.position.z;
      const nextPosition = this.navigation.moveCircle(
        previousX,
        previousZ,
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
      const actualVelocityX = (nextPosition.x - previousX) / Math.max(delta, 1e-6);
      const actualVelocityZ = (nextPosition.z - previousZ) / Math.max(delta, 1e-6);
      enemy.visual.setMovement(actualVelocityX, actualVelocityZ);
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
    if (!this.isArmed) {
      return undefined;
    }
    const update = this.weapon.update(this.elapsed, input.fireHeld, false);
    let shotAim: { x: number; z: number } | undefined;
    if (update.reloadStarted) {
      this.pendingShotAim = undefined;
      this.playerVisual?.stopOneShot("shoot");
      this.playerVisual?.playOneShot("reload", { durationSeconds: update.reloadDurationSeconds });
    }
    if (update.reloadCompleted) this.playerVisual?.stopOneShot("reload");
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

  private updateUnarmedAttack(input: InputState) {
    // Establish current movement before selecting full-body vs moving punches.
    this.playerVisual?.setMovement(input.moveX, input.moveZ);
    if (this.melee.active?.move.kind === "punch") {
      this.melee.active.aimX = input.aimX;
      this.melee.active.aimZ = input.aimZ;
    }
    for (const hit of this.melee.advance(this.elapsed)) this.resolveUnarmedAttack(hit);
    for (const request of input.meleeRequests) this.melee.request(request, this.elapsed);
    const recovered = this.melee.releaseRecovery(this.elapsed, Math.hypot(input.moveX, input.moveZ) > 0.08);
    if (recovered) this.playerVisual?.stopOneShot(recovered);
    this.melee.startQueued(this.elapsed, input.aimX, input.aimZ,
      move => this.playerVisual?.playOneShot(move.action, { durationSeconds: move.duration }) ?? false);
  }

  private resolveUnarmedAttack(attack: ActiveMelee) {
    const { aimX: forwardX, aimZ: forwardZ, move } = attack;
    const range = move.range;
    const targets = this.enemies
      .filter(enemy => enemy.hp > 0 && enemy.ai.state !== "spawning")
      .map(enemy => ({ enemy, distance: this.distanceToPlayer(enemy.group.position.x, enemy.group.position.z) }))
      .filter(({ enemy, distance }) => {
        if (distance > range + enemy.radius || distance < 1) return false;
        const toEnemyX = (enemy.group.position.x - this.playerState.x) / distance;
        const toEnemyZ = (enemy.group.position.z - this.playerState.z) / distance;
        if (!move.sweep && toEnemyX * forwardX + toEnemyZ * forwardZ < 0.5) return false;
        if (move.sweep && attack.hitTargets.has(enemy.id)) return false;
        return this.navigation.raycastObstacleDistance(
          this.playerState.x, this.playerState.z, toEnemyX, toEnemyZ, distance,
        ) >= distance - enemy.radius;
      })
      .sort((first, second) => first.distance - second.distance)
      .slice(0, move.sweep ? undefined : 1).map(({ enemy }) => enemy);

    const swing = new THREE.Group();
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(20, 27, 18, 1, -Math.PI * 0.4, Math.PI * 0.8),
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    arc.rotation.x = -Math.PI / 2;
    swing.add(arc);
    swing.position.set(this.playerState.x + forwardX * 54, 23, this.playerState.z + forwardZ * 54);
    swing.rotation.y = Math.atan2(forwardX, forwardZ);
    this.scene.add(swing);
    this.shotEffects.push({ object: swing, life: 0.13, maxLife: 0.13 });
    for (const target of targets) {
      target.hp -= move.damage;
      attack.hitTargets.add(target.id);
      target.hitFlashUntil = this.elapsed + 0.14;
      this.enemyAi.notifyHit(target.ai, this.playerState.x, this.playerState.z, this.elapsed);
      this.updateEnemyVisualState(target);
      this.emitParticles(target.group.position.x, 30, target.group.position.z, 0xffd166, 5, 38);
    }
    this.removeDeadEnemies();
  }

  private selectAttackMode(mode: AttackMode) {
    if (!this.loadout.select(mode)) return false;
    this.input?.setAttackMode(mode);
    this.weapon.holster();
    this.pendingShotAim = undefined;
    this.melee.cancel();
    const oldVisual = this.playerVisual;
    if (oldVisual) {
      oldVisual.dispose();
      this.player.remove(oldVisual.root);
      this.disposeObject(oldVisual.root);
    }
    this.playerVisual = this.characterAssets.create(mode === "smg" ? CHARACTER_MODELS.player : CHARACTER_MODELS.playerUnarmed, {
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.player.add(this.playerVisual.root);
    if (mode === "smg") {
      const muzzleAccent = new THREE.PointLight(COLORS.muzzle, 0.18, 90, 1.9);
      this.playerVisual.muzzleSocket?.add(muzzleAccent);
    }
    this.refreshAttackControls();
    return true;
  }

  private refreshAttackControls() {
    this.hud.root.classList.toggle("is-unarmed", !this.isArmed);
    this.hud.fireButton.hidden = !this.isArmed;
    this.hud.punchButton.hidden = this.isArmed;
    this.hud.kickButton.hidden = this.isArmed;
    this.hud.currentMode.innerHTML = (this.isArmed ? COMBAT_ICONS.smg : COMBAT_ICONS.punch)
      + `<span>${ATTACK_MODE_LABELS[this.loadout.current]}</span>`;
    this.hud.currentMode.setAttribute("aria-label", `当前攻击方式：${ATTACK_MODE_LABELS[this.loadout.current]}`);
    for (const [button, direction] of [[this.hud.previousMode, -1], [this.hud.nextMode, 1]] as const) {
      const mode = this.loadout.neighbor(direction);
      button.disabled = mode === undefined;
      button.innerHTML = mode ? mode === "smg" ? COMBAT_ICONS.smg : COMBAT_ICONS.punch : '<span aria-hidden="true">—</span>';
      button.setAttribute("aria-label", mode ? `切换到${ATTACK_MODE_LABELS[mode]}` : "暂无可切换装备");
      button.title = mode ? `切换到${ATTACK_MODE_LABELS[mode]}` : "拾取装备后可切换";
    }
    this.hud.controls.textContent = this.isArmed
      ? "WASD / 方向键移动 · J / 左键射击 · 空弹匣自动换弹 · Q / E 切换方式"
      : "WASD / 方向键移动 · J / 左键出拳 · K 踢腿 · 长按蓄力 · Q / E 切换方式";
  }

  private updateSupplies(delta: number) {
    if (this.elapsed >= this.nextSupplyAt) {
      this.nextSupplyAt = this.elapsed + SUPPLY_CONFIG.respawnInterval;
      const activeSupplies = this.supplies.filter(pickup => pickup.source === "supply");
      if (activeSupplies.length < SUPPLY_CONFIG.maxActive) {
        const kind = !this.hasSmg && activeSupplies.some(pickup => pickup.kind === "smg")
          ? Math.random() < 0.5 ? "ammo" : "medkit"
          : chooseSupplyKind(this.hasSmg, this.playerState.hp < this.playerState.maxHp);
        this.spawnSupply(kind);
      }
    }
    for (const pickup of [...this.supplies]) {
      if (this.elapsed >= pickup.expiresAt) {
        this.removeSupply(pickup);
        continue;
      }

      pickup.item.rotation.y += delta * (pickup.source === "supply" ? 0.7 : 1.4);
      pickup.item.position.y = Math.sin(this.elapsed * 2.5 + pickup.phase) * 3;
      if (this.distanceToPlayer(pickup.group.position.x, pickup.group.position.z) > PLAYER_CONFIG.radius + pickup.radius) continue;
      if (pickup.kind === "smg") {
        if (this.hasSmg) continue;
        this.loadout.unlock("smg");
        this.refreshAttackControls();
        this.showFloating("拾到冲锋枪 · 点切换器使用", "#ffe39a");
      } else if (pickup.kind === "medkit") {
        const healed = Math.min(pickup.amount, this.playerState.maxHp - this.playerState.hp);
        if (healed <= 0) continue;
        this.playerState.hp += healed;
        this.showFloating(`生命 +${healed}`, "#ffb6b6");
      } else {
        const addedAmmo = this.weapon.addReserveAmmo(pickup.amount);
        if (addedAmmo <= 0) {
          if (this.elapsed >= this.nextAmmoHintAt) {
            this.nextAmmoHintAt = this.elapsed + 2;
            this.showHint("后备弹药已满");
          }
          continue;
        }
        this.showFloating(`弹药 +${addedAmmo}`, "#b9f9d4");
      }
      this.emitParticles(pickup.group.position.x, 24, pickup.group.position.z,
        pickup.kind === "medkit" ? 0xff7979 : COLORS.ammoBox, 8, 52);
      this.removeSupply(pickup);
    }
  }

  private maybeDropAmmo(enemy: Enemy) {
    if (Math.random() >= AMMO_CONFIG.dropChance[enemy.kind]) return;
    const droppedCount = this.supplies.filter((pickup) => pickup.source === "drop").length;
    if (droppedCount >= AMMO_CONFIG.maxDroppedPacks) return;
    this.createSupplyPickup(enemy.group.position.x, enemy.group.position.z, "ammo", "drop");
  }

  private removeSupply(pickup: SupplyPickup) {
    this.supplies = this.supplies.filter(candidate => candidate !== pickup);
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
    const hitMargin = this.coarsePointer.matches ? TOUCH_SHOT_HIT_MARGIN : 0;
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
        radius: enemy.radius + hitMargin,
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
      const deathBurst = enemy.kind === "changeRequest"
        ? { color: 0x2878e8, count: 16 }
        : enemy.kind === "meeting"
          ? { color: 0x8249df, count: 16 }
          : undefined;
      this.emitParticles(
        enemy.group.position.x,
        34,
        enemy.group.position.z,
        deathBurst?.color ?? ENEMY_CONFIG[enemy.kind].color,
        deathBurst?.count ?? (enemy.kind === "boss" ? 24 : 10),
        enemy.kind === "boss" ? 110 : 64,
        deathBurst ? { minSize: 3.5, maxSize: 6.5, life: 0.62, toneMapped: false } : undefined,
      );
      this.maybeDropAmmo(enemy);
      if (enemy.expReward > 0) {
        const gainedExp = this.gainExp(enemy.expReward);
        if (gainedExp > 0) this.showFloating(`+${gainedExp}`, "#9be7ff");
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
    if (this.upgradePending) return 0;
    const gainedExp = Math.min(amount, this.playerState.expToNext - this.playerState.exp);
    this.playerState.exp += gainedExp;
    if (this.playerState.exp >= this.playerState.expToNext) this.upgradePending = true;
    return gainedExp;
  }

  private tryOpenUpgradePanel() {
    if (this.gameState !== "playing" || !this.upgradePending || this.currentUpgradeChoices.length > 0) return;
    this.openUpgradePanel();
  }

  private openUpgradePanel() {
    const available = (Object.keys(this.weaponUpgradeLevels) as WeaponUpgradeId[])
      .filter((id) => this.weaponUpgradeLevels[id] < 5);
    if (available.length === 0) {
      this.completeLevelUp();
      return;
    }
    this.closeStatusDetails();

    for (let index = available.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [available[index], available[swapIndex]] = [available[swapIndex], available[index]];
    }
    this.currentUpgradeChoices = available.slice(0, 3);
    this.upgradeOfferId += 1;
    this.upgradeOfferEndsAt = this.elapsed + UPGRADE_OFFER_SECONDS;
    this.hud.upgradeTimer.textContent = `${UPGRADE_OFFER_SECONDS.toFixed(1)} 秒`;
    this.hud.upgradeTimer.classList.remove("is-urgent");
    this.hud.upgradeTimerBar.classList.remove("is-urgent");
    this.hud.upgradeTimerBar.style.width = "100%";
    this.renderUpgradeChoices();
    this.hud.upgradePanel.classList.add("is-visible");
  }

  private updateUpgradeOffer() {
    if (this.gameState !== "playing" || this.currentUpgradeChoices.length === 0) return;
    const remaining = this.upgradeOfferEndsAt - this.elapsed;
    if (remaining <= 0) {
      this.completeLevelUp();
      this.showHint("本次强化已放弃");
      return;
    }
    this.hud.upgradeTimer.textContent = `${remaining.toFixed(1)} 秒`;
    this.hud.upgradeTimer.classList.toggle("is-urgent", remaining <= 1.5);
    this.hud.upgradeTimerBar.classList.toggle("is-urgent", remaining <= 1.5);
    this.hud.upgradeTimerBar.style.width = `${remaining / UPGRADE_OFFER_SECONDS * 100}%`;
  }

  private renderUpgradeChoices() {
    this.hud.upgradeOptions.replaceChildren();
    const offerId = this.upgradeOfferId;
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
      let handledByTouch = false;
      // A second touch can suppress click while the movement joystick is held.
      button.addEventListener("pointerup", (event) => {
        if (event.pointerType !== "touch") return;
        event.preventDefault();
        handledByTouch = true;
        this.selectWeaponUpgrade(id, offerId);
      });
      button.addEventListener("click", () => {
        if (!handledByTouch) this.selectWeaponUpgrade(id, offerId);
      });
      this.hud.upgradeOptions.append(button);
    }
  }

  private selectWeaponUpgrade(id: WeaponUpgradeId, offerId = this.upgradeOfferId) {
    if (this.gameState !== "playing" || !this.upgradePending || offerId !== this.upgradeOfferId
      || this.elapsed >= this.upgradeOfferEndsAt || !this.currentUpgradeChoices.includes(id)) return;
    this.weaponUpgradeLevels[id] = Math.min(5, this.weaponUpgradeLevels[id] + 1);
    this.weapon.applyStats(getWeaponRuntimeStats(this.weaponUpgradeLevels));
    const definition = WEAPON_UPGRADE_DEFINITIONS[id];
    this.showHint(`${definition.title} Lv ${this.weaponUpgradeLevels[id]}`);
    this.completeLevelUp();
  }

  private completeLevelUp() {
    if (!this.upgradePending) return;
    this.upgradePending = false;
    this.playerState.exp = 0;
    this.playerState.level += 1;
    this.playerState.expToNext = getExpToNext(this.playerState.level);
    this.closeUpgradePanel();
  }

  private closeUpgradePanel() {
    this.currentUpgradeChoices = [];
    this.hud.upgradePanel.classList.remove("is-visible");
  }

  private onUpgradeKeyDown = (event: KeyboardEvent) => {
    if (this.gameState !== "playing" || this.currentUpgradeChoices.length === 0 || event.repeat) return;
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
    this.camera.updateMatrixWorld();
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

  private emitParticles(
    x: number,
    y: number,
    z: number,
    color: number,
    count: number,
    spread: number,
    style?: { minSize: number; maxSize: number; life: number; toneMapped: boolean },
  ) {
    while (this.particles.length + count > MAX_ACTIVE_PARTICLES) {
      const oldest = this.particles.shift();
      if (oldest) this.disposeParticle(oldest);
    }

    for (let i = 0; i < count; i += 1) {
      const mesh = new THREE.Mesh(
        this.particleGeometry,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, toneMapped: style?.toneMapped ?? true }),
      );
      const size = THREE.MathUtils.randFloat(style?.minSize ?? 2, style?.maxSize ?? 5);
      mesh.scale.setScalar(size);
      mesh.position.set(x, y, z);
      const angle = Math.random() * Math.PI * 2;
      const speed = THREE.MathUtils.randFloat(spread * 0.8, spread * 1.4);
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, THREE.MathUtils.randFloat(40, 120), Math.sin(angle) * speed);
      this.scene.add(mesh);
      const life = style?.life ?? 0.45;
      this.particles.push({ mesh, velocity, size, life, maxLife: life });
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
    this.hud.hint.classList.toggle("is-countdown", message === "距离下班还有 120 秒");
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
    this.hud.hpText.textContent = `${Math.ceil(this.playerState.hp)}/${this.playerState.maxHp}`;
    this.hud.level.textContent = `Lv ${this.playerState.level}`;
    this.hud.hpBar.style.width = `${(this.playerState.hp / this.playerState.maxHp) * 100}%`;
    this.hud.expText.textContent = `${this.playerState.exp}/${this.playerState.expToNext}`;
    this.hud.expBar.style.width = `${(this.playerState.exp / this.playerState.expToNext) * 100}%`;
    this.hud.expTrack.classList.toggle("is-ready", this.upgradePending && this.currentUpgradeChoices.length > 0);
    const weapon = this.weapon.getSnapshot(this.elapsed);
    const reserveMagazines = Math.ceil(weapon.reserveAmmo / weapon.magazineSize);
    const lastMagazineAmmo = weapon.reserveAmmo === 0 ? 0 : (weapon.reserveAmmo - 1) % weapon.magazineSize + 1;
    this.hud.loadedAmmo.textContent = `×${weapon.magazineAmmo}`;
    this.hud.reserveMagazines.textContent = `×${reserveMagazines}`;
    this.hud.magazineFill.style.transform = `scaleY(${lastMagazineAmmo / weapon.magazineSize})`;
    this.hud.weaponPanel.setAttribute("aria-label", this.isArmed
      ? `冲锋枪，${weapon.isReloading ? "换弹中，" : ""}弹匣内 ${weapon.magazineAmmo}/${weapon.magazineSize} 发，备用 ${weapon.reserveAmmo} 发`
      : "空手，靠近冲锋枪补给可拾取");
    this.hud.reloadBar.style.width = `${weapon.reloadProgress * 100}%`;
    this.hud.weaponPanel.classList.toggle("is-reloading", weapon.isReloading);
    this.hud.weaponPanel.classList.toggle("is-empty", weapon.magazineAmmo === 0);
    this.hud.weaponPanel.classList.toggle("is-low-ammo", this.isArmed && weapon.magazineAmmo <= Math.ceil(weapon.magazineSize * 0.25) && weapon.reserveAmmo > 0 && !weapon.isReloading);
    if (!this.hud.statusDetails.hidden) this.refreshStatusDetails(weapon);

    this.hud.root.classList.toggle("is-low-health", this.playerState.hp / this.playerState.maxHp <= 0.28);
    this.hud.alert.classList.toggle("is-visible", this.elapsed < this.bossAlertUntil);
  }

  private toggleStatusDetails() {
    if (!this.hud.statusDetails.hidden) {
      this.closeStatusDetails(true);
      return;
    }
    if (this.gameState !== "playing" || this.currentUpgradeChoices.length > 0) return;
    this.hud.statusDetails.hidden = false;
    this.hud.hudPanel.setAttribute("aria-expanded", "true");
    this.refreshStatusDetails(this.weapon.getSnapshot(this.elapsed));
    this.hud.detailsClose.focus();
  }

  private closeStatusDetails(restoreFocus = false) {
    if (this.hud.statusDetails.hidden) return;
    this.hud.statusDetails.hidden = true;
    this.hud.hudPanel.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.hud.hudPanel.focus();
  }

  private refreshStatusDetails(weapon: WeaponSnapshot) {
    const hp = Math.ceil(this.playerState.hp);
    this.hud.detailHpText.textContent = `${hp}/${this.playerState.maxHp}`;
    this.hud.detailHpBar.style.width = `${hp / this.playerState.maxHp * 100}%`;
    this.hud.detailExpText.textContent = `${this.playerState.exp}/${this.playerState.expToNext}`;
    this.hud.detailExpBar.style.width = `${this.playerState.exp / this.playerState.expToNext * 100}%`;
    this.hud.detailLevel.textContent = `Lv ${this.playerState.level}`;

    const investedPoints = this.weaponUpgradeLevels.firepowerCalibration + this.weaponUpgradeLevels.magazineManagement;
    this.hud.detailSkillPoints.textContent = `已投入 ${investedPoints} 点`;
    this.hud.detailFirepowerLevel.textContent = `Lv ${this.weaponUpgradeLevels.firepowerCalibration}/5`;
    this.hud.detailMagazineLevel.textContent = `Lv ${this.weaponUpgradeLevels.magazineManagement}/5`;

    const stats = getWeaponRuntimeStats(this.weaponUpgradeLevels);
    this.hud.detailWeaponName.textContent = this.isArmed ? "冲锋枪" : "空手";
    this.hud.detailWeaponEquip.textContent = "当前使用";
    this.hud.detailWeaponAmmo.textContent = this.isArmed
      ? `弹匣 ${weapon.magazineAmmo}/${weapon.magazineSize} 发 · 备用 ${weapon.reserveAmmo} 发`
      : this.hasSmg ? "已拾取冲锋枪 · 点攻击方式切换器可使用" : "靠近地上的枪可拾取 · 已拾弹药会保留";
    this.hud.detailWeaponStats.textContent = this.isArmed
      ? `伤害 ${Number(stats.damage.toFixed(1))} · 射速 ${Number(stats.fireRate.toFixed(1))}/秒 · 换弹 ${Number(stats.reloadTime.toFixed(2))} 秒`
      : "每拳 12 · 蓄力勾拳 24 · 每踢 16 · 长按蓄力";
  }

  private finishGame(state: "success" | "failed", message: string, color: string) {
    this.transitionTo(state);
    this.closeStatusDetails();
    this.closeUpgradePanel();
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
    this.input?.resetCombat();
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
    context.globalAlpha = 0.08;
    context.strokeStyle = this.colorToCss(detail);
    context.lineWidth = 2;
    for (let line = 0; line < 5; line += 1) {
      const x = rng() * 256;
      const y = rng() * 256;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + rng() * 70 - 35, y + rng() * 16 - 8);
      context.stroke();
    }
  }

  private drawTilePattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    const tile = 128;
    context.globalAlpha = 0.12;
    context.fillStyle = this.colorToCss(detail);
    context.fillRect(0, 0, tile, tile);
    context.fillRect(tile, tile, tile, tile);
    context.globalAlpha = 0.22;
    context.strokeStyle = this.colorToCss(base.clone().offsetHSL(0, 0, -0.13));
    context.lineWidth = 2;
    for (let position = 0; position <= 256; position += tile) {
      context.beginPath();
      context.moveTo(position, 0);
      context.lineTo(position, 256);
      context.moveTo(0, position);
      context.lineTo(256, position);
      context.stroke();
    }
  }

  private drawCarpetPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    context.globalAlpha = 0.1;
    context.strokeStyle = this.colorToCss(detail);
    context.lineWidth = 1;
    for (let y = 0; y < 256; y += 16) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(256, y);
      context.stroke();
    }
    context.globalAlpha = 0.06;
    for (let x = 0; x < 256; x += 20) {
      context.fillStyle = this.colorToCss(base.clone().offsetHSL(0, 0, -0.08));
      context.fillRect(x, 0, 2, 256);
    }
  }

  private drawWallPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    context.globalAlpha = 0.08;
    context.fillStyle = this.colorToCss(detail);
    context.fillRect(0, 0, 256, 32);
  }

  private drawWoodPattern(context: CanvasRenderingContext2D, base: THREE.Color, detail: THREE.Color, rng: () => number) {
    const gradient = context.createLinearGradient(0, 0, 256, 0);
    gradient.addColorStop(0, this.colorToCss(base.clone().offsetHSL(0, 0.02, -0.03)));
    gradient.addColorStop(0.5, this.colorToCss(base));
    gradient.addColorStop(1, this.colorToCss(detail.clone().offsetHSL(0, -0.03, -0.02)));
    context.globalAlpha = 1;
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 24) {
      context.globalAlpha = 0.12 + rng() * 0.06;
      context.strokeStyle = this.colorToCss(detail.clone().offsetHSL(0, 0, -0.08));
      context.lineWidth = 1 + rng() * 2;
      context.beginPath();
      context.moveTo(0, y + rng() * 3);
      for (let x = 0; x <= 256; x += 32) {
        context.lineTo(x, y + Math.sin(x * 0.035 + rng()) * 3 + rng() * 2);
      }
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
    root.className = "ui-root is-unarmed";
    root.innerHTML = `
      <div class="minimap-panel">
        <canvas class="minimap-canvas" width="240" height="240" aria-label="实时地图"></canvas>
      </div>
      <div class="timer-panel">
        <div class="timer">120</div>
        <div class="timer-caption">距离下班</div>
      </div>
      <div class="hud-panel" role="button" tabindex="0" aria-label="查看角色状态与强化技能" aria-expanded="false" aria-controls="status-details">
        <div class="status-header"><div class="level">Lv 1</div><div class="skills-label">强化技能</div></div>
        <div class="health-row">
          <div class="hp-track"><div class="hp-fill"></div><div class="hp-value">100/100</div></div>
        </div>
        <div class="exp-track"><div class="exp-fill"></div><div class="exp-value">0/20</div></div>
        <div class="weapon-panel" role="group" aria-label="空手，靠近冲锋枪补给可拾取">
          <span class="unarmed-label">空手</span>
          <svg class="weapon-icon" viewBox="0 0 64 32" role="img" aria-label="冲锋枪">
            <path fill="currentColor" d="M2 10h9l4 4h5V9h21l5-3h9v3h8v4h-8v3H43l-4 3h-9l-3 11h-9l2-11h-7l-4 5H2v-5h5l3-4H2z"/>
            <path fill="#17221f" d="M25 12h15v3H25z"/>
          </svg>
          <div class="ammo-group loaded-ammo" aria-hidden="true">
            <svg class="bullet-icon" viewBox="0 0 12 24" aria-hidden="true">
              <path fill="currentColor" d="M3 7c0-3.8 1.2-6 3-6s3 2.2 3 6v13H3z"/>
              <path fill="currentColor" d="M2 19h8v4H2z"/>
            </svg>
            <span class="ammo-count loaded-count">×20</span>
          </div>
          <div class="ammo-group reserve-ammo" aria-hidden="true">
            <svg class="magazine-icon" viewBox="0 0 16 24" aria-hidden="true">
              <path fill="none" stroke="currentColor" stroke-width="2" d="M2 2h12v4H2zM3 6h10v11c0 3-3 5-8 6l-2-3z"/>
              <path class="magazine-fill" fill="currentColor" d="M5 8h6v9c0 2-1.5 3.2-6 4z"/>
            </svg>
            <span class="ammo-count reserve-count">×1</span>
          </div>
          <div class="reload-track"><div class="reload-fill"></div></div>
        </div>
      </div>
      <div class="status-details" id="status-details" role="dialog" aria-label="角色状态与强化技能" hidden>
        <section class="status-details-card">
          <div class="status-details-header">
            <div><div class="status-details-kicker">角色信息</div><h2>角色状态</h2></div>
            <button class="status-details-close" type="button" aria-label="关闭角色状态">×</button>
          </div>
          <div class="status-detail-section">
            <div class="status-detail-heading"><span>生命值</span><strong class="detail-hp-text">100/100</strong></div>
            <div class="status-detail-track"><div class="status-detail-fill health detail-hp-fill"></div></div>
          </div>
          <div class="status-detail-section">
            <div class="status-detail-heading"><span>经验值</span><strong class="detail-exp-text">0/20</strong></div>
            <div class="status-detail-track"><div class="status-detail-fill experience detail-exp-fill"></div></div>
            <div class="status-detail-note">当前等级 <span class="detail-level">Lv 1</span></div>
          </div>
          <div class="status-detail-section">
            <div class="status-detail-heading"><span>强化技能点</span><strong class="detail-skill-points">已投入 0 点</strong></div>
            <div class="status-detail-list">
              <div><span>火力校准</span><strong class="detail-firepower-level">Lv 0/5</strong></div>
              <div><span>弹匣管理</span><strong class="detail-magazine-level">Lv 0/5</strong></div>
            </div>
          </div>
          <div class="status-detail-section">
            <div class="status-detail-heading"><span>武器列表</span></div>
            <div class="status-weapon-item">
              <div class="status-weapon-heading"><strong class="detail-weapon-name">空手</strong><span class="detail-weapon-equip">当前装备</span></div>
              <div class="detail-weapon-ammo">弹匣 20/20 发 · 备用 20 发</div>
              <div class="detail-weapon-stats">伤害 18 · 射速 5/秒 · 换弹 1.3 秒</div>
            </div>
          </div>
        </section>
      </div>
      <div class="mission-panel">
        <div class="mission-kicker">通关目标</div>
        <div class="mission-steps">拿到门禁卡 → 存活至电梯开门 → 乘坐电梯下班</div>
      </div>
      <div class="alert-banner">老板来了，立即撤离</div>
      <div class="hint">距离下班还有 120 秒</div>
      <div class="evac"><div>正在下班</div><div class="evac-track"><div class="evac-fill"></div></div></div>
      <div class="objective-arrow"></div>
      <div class="objective-label"></div>
      <div class="joystick"><div class="joystick-knob"></div></div>
      <div class="combat-controls">
        <div class="attack-mode-selector" role="group" aria-label="攻击方式切换器">
          <button class="mode-side mode-previous" type="button" aria-label="暂无可切换装备" disabled>—</button>
          <div class="mode-current" role="status" aria-label="当前攻击方式：空手">${COMBAT_ICONS.punch}<span>空手</span></div>
          <button class="mode-side mode-next" type="button" aria-label="暂无可切换装备" disabled>—</button>
        </div>
        <div class="combat-actions">
          <button class="fire-button" type="button" aria-label="射击" title="射击" hidden>${COMBAT_ICONS.fire}<span>射击</span></button>
          <button class="melee-button punch-button" type="button" aria-label="出拳，长按蓄力勾拳" title="出拳 · 长按蓄力">${COMBAT_ICONS.punch}<span>出拳</span></button>
          <button class="melee-button kick-button" type="button" aria-label="踢腿，长按蓄力旋风踢" title="踢腿 · 长按蓄力">${COMBAT_ICONS.kick}<span>踢腿</span></button>
        </div>
      </div>
      <div class="controls">WASD / 方向键移动 · J 出拳 · K 踢腿 · Q / E 切换方式</div>
      <div class="upgrade-panel" role="region" aria-label="选择强化">
        <div class="upgrade-box">
          <div class="upgrade-heading">
            <div class="upgrade-title">选择一项强化</div>
            <output class="upgrade-timer" aria-label="剩余选择时间">5.0 秒</output>
          </div>
          <div class="upgrade-subtitle">战斗继续 · 暂停获取经验 · 超时放弃</div>
          <div class="upgrade-timer-track"><div class="upgrade-timer-bar"></div></div>
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
      hpText: root.querySelector<HTMLDivElement>(".hp-value")!,
      hpBar: root.querySelector<HTMLDivElement>(".hp-fill")!,
      expText: root.querySelector<HTMLDivElement>(".exp-value")!,
      expBar: root.querySelector<HTMLDivElement>(".exp-fill")!,
      expTrack: root.querySelector<HTMLDivElement>(".exp-track")!,
      timer: root.querySelector<HTMLDivElement>(".timer")!,
      level: root.querySelector<HTMLDivElement>(".level")!,
      hudPanel: root.querySelector<HTMLDivElement>(".hud-panel")!,
      statusDetails: root.querySelector<HTMLDivElement>(".status-details")!,
      detailsCard: root.querySelector<HTMLElement>(".status-details-card")!,
      detailsClose: root.querySelector<HTMLButtonElement>(".status-details-close")!,
      detailHpText: root.querySelector<HTMLElement>(".detail-hp-text")!,
      detailHpBar: root.querySelector<HTMLDivElement>(".detail-hp-fill")!,
      detailExpText: root.querySelector<HTMLElement>(".detail-exp-text")!,
      detailExpBar: root.querySelector<HTMLDivElement>(".detail-exp-fill")!,
      detailLevel: root.querySelector<HTMLSpanElement>(".detail-level")!,
      detailSkillPoints: root.querySelector<HTMLElement>(".detail-skill-points")!,
      detailFirepowerLevel: root.querySelector<HTMLElement>(".detail-firepower-level")!,
      detailMagazineLevel: root.querySelector<HTMLElement>(".detail-magazine-level")!,
      detailWeaponName: root.querySelector<HTMLElement>(".detail-weapon-name")!,
      detailWeaponEquip: root.querySelector<HTMLElement>(".detail-weapon-equip")!,
      detailWeaponAmmo: root.querySelector<HTMLDivElement>(".detail-weapon-ammo")!,
      detailWeaponStats: root.querySelector<HTMLDivElement>(".detail-weapon-stats")!,
      missionPanel: root.querySelector<HTMLDivElement>(".mission-panel")!,
      alert: root.querySelector<HTMLDivElement>(".alert-banner")!,
      hint: root.querySelector<HTMLDivElement>(".hint")!,
      evac: root.querySelector<HTMLDivElement>(".evac")!,
      evacBar: root.querySelector<HTMLDivElement>(".evac-fill")!,
      arrow: root.querySelector<HTMLDivElement>(".objective-arrow")!,
      arrowLabel: root.querySelector<HTMLDivElement>(".objective-label")!,
      joystickBase: root.querySelector<HTMLDivElement>(".joystick")!,
      joystickKnob: root.querySelector<HTMLDivElement>(".joystick-knob")!,
      weaponPanel: root.querySelector<HTMLDivElement>(".weapon-panel")!,
      loadedAmmo: root.querySelector<HTMLSpanElement>(".loaded-count")!,
      reserveMagazines: root.querySelector<HTMLSpanElement>(".reserve-count")!,
      magazineFill: root.querySelector<SVGPathElement>(".magazine-fill")!,
      reloadBar: root.querySelector<HTMLDivElement>(".reload-fill")!,
      fireButton: root.querySelector<HTMLButtonElement>(".fire-button")!,
      punchButton: root.querySelector<HTMLButtonElement>(".punch-button")!,
      kickButton: root.querySelector<HTMLButtonElement>(".kick-button")!,
      previousMode: root.querySelector<HTMLButtonElement>(".mode-previous")!,
      nextMode: root.querySelector<HTMLButtonElement>(".mode-next")!,
      currentMode: root.querySelector<HTMLDivElement>(".mode-current")!,
      controls: root.querySelector<HTMLDivElement>(".controls")!,
      upgradePanel: root.querySelector<HTMLDivElement>(".upgrade-panel")!,
      upgradeTimer: root.querySelector<HTMLOutputElement>(".upgrade-timer")!,
      upgradeTimerBar: root.querySelector<HTMLDivElement>(".upgrade-timer-bar")!,
      upgradeOptions: root.querySelector<HTMLDivElement>(".upgrade-options")!,
      result: root.querySelector<HTMLDivElement>(".result")!,
      resultTitle: root.querySelector<HTMLDivElement>(".result-title")!,
    };
  }
}

new OfficeEscapeGame();
