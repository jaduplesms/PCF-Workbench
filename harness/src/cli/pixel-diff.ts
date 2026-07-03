import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export interface PixelDiffResult {
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  diffPng: Buffer;
}

/**
 * Compare two PNG buffers pixel-by-pixel.
 *
 * `perPixelThreshold` is pixelmatch's per-pixel colour-distance tolerance
 * (0..1, higher = more forgiving of anti-aliasing / sub-pixel noise). It is
 * NOT the overall diff-ratio gate — callers compare the returned `diffRatio`
 * against their own budget (see `batch` in bin/pcfworkbench.ts).
 */
export function diffPngBuffers(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  perPixelThreshold = 0.1,
): PixelDiffResult {
  const baseline = PNG.sync.read(baselineBuffer);
  const current = PNG.sync.read(currentBuffer);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new Error(
      `Image dimensions do not match: baseline ${baseline.width}x${baseline.height}, current ${current.width}x${current.height}`,
    );
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: perPixelThreshold },
  );
  const totalPixels = baseline.width * baseline.height;

  return {
    diffPixels,
    totalPixels,
    diffRatio: totalPixels > 0 ? diffPixels / totalPixels : 0,
    diffPng: PNG.sync.write(diff),
  };
}

export function assertDiffThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`--diff-threshold must be a number between 0 and 1. Received: ${threshold}`);
  }
}

