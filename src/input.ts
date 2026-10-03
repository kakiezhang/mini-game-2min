import * as THREE from "three";
import { PLAYER_CONFIG } from "./config.js";
import type { AttackMode } from "./attack-modes.js";
import { CombatInputBuffer, type MeleeKind, type MeleeRequest } from "./combat-input.js";
import { AttackGesture, normalizeAim, type AttackDirection } from "./attack-gesture.js";

export function projectAttackDrag(camera: THREE.Camera, playerX: number, playerZ: number,
  dx: number, dy: number, width: number, height: number): AttackDirection {
  camera.updateMatrixWorld(true);
  const origin = new THREE.Vector3(playerX, 0, playerZ).project(camera);
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const first = new THREE.Vector3(), second = new THREE.Vector3();
  raycaster.setFromCamera(new THREE.Vector2(origin.x, origin.y), camera);
  if (!raycaster.ray.intersectPlane(plane, first)) return { x: 0, z: -1 };
  raycaster.setFromCamera(new THREE.Vector2(origin.x + 2 * dx / width, origin.y - 2 * dy / height), camera);
  if (!raycaster.ray.intersectPlane(plane, second)) return { x: 0, z: -1 };
  return normalizeAim({ x: second.x - first.x, z: second.z - first.z });
}

const JOYSTICK_EDGE_OVERFLOW = 10;
const JOYSTICK_DEADZONE = 0.12;
const JOYSTICK_WALK_LIMIT = 0.5;
const JOYSTICK_JOG_LIMIT = 0.85;
const JOYSTICK_JOG_SPEED = 1.35;

export const getJoystickSpeedMultiplier = (strength: number) => {
  if (strength <= JOYSTICK_DEADZONE) return 0;
  if (strength <= JOYSTICK_WALK_LIMIT) return 1;
  if (strength <= JOYSTICK_JOG_LIMIT) {
    const progress = (strength - JOYSTICK_WALK_LIMIT) / (JOYSTICK_JOG_LIMIT - JOYSTICK_WALK_LIMIT);
    return 1 + progress * (JOYSTICK_JOG_SPEED - 1);
  }
  const runProgress = (Math.min(strength, 1) - JOYSTICK_JOG_LIMIT) / (1 - JOYSTICK_JOG_LIMIT);
  return JOYSTICK_JOG_SPEED + runProgress * (PLAYER_CONFIG.maxRunSpeedMultiplier - JOYSTICK_JOG_SPEED);
};

export type InputState = {
  moveX: number;
  moveZ: number;
  moveSpeedMultiplier: number;
  aimX: number;
  aimZ: number;
  aimPointX: number;
  aimPointZ: number;
  fireHeld: boolean;
  meleeRequests: MeleeRequest[];
  punchCharge: number;
  kickCharge: number;
  modeStep: -1 | 0 | 1;
  aimPreview?: AttackDirection & { kind: MeleeKind; canceled: boolean };
};

type JoystickElements = {
  base: HTMLElement;
  knob: HTMLElement;
};

export class InputController {
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly mouseNdc = new THREE.Vector2();
  private readonly aimPoint = new THREE.Vector3();
  private pointerAimQueued = false;
  private readonly combat = new CombatInputBuffer();
  private modeStep: -1 | 0 | 1 = 0;
  private lastAimX = 0;
  private lastAimZ = -1;
  private joystickActive = false;
  private joystickPointerId = -1;
  private joystickCenterX = 0;
  private joystickCenterY = 0;
  private joystickMaxDistance = 44;
  private joystickX = 0;
  private joystickZ = 0;
  private joystickSpeedMultiplier = 0;
  private mode: AttackMode = "unarmed";
  private explicitAim = false;
  private hasMouseAim = false;
  private readonly canvasAttackSources = new Set<string>();
  private playerX = 0;
  private playerZ = 0;
  private readonly attackGestures = new Map<string, { gesture: AttackGesture; button: HTMLButtonElement; x: number; y: number }>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly joystick: JoystickElements,
    private readonly buttons: {
      fire: HTMLButtonElement; punch: HTMLButtonElement; kick: HTMLButtonElement;
      previous: HTMLButtonElement; next: HTMLButtonElement;
    },
    private readonly options: { directionalMelee?: boolean; allowedMeleeKinds?: readonly MeleeKind[] } = {},
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointerup", this.onWindowPointerUp);
    window.addEventListener("pointercancel", this.onWindowPointerCancel);
    if (options.directionalMelee) window.addEventListener("resize", this.onBlur);
    canvas.addEventListener("pointermove", this.onCanvasPointerMove);
    canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    joystick.base.addEventListener("pointerdown", this.onJoystickDown);
    joystick.base.addEventListener("pointermove", this.onJoystickMove);
    joystick.base.addEventListener("pointerup", this.releaseJoystick);
    joystick.base.addEventListener("pointercancel", this.releaseJoystick);
    this.bindAttackButton(buttons.fire, "punch");
    this.bindAttackButton(buttons.punch, "punch");
    this.bindAttackButton(buttons.kick, "kick");
    this.bindModeButton(buttons.previous, -1);
    this.bindModeButton(buttons.next, 1);
  }

  getState(playerX: number, playerZ: number): InputState {
    this.playerX = playerX;
    this.playerZ = playerZ;
    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) moveX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) moveX += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) moveZ -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) moveZ += 1;
    const keyboardMoving = Math.hypot(moveX, moveZ) > 0.001;
    moveX += this.joystickX;
    moveZ += this.joystickZ;

    const moveLength = Math.hypot(moveX, moveZ);
    const moveSpeedMultiplier = moveLength <= 0.001 ? 0 : keyboardMoving
      ? this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? PLAYER_CONFIG.maxRunSpeedMultiplier : 1
      : this.joystickSpeedMultiplier;
    if (moveLength > 0.001) {
      moveX /= moveLength;
      moveZ /= moveLength;
      if (!this.directionalMelee || !this.explicitAim) {
        this.lastAimX = moveX;
        this.lastAimZ = moveZ;
      }
    }

    let aimPointX = playerX + this.lastAimX * 360;
    let aimPointZ = playerZ + this.lastAimZ * 360;
    if (this.directionalMelee ? this.hasMouseAim && !this.attackGestures.size : moveLength <= 0.001 && this.pointerAimQueued) {
      this.raycaster.setFromCamera(this.mouseNdc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.aimPoint)) {
        const aimX = this.aimPoint.x - playerX;
        const aimZ = this.aimPoint.z - playerZ;
        const aimLength = Math.hypot(aimX, aimZ);
        if (aimLength > 4) {
          this.lastAimX = aimX / aimLength;
          this.lastAimZ = aimZ / aimLength;
          if (this.directionalMelee) this.explicitAim = true;
          aimPointX = this.aimPoint.x;
          aimPointZ = this.aimPoint.z;
        }
      }
    }
    this.pointerAimQueued = false;
    if (this.directionalMelee) {
      for (const code of ["KeyJ", "KeyK"]) if (this.keys.has(code)) this.combat.setAim(code, this.currentAim);
      for (const source of this.canvasAttackSources) this.combat.setAim(source, this.currentAim);
    }

    const modeStep = this.modeStep;
    this.modeStep = 0;
    return {
      moveX,
      moveZ,
      moveSpeedMultiplier,
      aimX: this.lastAimX,
      aimZ: this.lastAimZ,
      aimPointX,
      aimPointZ,
      ...this.combat.consume(performance.now() / 1000),
      modeStep,
    };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea, [contenteditable=true]")) return;
    this.keys.add(event.code);
    if (["KeyJ", "KeyK", "KeyQ", "KeyE"].includes(event.code)) event.preventDefault();
    if (event.repeat) return;
    if (event.code === "KeyJ" || event.code === "KeyK") {
      this.pressAttack(event.code, event.code === "KeyJ" ? "punch" : "kick");
    }
    if (event.code === "KeyQ") this.modeStep = -1;
    if (event.code === "KeyE") this.modeStep = 1;
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
    this.combat.release(event.code, performance.now() / 1000);
  };

  private onBlur = () => {
    this.keys.clear();
    this.resetCombat();
    this.releaseJoystick();
  };

  resetCombat() {
    this.combat.reset();
    this.modeStep = 0;
    this.attackGestures.clear();
    this.canvasAttackSources.clear();
    for (const button of [this.buttons.fire, this.buttons.punch, this.buttons.kick]) {
      button.classList.remove("is-active", "is-canceling");
      button.style.setProperty("--aim-x", "0px");
      button.style.setProperty("--aim-y", "0px");
    }
  }

  reset(resetAim = false) {
    this.onBlur();
    if (resetAim) {
      this.explicitAim = false; this.hasMouseAim = false;
      this.lastAimX = 0; this.lastAimZ = -1;
    }
  }

  private get directionalMelee() { return this.options.directionalMelee && this.mode === "unarmed"; }
  private get currentAim() { return { x: this.lastAimX, z: this.lastAimZ }; }
  private pressAttack(source: string, kind: MeleeKind) {
    if (this.mode === "unarmed" && this.options.allowedMeleeKinds && !this.options.allowedMeleeKinds.includes(kind)) return;
    this.combat.press(source, kind, performance.now() / 1000, this.directionalMelee ? this.currentAim : undefined);
  }

  setAttackMode(mode: AttackMode) {
    this.resetCombat();
    this.combat.setMode(mode);
    this.mode = mode;
  }

  private onCanvasPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerAimQueued = true;
    this.hasMouseAim = true;
    if (this.directionalMelee) {
      this.raycaster.setFromCamera(this.mouseNdc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.aimPoint)) {
        const aim = normalizeAim({ x: this.aimPoint.x - this.playerX, z: this.aimPoint.z - this.playerZ });
        this.lastAimX = aim.x; this.lastAimZ = aim.z; this.explicitAim = true;
        for (const code of ["KeyJ", "KeyK", `pointer-${event.pointerId}`]) this.combat.setAim(code, aim);
      }
    }
  };

  private onCanvasPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    this.onCanvasPointerMove(event);
    if (this.directionalMelee) this.canvasAttackSources.add(`pointer-${event.pointerId}`);
    this.pressAttack(`pointer-${event.pointerId}`, "punch");
  };

  private onWindowPointerUp = (event: PointerEvent) => {
    if (this.canvasAttackSources.delete(`pointer-${event.pointerId}`)) this.onCanvasPointerMove(event);
    this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000);
  };
  private onWindowPointerCancel = (event: PointerEvent) => {
    this.canvasAttackSources.delete(`pointer-${event.pointerId}`);
    this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000, true);
  };

  private bindAttackButton(button: HTMLButtonElement, kind: MeleeKind) {
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || button.disabled) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      const source = `pointer-${event.pointerId}`;
      if (this.directionalMelee) {
        this.hasMouseAim = false;
        this.attackGestures.set(source, { gesture: new AttackGesture(this.currentAim), button, x: event.clientX, y: event.clientY });
      }
      this.pressAttack(source, kind);
      button.classList.add("is-active");
    });
    const move = (event: PointerEvent) => {
      const source = `pointer-${event.pointerId}`;
      const held = this.attackGestures.get(source);
      if (!held) return;
      held.gesture.move(event.clientX - held.x, event.clientY - held.y, (dx, dy) => {
        const rect = this.canvas.getBoundingClientRect();
        return projectAttackDrag(this.camera, this.playerX, this.playerZ, dx, dy, rect.width, rect.height);
      });
      this.combat.setAim(source, held.gesture.direction, held.gesture.canceled);
      if (held.gesture.dragged && !held.gesture.canceled) {
        this.lastAimX = held.gesture.direction.x; this.lastAimZ = held.gesture.direction.z; this.explicitAim = true;
      }
      button.classList.toggle("is-canceling", held.gesture.canceled);
      button.style.setProperty("--aim-x", `${held.gesture.knobX}px`);
      button.style.setProperty("--aim-y", `${held.gesture.knobY}px`);
    };
    button.addEventListener("pointermove", move);
    const release = (event: PointerEvent) => {
      if (event.type === "pointerup") move(event);
      this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000, event.type !== "pointerup");
      this.attackGestures.delete(`pointer-${event.pointerId}`);
      button.classList.remove("is-active", "is-canceling");
      button.style.setProperty("--aim-x", "0px"); button.style.setProperty("--aim-y", "0px");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    // Keyboard and assistive activation have no pointer sequence.
    button.addEventListener("click", event => {
      if (event.detail !== 0) return;
      const now = performance.now() / 1000;
      this.pressAttack("accessible-click", kind);
      this.combat.release("accessible-click", now);
    });
  }

  private bindModeButton(button: HTMLButtonElement, direction: -1 | 1) {
    let pointerId: number | undefined;
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || button.disabled || pointerId !== undefined) return;
      event.preventDefault();
      pointerId = event.pointerId;
      button.setPointerCapture(event.pointerId);
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = undefined;
      if (event.type !== "pointerup" || button.disabled) return;
      const rect = button.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom) return;
      // The page prevents multi-touch gestures, which also suppresses click
      // when another finger holds the joystick. Pointer events still arrive.
      this.modeStep = direction;
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("click", event => {
      // Preserve keyboard/assistive activation without applying a pointer tap twice.
      if (event.detail === 0 && !button.disabled) this.modeStep = direction;
    });
  }

  private onJoystickDown = (event: PointerEvent) => {
    event.preventDefault();
    this.joystickActive = true;
    this.joystickPointerId = event.pointerId;
    const rect = this.joystick.base.getBoundingClientRect();
    this.joystickCenterX = rect.left + rect.width / 2;
    this.joystickCenterY = rect.top + rect.height / 2;
    const knobWidth = this.joystick.knob.getBoundingClientRect().width;
    this.joystickMaxDistance = (rect.width - knobWidth) / 2 + JOYSTICK_EDGE_OVERFLOW;
    this.joystick.base.setPointerCapture(event.pointerId);
    this.updateJoystick(event.clientX, event.clientY);
  };

  private onJoystickMove = (event: PointerEvent) => {
    event.preventDefault();
    if (!this.joystickActive || this.joystickPointerId !== event.pointerId) return;
    this.updateJoystick(event.clientX, event.clientY);
  };

  private updateJoystick(clientX: number, clientY: number) {
    const deltaX = clientX - this.joystickCenterX;
    const deltaY = clientY - this.joystickCenterY;
    const distance = Math.min(Math.hypot(deltaX, deltaY), this.joystickMaxDistance);
    const strength = distance / this.joystickMaxDistance;
    const angle = Math.atan2(deltaY, deltaX);
    this.joystickX = strength > JOYSTICK_DEADZONE ? Math.cos(angle) : 0;
    this.joystickZ = strength > JOYSTICK_DEADZONE ? Math.sin(angle) : 0;
    this.joystickSpeedMultiplier = getJoystickSpeedMultiplier(strength);
    this.joystick.base.classList.toggle("is-jogging", this.joystickSpeedMultiplier >= 1.08
      && this.joystickSpeedMultiplier < 1.4);
    this.joystick.base.classList.toggle("is-running", this.joystickSpeedMultiplier >= 1.4);
    this.joystick.knob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance}px))`;
  }

  private releaseJoystick = () => {
    this.joystickActive = false;
    this.joystickPointerId = -1;
    this.joystickX = 0;
    this.joystickZ = 0;
    this.joystickSpeedMultiplier = 0;
    this.joystick.base.classList.remove("is-jogging");
    this.joystick.base.classList.remove("is-running");
    this.joystick.knob.style.transform = "translate(-50%, -50%)";
  };
}
