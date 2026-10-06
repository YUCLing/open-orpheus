import type photon from "@silvia-odwyer/photon-node";

export async function extractColor(image: photon.PhotonImage): Promise<string> {
  const width = image.get_width();
  const height = image.get_height();
  const cx = Math.max(0, Math.floor(width / 2));
  const cy = Math.max(0, Math.floor(height / 2));
  const data = image.get_raw_pixels();
  const offset = (cy * width + cx) * 4;
  const r = data[offset] ?? 0;
  const g = data[offset + 1] ?? 0;
  const b = data[offset + 2] ?? 0;
  const a = data[offset + 3] ?? 255;
  return `#${[r, g, b, a].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
