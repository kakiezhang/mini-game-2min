const hashSeed = (seed: string) => {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
};

export const normalizeSeed = (seed: string | number) => {
  if (typeof seed === "number") return seed >>> 0;
  const numericSeed = Number(seed);
  return Number.isSafeInteger(numericSeed) ? numericSeed >>> 0 : hashSeed(seed);
};

export class SeededRandom {
  readonly seed: number;
  private state: number;

  constructor(seed: string | number) {
    this.seed = normalizeSeed(seed);
    this.state = this.seed;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number) {
    return min + (max - min) * this.next();
  }

  integer(maxExclusive: number) {
    return Math.floor(this.next() * maxExclusive);
  }
}
