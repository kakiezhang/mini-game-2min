#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const usage = `
Usage:
  node scripts/repack-sprite-sheet.mjs --input <sheet.png> --output <sheet.png> --cols <n> --rows <n> [options]

Options:
  --cell-width <px>    Output cell width. Default: 512
  --cell-height <px>   Output cell height. Default: 320
  --padding <px>       Transparent padding inside each output cell. Default: 10

Example:
  node scripts/repack-sprite-sheet.mjs --input src/assets/characters/player-monkey-sheet.png --output src/assets/characters/player-monkey-sheet.png --cols 5 --rows 8
`.trim();

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.input || !args.output || !args.cols || !args.rows) {
  console.log(usage);
  process.exit(args.help ? 0 : 1);
}

const inputPath = path.resolve(args.input);
const outputPath = path.resolve(args.output);
const columns = readInteger(args.cols, "cols");
const rows = readInteger(args.rows, "rows");
const outputCellWidth = readInteger(args["cell-width"] ?? "512", "cell-width");
const outputCellHeight = readInteger(args["cell-height"] ?? "320", "cell-height");
const padding = readInteger(args.padding ?? "10", "padding");

const source = PNG.sync.read(fs.readFileSync(inputPath));
const sourceCells = readSourceCells(source, columns, rows);
const maxContentWidth = Math.max(...sourceCells.map((cell) => cell.bounds.sourceWidth));
const maxContentHeight = Math.max(...sourceCells.map((cell) => cell.bounds.sourceHeight));
const usableWidth = Math.max(1, outputCellWidth - padding * 2);
const usableHeight = Math.max(1, outputCellHeight - padding * 2);
const contentScale = Math.min(usableWidth / maxContentWidth, usableHeight / maxContentHeight);
const output = new PNG({
  width: columns * outputCellWidth,
  height: rows * outputCellHeight,
  colorType: 6,
});
output.data.fill(0);

for (const cell of sourceCells) {
  copyCell(source, output, {
    ...cell.bounds,
    targetX: cell.column * outputCellWidth,
    targetY: cell.row * outputCellHeight,
    targetWidth: outputCellWidth,
    targetHeight: outputCellHeight,
    padding,
    scale: contentScale,
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, PNG.sync.write(output));
console.log(`Wrote ${outputPath}`);
console.log(`Output size: ${output.width}x${output.height}`);
console.log(`Content scale: ${contentScale.toFixed(4)}`);

function copyCell(source, output, cell) {
  const drawnWidth = Math.round(cell.sourceWidth * cell.scale);
  const drawnHeight = Math.round(cell.sourceHeight * cell.scale);
  const anchorX = cell.targetX + Math.floor(cell.targetWidth / 2);
  const anchorY = cell.targetY + cell.targetHeight - cell.padding;
  const offsetX = anchorX - Math.floor(drawnWidth / 2);
  const offsetY = anchorY - drawnHeight;

  for (let y = 0; y < drawnHeight; y += 1) {
    for (let x = 0; x < drawnWidth; x += 1) {
      const outputX = offsetX + x;
      const outputY = offsetY + y;
      if (outputX < cell.targetX || outputX >= cell.targetX + cell.targetWidth || outputY < cell.targetY || outputY >= cell.targetY + cell.targetHeight) continue;

      const sourceLocalX = (x + 0.5) / cell.scale - 0.5;
      const sourceLocalY = (y + 0.5) / cell.scale - 0.5;
      const sample = sampleBilinear(source, cell.sourceX + sourceLocalX, cell.sourceY + sourceLocalY);
      const outputIndex = (outputY * output.width + outputX) << 2;
      output.data[outputIndex] = sample.red;
      output.data[outputIndex + 1] = sample.green;
      output.data[outputIndex + 2] = sample.blue;
      output.data[outputIndex + 3] = sample.alpha;
    }
  }
}

function readSourceCells(source, columns, rows) {
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    const cellY = Math.round((source.height * row) / rows);
    const cellNextY = Math.round((source.height * (row + 1)) / rows);

    for (let column = 0; column < columns; column += 1) {
      const cellX = Math.round((source.width * column) / columns);
      const cellNextX = Math.round((source.width * (column + 1)) / columns);
      const bounds = findOpaqueBounds(source, cellX, cellY, cellNextX, cellNextY);
      cells.push({ row, column, bounds });
    }
  }
  return cells;
}

function findOpaqueBounds(image, startX, startY, endX, endY) {
  let minX = endX;
  let minY = endY;
  let maxX = startX;
  let maxY = startY;

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const alpha = image.data[((y * image.width + x) << 2) + 3];
      if (alpha <= 10) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (minX > maxX || minY > maxY) {
    return {
      sourceX: startX,
      sourceY: startY,
      sourceWidth: endX - startX,
      sourceHeight: endY - startY,
    };
  }

  return {
    sourceX: minX,
    sourceY: minY,
    sourceWidth: maxX - minX + 1,
    sourceHeight: maxY - minY + 1,
  };
}

function sampleBilinear(image, x, y) {
  const minX = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const minY = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const maxX = Math.max(0, Math.min(image.width - 1, minX + 1));
  const maxY = Math.max(0, Math.min(image.height - 1, minY + 1));
  const tx = x - Math.floor(x);
  const ty = y - Math.floor(y);
  const top = mixPixel(readPixel(image, minX, minY), readPixel(image, maxX, minY), tx);
  const bottom = mixPixel(readPixel(image, minX, maxY), readPixel(image, maxX, maxY), tx);
  return mixPixel(top, bottom, ty);
}

function readPixel(image, x, y) {
  const index = (y * image.width + x) << 2;
  return {
    red: image.data[index],
    green: image.data[index + 1],
    blue: image.data[index + 2],
    alpha: image.data[index + 3],
  };
}

function mixPixel(first, second, amount) {
  const inverse = 1 - amount;
  return {
    red: Math.round(first.red * inverse + second.red * amount),
    green: Math.round(first.green * inverse + second.green * amount),
    blue: Math.round(first.blue * inverse + second.blue * amount),
    alpha: Math.round(first.alpha * inverse + second.alpha * amount),
  };
}

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

function readInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected --${label} to be a positive integer, got: ${value}`);
  return parsed;
}
