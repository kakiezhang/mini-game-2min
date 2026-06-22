import * as THREE from "three";

export type InputState = {
  moveX: number;
  moveZ: number;
  aimX: number;
  aimZ: number;
  aimPointX: number;
  aimPointZ: number;
  fireHeld: boolean;
  reloadPressed: boolean;
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
  private fireHeld = false;
  private fireQueued = false;
  private reloadQueued = false;
  private lastAimX = 0;
  private lastAimZ = -1;
  private joystickActive = false;
  private joystickPointerId = -1;
  private joystickCenterX = 0;
  private joystickCenterY = 0;
  private joystickX = 0;
  private joystickZ = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly joystick: JoystickElements,
    private readonly fireButton: HTMLElement,
    private readonly reloadButton: HTMLElement,
  ) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointerup", this.onWindowPointerUp);
    canvas.addEventListener("pointermove", this.onCanvasPointerMove);
    canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    joystick.base.addEventListener("pointerdown", this.onJoystickDown);
    joystick.base.addEventListener("pointermove", this.onJoystickMove);
    joystick.base.addEventListener("pointerup", this.releaseJoystick);
    joystick.base.addEventListener("pointercancel", this.releaseJoystick);
    fireButton.addEventListener("pointerdown", this.onFireButtonDown);
    fireButton.addEventListener("pointerup", this.onFireButtonUp);
    fireButton.addEventListener("pointercancel", this.onFireButtonUp);
    reloadButton.addEventListener("pointerdown", this.onReloadButtonDown);
    reloadButton.addEventListener("pointerup", this.onReloadButtonUp);
    reloadButton.addEventListener("pointercancel", this.onReloadButtonUp);
  }

  getState(playerX: number, playerZ: number): InputState {
    let moveX = 0;
    let moveZ = 0;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) moveX -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) moveX += 1;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) moveZ -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) moveZ += 1;
    moveX += this.joystickX;
    moveZ += this.joystickZ;

    const moveLength = Math.hypot(moveX, moveZ);
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

    const reloadPressed = this.reloadQueued;
    const fireRequested = this.fireHeld || this.fireQueued || this.keys.has("KeyJ");
    this.reloadQueued = false;
    this.fireQueued = false;
    return {
      moveX,
      moveZ,
      aimX: this.lastAimX,
      aimZ: this.lastAimZ,
      aimPointX,
      aimPointZ,
      fireHeld: fireRequested,
      reloadPressed,
    };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.code);
    if (event.code === "KeyR" && !event.repeat) this.reloadQueued = true;
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private onBlur = () => {
    this.keys.clear();
    this.fireHeld = false;
    this.fireButton.classList.remove("is-active");
    this.reloadButton.classList.remove("is-active");
    this.releaseJoystick();
  };

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
    this.fireHeld = true;
    this.fireQueued = true;
  };

  private onWindowPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.button === 0) this.fireHeld = false;
  };

  private onFireButtonDown = (event: PointerEvent) => {
    event.preventDefault();
    this.fireButton.setPointerCapture(event.pointerId);
    this.fireHeld = true;
    this.fireQueued = true;
    this.fireButton.classList.add("is-active");
  };

  private onFireButtonUp = () => {
    this.fireHeld = false;
    this.fireButton.classList.remove("is-active");
  };

  private onReloadButtonDown = (event: PointerEvent) => {
    event.preventDefault();
    this.reloadButton.setPointerCapture(event.pointerId);
    this.reloadQueued = true;
    this.reloadButton.classList.add("is-active");
  };

  private onReloadButtonUp = () => {
    this.reloadButton.classList.remove("is-active");
  };

  private onJoystickDown = (event: PointerEvent) => {
    event.preventDefault();
    this.joystickActive = true;
    this.joystickPointerId = event.pointerId;
    const rect = this.joystick.base.getBoundingClientRect();
    this.joystickCenterX = rect.left + rect.width / 2;
    this.joystickCenterY = rect.top + rect.height / 2;
    this.joystick.base.setPointerCapture(event.pointerId);
    this.updateJoystick(event.clientX, event.clientY);
  };

  private onJoystickMove = (event: PointerEvent) => {
    event.preventDefault();
    if (!this.joystickActive || this.joystickPointerId !== event.pointerId) return;
    this.updateJoystick(event.clientX, event.clientY);
  };

  private updateJoystick(clientX: number, clientY: number) {
    const maxDistance = 58;
    const deltaX = clientX - this.joystickCenterX;
    const deltaY = clientY - this.joystickCenterY;
    const distance = Math.min(Math.hypot(deltaX, deltaY), maxDistance);
    const angle = Math.atan2(deltaY, deltaX);
    this.joystickX = (Math.cos(angle) * distance) / maxDistance;
    this.joystickZ = (Math.sin(angle) * distance) / maxDistance;
    this.joystick.knob.style.transform = `translate(calc(-50% + ${Math.cos(angle) * distance}px), calc(-50% + ${Math.sin(angle) * distance}px))`;
  }

  private releaseJoystick = () => {
    this.joystickActive = false;
    this.joystickPointerId = -1;
    this.joystickX = 0;
    this.joystickZ = 0;
    this.joystick.knob.style.transform = "translate(-50%, -50%)";
  };
}
