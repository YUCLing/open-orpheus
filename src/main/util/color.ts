type RgbColor = { r: number; g: number; b: number };

export function hexToRgb(hex: string): RgbColor {
  // Accept "#rrggbb" or "rrggbb" (and optional 3-digit shorthand)
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }

  let digits = match[1];
  if (digits.length === 3) {
    // Expand shorthand: "abc" -> "aabbcc"
    digits = digits
      .split("")
      .map((c) => c + c)
      .join("");
  }

  const int = parseInt(digits, 16);
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff,
  };
}
