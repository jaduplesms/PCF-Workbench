import { PNG } from 'pngjs';
import { assertDiffThreshold, diffPngBuffers } from './pixel-diff';

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    png.data[idx] = rgba[0];
    png.data[idx + 1] = rgba[1];
    png.data[idx + 2] = rgba[2];
    png.data[idx + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

function setPixel(buffer: Buffer, x: number, y: number, rgba: [number, number, number, number]): Buffer {
  const png = PNG.sync.read(buffer);
  const idx = (y * png.width + x) * 4;
  png.data[idx] = rgba[0];
  png.data[idx + 1] = rgba[1];
  png.data[idx + 2] = rgba[2];
  png.data[idx + 3] = rgba[3];
  return PNG.sync.write(png);
}

describe('diffPngBuffers', () => {
  it('returns zero diff ratio for identical images', () => {
    const a = solidPng(8, 8, [255, 255, 255, 255]);
    const b = solidPng(8, 8, [255, 255, 255, 255]);

    const result = diffPngBuffers(a, b);
    expect(result.diffPixels).toBe(0);
    expect(result.diffRatio).toBe(0);
    expect(result.totalPixels).toBe(64);
    expect(result.diffPng.byteLength).toBeGreaterThan(0);
  });

  it('reports non-zero diff when one pixel changes', () => {
    const a = solidPng(8, 8, [255, 255, 255, 255]);
    const b = setPixel(a, 0, 0, [0, 0, 0, 255]);

    const result = diffPngBuffers(a, b);
    expect(result.diffPixels).toBe(1);
    expect(result.diffRatio).toBeCloseTo(1 / 64, 6);
  });

  it('throws on dimension mismatch', () => {
    const a = solidPng(8, 8, [255, 255, 255, 255]);
    const b = solidPng(9, 8, [255, 255, 255, 255]);
    expect(() => diffPngBuffers(a, b)).toThrow(/dimensions do not match/i);
  });
});

describe('assertDiffThreshold', () => {
  it('accepts values in [0, 1]', () => {
    expect(() => assertDiffThreshold(0)).not.toThrow();
    expect(() => assertDiffThreshold(0.5)).not.toThrow();
    expect(() => assertDiffThreshold(1)).not.toThrow();
  });

  it('rejects invalid values', () => {
    expect(() => assertDiffThreshold(-0.01)).toThrow(/between 0 and 1/i);
    expect(() => assertDiffThreshold(1.1)).toThrow(/between 0 and 1/i);
    expect(() => assertDiffThreshold(Number.NaN)).toThrow(/between 0 and 1/i);
  });
});

