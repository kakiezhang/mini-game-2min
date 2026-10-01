import * as THREE from "three";
import { PLAYER_CONFIG } from "./config.js";
import type { AttackMode } from "./attack-modes.js";
import { CombatInputBuffer, type MeleeKind, type MeleeRequest } from "./combat-input.js";

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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly joystick: JoystickElements,
    private readonly buttons: {
      fire: HTMLButtonElement; punch: HTMLButtonElement; kick: HTMLButtonElement;
      previous: HTMLButtonElement; next: HTMLButtonElement;
    },
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointerup", this.onWindowPointerUp);
    window.addEventListener("pointercancel", this.onWindowPointerCancel);
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
      this.lastAimX = moveX;
      this.lastAimZ = moveZ;
    }

    let aimPointX = playerX + this.lastAimX * 360;
    let aimPointZ = playerZ + this.lastAimZ * 360;
    if (moveLength <= 0.001 && this.pointerAimQueued) {
      this.raycaster.setFromCamera(this.mouseNdc, this.camera);
      if (this.raycaster.ray.intersectPlane(this.groundPlane, this.aimPoint)) {
        const aimX = this.aimPoint.x - playerX;
        const aimZ = this.aimPoint.z - playerZ;
        const aimLength = Math.hypot(aimX, aimZ);
        if (aimLength > 4) {
          this.lastAimX = aimX / aimLength;
          this.lastAimZ = aimZ / aimLength;
          aimPointX = this.aimPoint.x;
          aimPointZ = this.aimPoint.z;
        }
      }
    }
    this.pointerAimQueued = false;

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
      this.combat.press(event.code, event.code === "KeyJ" ? "punch" : "kick", performance.now() / 1000);
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
    for (const button of [this.buttons.fire, this.buttons.punch, this.buttons.kick]) button.classList.remove("is-active");
  }

  setAttackMode(mode: AttackMode) {
    this.resetCombat();
    this.combat.setMode(mode);
  }

  private onCanvasPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const rect = this.canvas.getBoundingClientRect();
    this.mouseNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerAimQueued = true;
  };

  private onCanvasPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    this.onCanvasPointerMove(event);
    this.combat.press(`pointer-${event.pointerId}`, "punch", performance.now() / 1000);
  };

  private onWindowPointerUp = (event: PointerEvent) => {
    this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000);
  };
  private onWindowPointerCancel = (event: PointerEvent) => {
    this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000, true);
  };

  private bindAttackButton(button: HTMLButtonElement, kind: MeleeKind) {
    button.addEventListener("pointerdown", event => {
      if (event.button !== 0 || button.disabled) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      this.combat.press(`pointer-${event.pointerId}`, kind, performance.now() / 1000);
      button.classList.add("is-active");
    });
    const release = (event: PointerEvent) => {
      this.combat.release(`pointer-${event.pointerId}`, performance.now() / 1000, event.type !== "pointerup");
      button.classList.remove("is-active");
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    // Keyboard and assistive activation have no pointer sequence.
    button.addEventListener("click", event => {
      if (event.detail !== 0) return;
      const now = performance.now() / 1000;
      this.combat.press("accessible-click", kind, now);
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
