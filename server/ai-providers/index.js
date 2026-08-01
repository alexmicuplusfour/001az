// The built-in AI providers. Each is a factory (wires) => descriptor — the SAME
// contract an ai-provider plugin's factory returns (see plugin-loader.js) — so a
// built-in and a dropped-in plugin enter the registry through the identical path;
// the only difference is a plugin is stamped `external`. The engine (providers.js)
// calls each with the shared WIRES and registers the result. This file is the ONE
// place the built-in roster is named; adding a built-in is one import + one entry.
//
// Order is the registry/catalog display order: the always-on on-device engines
// first (local embedder, whisper transcriber), then the keyed providers.
import anthropic from "./anthropic.js";
import openai from "./openai.js";
import gemini from "./gemini.js";
import glm from "./glm.js";
import openrouter from "./openrouter.js";
import local from "./local.js";
import whisper from "./whisper.js";
import localDetector from "./local-detector.js";

export const BUILTIN_PROVIDERS = { local, whisper, localDetector, anthropic, openai, gemini, glm, openrouter };
