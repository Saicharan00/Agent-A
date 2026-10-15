import type { AvatarShape, BotStatus } from '@agenta/shared';

/** Up to two initials: "Agent A" → "AA", "code-reviewer" → "CR", "echo" → "EC". */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Black or white text, whichever reads better on a #rrggbb background (WCAG relative luminance). */
export function readableTextColor(hex: string): '#000000' | '#ffffff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // Higher contrast wins: on black it's (L + 0.05) / 0.05, on white 1.05 / (L + 0.05); they meet near L = 0.179.
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#000000' : '#ffffff';
}

export const SHAPE_CLASS: Record<AvatarShape, string> = {
  circle: 'rounded-full',
  square: 'rounded-md',
  hexagon: '[clip-path:polygon(25%_5%,75%_5%,100%_50%,75%_95%,25%_95%,0%_50%)]',
};

export const STATUS_LABEL: Record<BotStatus, string> = {
  running: 'Computer running',
  starting: 'Computer starting',
  stopped: 'Computer stopped',
  error: 'Computer error',
};
