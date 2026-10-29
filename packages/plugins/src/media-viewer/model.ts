export type FitMode = 'fit' | 'width' | 'actual' | 'manual';
export function rasterScale(width: number, height: number, dpr: number, budget: number) {
  return Math.min(dpr, Math.sqrt(budget / (width * height)), 16384 / width, 16384 / height);
}
export type ViewerOptions = {
  zoomStep: number;
  maxCanvasPixels: number;
  imageBackground: 'theme' | 'checkerboard';
};
export function viewerOptions(value: unknown): ViewerOptions {
  const config = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    zoomStep:
      typeof config.zoomStep === 'number' &&
      Number.isFinite(config.zoomStep) &&
      config.zoomStep >= 1.05 &&
      config.zoomStep <= 2
        ? config.zoomStep
        : 1.2,
    maxCanvasPixels:
      typeof config.maxCanvasPixels === 'number' &&
      Number.isFinite(config.maxCanvasPixels) &&
      config.maxCanvasPixels >= 1_000_000 &&
      config.maxCanvasPixels <= 32_000_000
        ? config.maxCanvasPixels
        : 16_000_000,
    imageBackground: config.imageBackground === 'theme' ? 'theme' : 'checkerboard',
  };
}
export function fitScale(
  mode: FitMode,
  width: number,
  height: number,
  availableWidth: number,
  availableHeight: number,
  manual: number,
) {
  const scale =
    mode === 'actual'
      ? 1
      : mode === 'manual'
        ? manual
        : mode === 'width'
          ? availableWidth / width
          : Math.min(availableWidth / width, availableHeight / height);
  return Math.max(0.02, Math.min(16, Number.isFinite(scale) && scale > 0 ? scale : 1));
}
export function textMatches(text: string, query: string, limit = 200) {
  const matches: number[] = [];
  if (!query) return matches;
  // Case-insensitive matching keeps offsets in the original UTF-16 text.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && matches.length < limit) matches.push(match.index);
  return matches;
}
