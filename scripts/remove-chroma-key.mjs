#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const usage = `
Usage:
  npm run remove-green -- --input <source.png> --output <transparent.png> [options]

Options:
  --key <hex>          Chroma key color. Default: #00ff00
  --tolerance <num>    Fully transparent distance threshold. Default: 38
  --softness <num>     Edge feather distance after tolerance. Default: 48
  --despill <num>      Green spill reduction, 0-1. Default: 0.65

Example:
  npm run remove-green -- --input src/assets/raw/player-monkey.png --output src/assets/characters/player-monkey.png
`.trim();

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.input || !args.output) {
  console.log(usage);
  process.exit(args.help ? 0 : 1);
}

const key = parseHexColor(args.key ?? "#00ff00");
const tolerance = readNumber(args.tolerance, 38, "tolerance");
const softness = readNumber(args.softness, 48, "softness");
const despill = Math.max(0, Math.min(1, readNumber(args.despill, 0.65, "despill")));

const inputPath = path.resolve(args.input);
const outputPath = path.resolve(args.output);

if (!fs.existsSync(inputPath)) {
  throw new Error(`Input file does not exist: ${inputPath}`);
}

const source = PNG.sync.read(fs.readFileSync(inputPath));
let transparentPixels = 0;
let featheredPixels = 0;

for (let y = 0; y < source.height; y += 1) {
  for (let x = 0; x < source.width; x += 1) {
    const index = (source.width * y + x) << 2;
    const red = source.data[index];
    const green = source.data[index + 1];
    const blue = source.data[index + 2];
    const alpha = source.data[index + 3];
    if (alpha === 0) continue;

    const distance = colorDistance(red, green, blue, key.red, key.green, key.blue);
    if (distance <= tolerance) {
      source.data[index + 3] = 0;
      transparentPixels += 1;
      continue;
    }

    const edgeLimit = tolerance + softness;
    if (softness > 0 && distance < edgeLimit) {
      const edgeAlpha = Math.round(((distance - tolerance) / softness) * alpha);
      source.data[index + 3] = Math.min(alpha, Math.max(0, edgeAlpha));
      featheredPixels += 1;
    }

    removeGreenSpill(source.data, index, key, distance, edgeLimit, despill);
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, PNG.sync.write(source));

console.log(`Wrote ${outputPath}`);
console.log(`Transparent pixels: ${transparentPixels}`);
console.log(`Feathered edge pixels: ${featheredPixels}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function parseHexColor(value) {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Expected --key to be a 6-digit hex color, got: ${value}`);
  }
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function readNumber(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected --${label} to be a number, got: ${value}`);
  return parsed;
}

function colorDistance(redA, greenA, blueA, redB, greenB, blueB) {
  const redDelta = redA - redB;
  const greenDelta = greenA - greenB;
  const blueDelta = blueA - blueB;
  return Math.sqrt(redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta);
}

function removeGreenSpill(data, index, key, distance, edgeLimit, amount) {
  if (amount <= 0 || edgeLimit <= 0) return;
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const greenDominance = green - Math.max(red, blue);
  if (greenDominance <= 0) return;

  const closeness = Math.max(0, 1 - distance / edgeLimit);
  if (closeness <= 0) return;

  const targetGreen = Math.max(red, blue, key.green * 0.18);
  const reduction = (green - targetGreen) * closeness * amount;
  data[index + 1] = Math.max(0, Math.round(green - reduction));
}
