// Audio file fields — mp3 / m4a / wav / ogg / flac. The values come from the
// metadata the audio source handler (server/sources/audio.js) reads at ingest
// via music-metadata and stamps onto `meta` (duration, bitrate, sample rate,
// channels, codec). Any field the handler couldn't determine is simply null on
// that instance.
export const group = "Audio";
export const appliesTo = ["audio"];

export const fields = [
  { key: "duration", fn: "duration", kind: "number", label: "Duration" },
  { key: "bitrate", fn: "bitrate", kind: "number", label: "Bitrate" },
  { key: "sample_rate", fn: "sample_rate", kind: "number", label: "Sample rate" },
  { key: "channels", fn: "channels", kind: "number", label: "Channels" },
  { key: "codec", fn: "codec", kind: "text", label: "Codec" },
];

export function extract(ctx) {
  return {
    duration: ctx.meta?.duration ?? null,
    bitrate: ctx.meta?.bitrate ?? null,
    sample_rate: ctx.meta?.sample_rate ?? null,
    channels: ctx.meta?.channels ?? null,
    codec: ctx.meta?.codec || null,
  };
}
