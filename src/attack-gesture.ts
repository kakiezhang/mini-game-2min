export type AttackDirection = { x: number; z: number };
export const AIM_DEADZONE = 8;
export const AIM_CANCEL_RADIUS = 6;
export const AIM_KNOB_RADIUS = 32;

export function normalizeAim(direction: AttackDirection): AttackDirection {
  const length = Math.hypot(direction.x, direction.z);
  return Number.isFinite(length) && length > 1e-6
    ? { x: direction.x / length, z: direction.z / length } : { x: 0, z: -1 };
}

/** A gesture owns its direction; another finger or movement cannot overwrite it. */
export class AttackGesture {
  direction: AttackDirection;
  dragged = false;
  canceled = false;
  knobX = 0;
  knobY = 0;

  constructor(direction: AttackDirection) { this.direction = normalizeAim(direction); }

  move(dx: number, dy: number, project: (x: number, y: number) => AttackDirection) {
    const length = Math.hypot(dx, dy);
    const scale = length > AIM_KNOB_RADIUS ? AIM_KNOB_RADIUS / length : 1;
    this.knobX = dx * scale;
    this.knobY = dy * scale;
    if (length >= AIM_DEADZONE) {
      this.dragged = true;
      this.canceled = false;
      this.direction = normalizeAim(project(dx, dy));
    } else if (this.dragged && length <= AIM_CANCEL_RADIUS) {
      this.canceled = true;
    }
  }
}
