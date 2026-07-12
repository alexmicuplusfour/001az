// Image file fields — original-resolution metadata sharp already decodes at
// ingest (server/sources/image.js), surfaced on the entry's `meta` bag. Pure
// data + a pure extractor; `appliesTo: "image"` so these are null on non-image
// instances (graceful degradation, like an AI field that couldn't be found).
export const group = "Images";
export const appliesTo = "image";

export const fields = [
  { key: "width", fn: "width", kind: "number", label: "Width (px)" },
  { key: "height", fn: "height", kind: "number", label: "Height (px)" },
  { key: "megapixels", fn: "megapixels", kind: "number", label: "Megapixels" },
  { key: "aspect_ratio", fn: "aspect_ratio", kind: "text", label: "Aspect ratio" },
  { key: "format", fn: "format", kind: "text", label: "Format" },
];

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// A tidy ratio when it reduces to small whole numbers (16:9, 4:3), else a
// decimal (2.35:1) so oddball crops don't render "1049:591".
function aspectRatio(w, h) {
  const g = gcd(w, h) || 1;
  const rw = w / g, rh = h / g;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

export function extract(ctx) {
  const w = ctx.meta?.width ?? null;
  const h = ctx.meta?.height ?? null;
  return {
    width: w,
    height: h,
    megapixels: w && h ? Math.round((w * h) / 1e5) / 10 : null, // one decimal
    aspect_ratio: w && h ? aspectRatio(w, h) : null,
    format: ctx.meta?.format || null,
  };
}
