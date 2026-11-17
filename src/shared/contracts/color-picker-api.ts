export interface Color {
  hexString: `#${string}`;
  rgb: { r: number; g: number; b: number };
  hsl: { h: number; s: number; l: number };
}

export interface ColorPickerContract {
  initialValue(): Promise<`#${string}`>;
  save(value: Color): Promise<void>;
}
