// Dynamic plugin loader (phase 2). Loads external, dynamically-installed plugins
// — code fetched from a URL and npm-installed onto the /data/plugins volume
// (fetch/install is server/plugin-fetch.js, slice 2) — and registers them into
// the live registries (PROVIDERS / CONNECTORS) so they flow through the same
// catalog (server/plugins.js) as built-ins.
//
// Three invariants make runtime code-loading trustworthy:
//  1. Validate everything BEFORE touching a registry (register-last): a manifest
//     or factory that fails leaves ZERO writes — never a half-registered map.
//  2. The contract carries the protocol: ctx (server/plugin-ctx.js) hands a
//     plugin the runtime's own deadlines and error shape — ctx.fetchJson's
//     errors carry .status/.retryAfter — so a plugin's 429 backs off through
//     core's rate-limit + retry (runtime.js withRetry) like a built-in's.
//  3. Per-plugin isolation: loadAll try/catches each plugin — a bad one records a
//     structured load_error and shows an errored card; boot never crashes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { resolveSource, fetchModule } from "./plugin-fetch.js";
import { registerProvider, unregisterProvider, invalidateModelListCache, normalizeProvides, RENAMED } from "./providers.js";
import { CAPABILITY, CAPABILITY_IDS, CAPABILITY_DEFS, bindingSettings } from "./capabilities.js";
import {
  getConnector,
  registerConnector, unregisterConnector,
  registerConnectorProvider, unregisterConnectorProvider,
} from "./connectors/index.js";
import { registerSource, unregisterSource } from "./ingestion/sources/index.js";
import { FILTER_KIND } from "./ingestion/connector.js";
import { resetDefs, pluginDefs } from "./plugins.js";
import { PLUGIN_API_VERSION, makeCtx } from "./plugin-ctx.js";
import { registerFaceProducer, unregisterFaceProducer, getFaceProducer } from "./faces/index.js";
import { validateMapping } from "./mapping-rules.js";
import { refreshRateTable } from "./pricing.js";
import {
  listExternalPlugins, setExternalLoadError, getExternalPlugin,
  upsertExternalPlugin, deleteExternalPlugin, deletePluginRow, setPluginState,
  getSetting, setSetting, listAiKeys, deleteAiKey,
  listSourceConnections, deleteSourceConnection,
} from "./db.js";

// The names a connector-domain must not claim. The other catalog segments — a
// domain named "ai"/"media"/"source" would mint catalog ids that collide with
// those families — and every name whose `<domain>_provider` setting is already
// an AI capability's election (embed_provider, …): starring or removing such a
// domain would rewrite the embedder, transcriber or detector. Read off the
// capabilities, so a new one is reserved by existing (plugin-contract-plan.md,
// Stage 5). Exported for PLUGIN.md's test, which holds the doc's list to this.
// (Existing connector domains like crypto are caught separately, at loadDir, by
// the getConnector shadow check.)
export const RESERVED_DOMAINS = new Set([
  "ai", "media", "source",
  ...CAPABILITY_DEFS.map((c) => c.binding.keys?.provider?.replace(/_provider$/, "")).filter(Boolean),
]);

// --- per-kind definitions (the ONE place a kind's specifics live) ---
// Adding a plugin kind = one entry in KIND_DEFS (+ a register/unregister seam on
// its registry). The loader below is kind-agnostic — it looks the kind up in this
// table and never switches on manifest.kind. Each definition supplies: catalogId
// (the card/row id), validateManifest (kind-specific manifest checks beyond the
// common ones), validateBuilt (the shape the factory must return), and register/
// unregister (the live-registry writes). The install lifecycle itself (fetch, npm,
// validate, persist, health) is shared and never per-kind — see loadDir,
// installFromUrl and updatePlugin.

// Both connector kinds carry a `domain` — a catalog segment (before the ':') and a
// map key, so a simple slug.
const requireDomain = (m) => {
  if (typeof m.domain !== "string" || !m.domain) throw new Error(`${m.kind} requires manifest.domain`);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(m.domain))
    throw new Error("manifest.domain must be a simple slug (letters, digits, '-')");
};

// A connector-domain may ship its OWN face producer(s) — a novel card face, not
// just the built-in price chart. The manifest DECLARES their names (stored, so
// uninstall can unregister them); each must sit in the plugin's own namespace (the
// id, or `<id>.*`) so it can never overwrite a built-in ("price-chart", …) or
// another plugin's producer. The factory PROVIDES the functions (validateBuilt).
const inNamespace = (n, id) => n === id || String(n).startsWith(`${id}.`);
const validateFaceProducerNames = (m) => {
  if (m.faceProducers === undefined) return;
  if (!Array.isArray(m.faceProducers) || m.faceProducers.some((n) => typeof n !== "string" || !n))
    throw new Error("manifest.faceProducers must be an array of producer names");
  for (const n of m.faceProducers) {
    if (!inNamespace(n, m.id))
      throw new Error(`face producer "${n}" must be namespaced under the plugin id ("${m.id}" or "${m.id}.*")`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(n))
      throw new Error(`face producer name "${n}" may contain only letters, digits, '.', '-', '_'`);
  }
};

// What the rules below enforce, and what they leave alone: a rule is here when
// breaking it throws inside the host's own code, fails silently, or leaves a
// card or picker nameless. Shapes the runtime already repairs — a defaultSort
// that isn't among the sorts, a pageSize, the chart's defaultRange — are
// documented, not enforced; refusing them would refuse plugins that work
// (planning/plugin-contract-plan.md, Stage 2). For the same reason an optional
// member that is `null` counts as absent: every reader treats it so (`|| []`,
// `?.`, `if (!browse)`).
const arrayOrAbsent = (v, what) => {
  if (v != null && !Array.isArray(v)) throw new Error(`${what} must be an array`);
};

// The optional methods the connector runtime calls when a provider has them.
// A truthy non-function would switch the card's capability flag on and throw
// at the first call. Exported for PLUGIN.md's test.
export const PROVIDER_METHODS = ["list", "history", "chart", "testConnection", "prefetch", "fetchFields", "filterOptions"];

// A connector provider: a connector-provider plugin's whole return value, and
// every provider inside a domain.
function validateConnectorProvider(p, name) {
  const what = `connector provider "${name}"`;
  if (!p || typeof p !== "object") throw new Error(`${what} must be an object`);
  if (typeof p.label !== "string" || !p.label) throw new Error(`${what} needs a label — the name on its card`);
  if (typeof p.search !== "function" || typeof p.fetchEntity !== "function")
    throw new Error(`${what} must have search() and fetchEntity()`);
  // The rate limit is a contract here as it is for AI providers (providers.js
  // requireRateLimit). Enforced here rather than at the registry write: the
  // loader validates before anything registers — a throw inside a domain's
  // register would strand the face producers it had already written — and
  // builtin-plugins.test.js holds the built-ins to this same function.
  if (!(p.rpm > 0) || !(p.burst > 0))
    throw new Error(`${what} must declare positive rpm and burst (rate-limit contract)`);
  for (const m of PROVIDER_METHODS)
    if (p[m] && typeof p[m] !== "function") throw new Error(`${what}: ${m} must be a function`);
}

// The column kinds the host can draw and filter by — the feed's own
// translation table, read rather than restated.
const COLUMN_KINDS = Object.keys(FILTER_KIND);

// The shape of a connector domain module — { providers, manifest, faces } —
// which a connector-domain plugin is held to at install, and the built-in
// domains are held to by test (builtin-plugins.test.js), so no rule here can
// be stricter than what core ships. `faceProducers` names the plugin's own
// producers: at install they are not registered yet (register-last). A name in
// the plugin's own `namespace` counts only when it is one of them — never
// because an earlier version left it registered, which is what an update's
// validation would otherwise see (the old version serves until the new passes).
export function validateDomainModule(mod, { domain, faceProducers = [], namespace = null }) {
  const man = mod.manifest;
  if (!man || typeof man !== "object") throw new Error("connector-domain must return a domain manifest");
  if (typeof man.label !== "string" || !man.label)
    throw new Error("the domain manifest needs a label — the name the template picker shows");
  arrayOrAbsent(man.fields, "domain manifest.fields");
  arrayOrAbsent(man.faces, "domain manifest.faces");

  // Every face the manifest offers is a slot of the factory's faces map, and
  // every slot names a producer that exists. Otherwise produceFace finds
  // nothing and each card keeps its fallback tile, with nothing saying why.
  if (mod.faces != null && (typeof mod.faces !== "object" || Array.isArray(mod.faces)))
    throw new Error("the factory's faces map must be an object — face slot → producer name");
  const slots = mod.faces || {};
  const own = (n) => namespace != null && inNamespace(n, namespace);
  for (const [i, f] of (man.faces || []).entries()) {
    if (!f || typeof f.name !== "string" || !Object.hasOwn(slots, f.name))
      throw new Error(`domain manifest.faces[${i}] must be named for a slot of the factory's faces map`);
    arrayOrAbsent(f.periods, `domain manifest.faces[${i}].periods`);
  }
  for (const [slot, producer] of Object.entries(slots))
    if (!faceProducers.includes(producer) && (own(producer) || !getFaceProducer(producer)))
      throw new Error(`faces.${slot} names face producer "${producer}", which is neither built in nor one of this plugin's faceProducers`);

  // The field catalog and the template, through the board save's own rules
  // (mapping-rules.js): each catalog field as the one-field mapping the pane
  // makes of it, the template as the mapping it is. The lookup answers with
  // this module, which isn't registered yet.
  const connectorFor = (name) => (name === domain ? mod : getConnector(name));
  for (const [i, f] of (man.fields || []).entries()) {
    const err = validateMapping(
      { input: { connector: domain }, fields: [{ key: f?.key, kind: f?.kind, source: "connector", fn: f?.fn }] },
      connectorFor);
    if (err) throw new Error(`domain manifest.fields[${i}]: ${err}`);
  }
  if (man.template != null) {
    const t = man.template;
    if (typeof t !== "object" || Array.isArray(t)) throw new Error("domain manifest.template must be a board mapping object");
    // A template naming another domain would bind every board made from it there.
    const bound = t.input?.connector;
    if (bound !== domain)
      throw new Error(`domain manifest.template must bind boards to its own domain ("${domain}"), not ${JSON.stringify(bound ?? null)}`);
    const err = validateMapping(t, connectorFor);
    if (err) throw new Error(`domain manifest.template: ${err}`);
  }

  if (man.browse != null) {
    const b = man.browse;
    if (typeof b !== "object") throw new Error("domain manifest.browse must be an object");
    if (!Array.isArray(b.columns)) throw new Error("domain manifest.browse.columns must be an array");
    for (const [i, c] of b.columns.entries())
      if (!c || typeof c.key !== "string" || !COLUMN_KINDS.includes(c.kind))
        throw new Error(`domain manifest.browse.columns[${i}] needs a key and a kind — one of: ${COLUMN_KINDS.join(", ")}`);
    arrayOrAbsent(b.sorts, "domain manifest.browse.sorts");
    arrayOrAbsent(b.filters, "domain manifest.browse.filters");
    for (const [i, f] of (b.filters || []).entries()) {
      const at = `domain manifest.browse.filters[${i}]`;
      if (!f || typeof f.key !== "string" || !f.key) throw new Error(`${at} needs a key`);
      if (f.from != null && f.from !== "provider")
        throw new Error(`${at}.from must be "provider" — the only source a filter can name`);
      if (f.from == null && !Array.isArray(f.options))
        throw new Error(`${at} needs an options array, or from: "provider"`);
    }
  }
  if (man.chart != null && (!Array.isArray(man.chart.ranges) || !Array.isArray(man.chart.kinds)))
    throw new Error("domain manifest.chart needs ranges and kinds arrays");

  for (const [name, p] of Object.entries(mod.providers || {})) validateConnectorProvider(p, name);
}

// The field types a source connection can hold: what the connection form
// draws (plugin-modal.js) and what server.js validates, coerces and masks.
// Anything else renders as a plain text box and is stored and echoed as it
// is, so a secret typed `password` would be shown to every admin who opens it.
// Exported for PLUGIN.md's test.
export const CONNECTION_FIELD_TYPES = ["text", "number", "secret", "toggle"];

function validateSourceManifest(man) {
  if (typeof man.label !== "string" || !man.label) throw new Error("source manifest needs a label — the name on its card");
  arrayOrAbsent(man.connectionSchema, "source manifest.connectionSchema");
  const fields = man.connectionSchema || [];
  if (!!man.needsConnection !== (fields.length > 0))
    throw new Error(man.needsConnection
      ? "a source with needsConnection must declare connectionSchema — the fields a connection holds"
      : "connectionSchema is only read when needsConnection is on — with it off the form is never shown and the backend gets no connection");
  for (const [i, f] of fields.entries()) {
    if (!f || typeof f.key !== "string" || !f.key || typeof f.label !== "string" || !f.label)
      throw new Error(`source connectionSchema[${i}] needs a key and a label`);
    if (!CONNECTION_FIELD_TYPES.includes(f.type))
      throw new Error(`source connectionSchema[${i}].type must be one of: ${CONNECTION_FIELD_TYPES.join(", ")} — "secret" is the one that's masked`);
  }
  arrayOrAbsent(man.sourceSchema, "source manifest.sourceSchema");
  for (const [i, f] of (man.sourceSchema || []).entries())
    if (!f || typeof f.key !== "string" || !f.key) throw new Error(`source sourceSchema[${i}] needs a key`);
}

const KIND_DEFS = {
  "ai-provider": {
    catalogId: (m) => `ai:${m.id}`,
    validateBuilt: (m, built) => {
      // A `provides` key the registry doesn't know would never bind — nothing
      // asks for it — so it is refused (D7: v1 adds no capabilities), naming
      // the valid set and, when the key is a known misspelling of a real one,
      // that one: a legacy field name (`embeds` — providers.js RENAMED) or a
      // capability that rides another's declaration (`extract` reads tag's).
      for (const id of Object.keys(built.provides || {})) {
        if (CAPABILITY_IDS.includes(id)) continue;
        const meant = Object.keys(RENAMED).find((c) => RENAMED[c] === id) || CAPABILITY[id]?.declaredBy;
        throw new Error(`provides.${id} is not a capability a provider declares${meant ? ` — did you mean provides.${meant}?` : ""} (one of: ${CAPABILITY_IDS.join(", ")})`);
      }
      // With `provides`, only `provides` declares (normalizeProvides), so a
      // descriptor that tags through the legacy fields but writes `provides`
      // without `tag` would install as a non-tagger in silence — refused,
      // naming the move. `provides.tag: null` says "doesn't tag" on purpose,
      // and an empty legacy catalog (`models: []`, `defaultModel: null`)
      // declares nothing.
      if (built.provides && !Object.hasOwn(built.provides, "tag")) {
        const legacy = [
          built.defaultModel != null && "defaultModel",
          built.models?.length && "models",
          built.modelFilter != null && "modelFilter",
        ].filter(Boolean);
        if (legacy.length)
          throw new Error(`${legacy.join(" and ")} declare${legacy.length === 1 ? "s" : ""} tagging, but with \`provides\` only \`provides\` declares — move it into provides.tag ({ default, models, filter })`);
      }
      // Every check below judges the `provides` normal form, so a descriptor may
      // declare either shape (the legacy fields or `provides`) and is held to
      // the same rules. normalizeProvides is the loader's only reading of the
      // legacy fields — one implementation, or the loader and the registry drift.
      // An entry counts when it is truthy, as the catalog counts it
      // (plugins.js aiDefs): `provides: { embed: null }` declares nothing.
      const provides = normalizeProvides(built);
      const declared = Object.keys(provides).filter((id) => provides[id]);
      // A provider must DO something: at least one capability that is not a mere
      // modifier of another (`research` alone would qualify a tagger the plugin
      // doesn't have — rejected before slice 7a by the legacy-field emptiness
      // check, rejected here on purpose).
      if (!declared.some((id) => !CAPABILITY[id].modifierOf))
        throw new Error(`an ai-provider must declare at least one capability in \`provides\` — one of: ${CAPABILITY_IDS.filter((id) => !CAPABILITY[id].modifierOf).join(", ")}`);
      if (!built.label) throw new Error("ai-provider descriptor needs a label");
      // A capability is only real if its wire method exists: advertising
      // `transcribes` requires wire.transcribe, and tagging requires wire.tag
      // to be a function, not merely present. Read off the `provides` normal
      // form and each capability's own `verb`, so a new capability is covered
      // by declaring it, not by editing this check.
      //
      // PLUGIN-ONLY, deliberately: the built-in whisper and localDetector
      // descriptors advertise a capability with `wire: null` — they are
      // sidecar-backed and their HTTP call is assembled in worker.js. Hoisting
      // this into providers.js install() would reject two shipping providers.
      for (const cap of declared) {
        const verb = CAPABILITY[cap].verb; // null for `research` (a flag on the tagging call)
        if (verb && typeof built.wire?.[verb] !== "function")
          throw new Error(`a ${cap} ai-provider descriptor needs wire.${verb}`);
      }
      // provides.tag.default names the model a tagging picker starts on; only a
      // tagger needs one. An embed-only or transcribe-only descriptor
      // legitimately has none. Named in the spelling PLUGIN.md teaches — the
      // legacy `defaultModel` is accepted and never written down (D2).
      if (provides.tag && !provides.tag.default) throw new Error("a tagging ai-provider needs provides.tag.default — the model its pickers start on");
    },
    register: (m, built) => registerProvider(m.id, built),
    unregister: (m) => unregisterProvider(m.id),
  },

  "connector-provider": {
    catalogId: (m) => `${m.domain}:${m.id}`,
    validateManifest: requireDomain,
    validateBuilt: (m, built) => validateConnectorProvider(built, m.id),
    register: (m, built) => registerConnectorProvider(m.domain, m.id, built),
    unregister: (m) => unregisterConnectorProvider(m.domain, m.id),
  },

  "connector-domain": {
    catalogId: (m) => `${m.domain}:${m.id}`,
    validateManifest: (m) => {
      requireDomain(m);
      if (RESERVED_DOMAINS.has(m.domain.toLowerCase()))
        throw new Error(`manifest.domain "${m.domain}" is reserved`);
      validateFaceProducerNames(m);
    },
    validateBuilt: (m, built) => {
      // One provider, the plugin's own (D5). The catalog already assumes one
      // plugin = one card = one row, and a second provider riding a domain
      // plugin would outlive its uninstall (its key slot, its row); another
      // provider for the domain is a connector-provider plugin, removed on its own.
      const names = Object.keys(built.providers || {});
      if (names.length !== 1 || names[0] !== m.id)
        throw new Error(`connector-domain must return exactly one provider, keyed by manifest.id ("${m.id}") — another provider for the domain is a connector-provider plugin`);
      // The default provider is named for the plugin so the catalog id
      // (`<domain>:<id>`) is knowable from the manifest ALONE — needed to name the
      // install dir and dedupe reinstalls before the module is ever loaded.
      if (built.defaultProvider !== m.id)
        throw new Error(`connector-domain defaultProvider must equal manifest.id ("${m.id}")`);
      // Every declared face producer must be backed by a function (register-last).
      for (const n of m.faceProducers || [])
        if (typeof built.faceProducers?.[n] !== "function")
          throw new Error(`manifest declares face producer "${n}" but the factory returned no function for it`);
      validateDomainModule(built, { domain: m.domain, faceProducers: m.faceProducers, namespace: m.id });
    },
    register: (m, built) => {
      // The plugin's own face producers join the shared registry so its `faces`
      // map can name them (re-register on reload just overwrites — idempotent).
      for (const n of m.faceProducers || []) registerFaceProducer(n, built.faceProducers[n]);
      // An update replaces the live domain, and the providers other plugins
      // added to it (connector-provider plugins) live in the map it replaces:
      // they move into the new version's, or they drop out until a restart.
      // Install and boot replace nothing — the shadow check sees to that.
      const prior = getConnector(m.domain);
      if (prior)
        for (const [n, p] of Object.entries(prior.providers))
          if (!Object.hasOwn(built.providers, n)) built.providers[n] = p;
      registerConnector(m.domain, built);
    },
    unregister: (m) => {
      unregisterConnector(m.domain);
      for (const n of m.faceProducers || []) unregisterFaceProducer(n);
    },
  },

  // An ingestion source (where files come FROM — ftp/s3/webdav/…). The factory
  // returns the same { manifest, backend } shape a built-in source module exports;
  // the client (ingest modal + browse) is already generic, so nothing else changes.
  "source": {
    catalogId: (m) => `source:${m.id}`,
    validateBuilt: (m, built) => {
      if (!built.manifest || typeof built.manifest !== "object")
        throw new Error("source must return a { manifest, backend } module");
      // manifest.name is the catalog segment (`source:<name>`) and the install-state
      // key, so it must equal the plugin id — the id is then knowable from the
      // manifest alone (mirrors connector-domain's defaultProvider === id).
      if (built.manifest.name !== m.id)
        throw new Error(`source manifest.name must equal manifest.id ("${m.id}")`);
      if (typeof built.backend !== "function")
        throw new Error("source must return a backend({ source, conn }) factory");
      validateSourceManifest(built.manifest);
    },
    register: (m, built) => registerSource(m.id, built),
    unregister: (m) => unregisterSource(m.id),
  },
};

// Exported for PLUGIN.md's test, which holds the doc's table of kinds to it.
export const KINDS = new Set(Object.keys(KIND_DEFS));

// --- validation (pure — no registry writes) ---

export function validateManifest(m) {
  if (!m || typeof m !== "object") throw new Error("manifest.json is missing or not an object");
  if (typeof m.id !== "string" || !m.id.includes("."))
    throw new Error('manifest.id must be a namespaced "vendor.name" string (a dot separates vendor from name)');
  // The id becomes half of the catalog id (split on ':') and, at install, the
  // on-disk dir name — so keep it to path- and id-safe characters.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(m.id))
    throw new Error("manifest.id may contain only letters, digits, '.', '-', '_'");
  if (typeof m.apiVersion !== "number") throw new Error("manifest.apiVersion must be a number");
  if (Math.trunc(m.apiVersion) !== PLUGIN_API_VERSION)
    throw new Error(`unsupported apiVersion ${m.apiVersion} — this host supports ${PLUGIN_API_VERSION}`);
  if (!KINDS.has(m.kind)) throw new Error(`manifest.kind must be one of: ${[...KINDS].join(", ")}`);
  if (typeof m.label !== "string" || !m.label) throw new Error("manifest.label is required");
  if (typeof m.main !== "string" || !m.main || m.main.includes(".."))
    throw new Error("manifest.main must be a relative path inside the plugin (no '..')");
  // Opt-in to running npm lifecycle scripts at install (native modules). Default
  // off — nothing executes until the manifest validates and the factory loads.
  if (m.allowScripts !== undefined && typeof m.allowScripts !== "boolean")
    throw new Error("manifest.allowScripts must be a boolean");
  // faceProducers is a connector-domain-only field; its shape/namespace checks live
  // in that kind's definition — this only guards it appearing on the wrong kind.
  if (m.faceProducers !== undefined && m.kind !== "connector-domain")
    throw new Error("manifest.faceProducers is only supported on a connector-domain plugin");
  // LISTING HINTS (planning/welcome-plan.md Stage 2b), and nothing more. They
  // exist because a catalog can read a manifest without running anything, while
  // everything a provider actually declares — keyless, needsBase, models,
  // provides — lives in the factory and is unknown until it loads. A chooser
  // that has to order "costs nothing" ahead of "bring a key", or label a field
  // "Server URL" instead of "API key", needs those two answers one step before
  // they exist.
  //
  // They are never read once the plugin is loaded: the descriptor is the truth,
  // this is the blurb on the box. A bundled example's hints are pinned equal to
  // its descriptor by test, which is what keeps the box from lying.
  for (const hint of ["keyless", "needsBase"]) {
    if (m[hint] !== undefined && typeof m[hint] !== "boolean")
      throw new Error(`manifest.${hint} must be a boolean (it is a listing hint, not a setting)`);
  }
  KIND_DEFS[m.kind].validateManifest?.(m); // kind-specific manifest checks
}

// Validate the object the factory returned — the shape its registry expects.
// The "is an object" check is common; everything else is kind-specific (in the
// definition), and a rule only where breaking it would throw inside the host,
// fail silently, or leave a card nameless (see arrayOrAbsent's note above).
// Exported because the built-ins are held to it too (builtin-plugins.test.js).
export function validateBuilt(m, built) {
  if (!built || typeof built !== "object") throw new Error("the plugin factory must return an object");
  KIND_DEFS[m.kind].validateBuilt?.(m, built);
}

// The catalog id a plugin owns: `<segment>:<vendor.name>`. Segment is "ai" or the
// (existing or new) connector domain. One plugin = one primary card = one row.
// Manifest-only (a connector-domain's defaultProvider === id, enforced above), so
// the id is known before the module loads — the install flow needs it to name the
// dir and detect a reinstall.
export function catalogIdFor(m) {
  return KIND_DEFS[m.kind].catalogId(m);
}

// --- load / register (the ONE place a registry is mutated) ---

const readManifest = (dir) => {
  let raw;
  try { raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8"); }
  catch { throw new Error(`no manifest.json in ${dir}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`manifest.json is not valid JSON: ${e.message}`); }
};

// Read a plugin dir's manifest and check it — the pair every entry point starts
// with, since a manifest nobody validated is just some JSON. Exported because
// the bundled-catalog scan (plugins.js bundledPlugins) is the third entry point
// and must fail on the same files with the same sentences; it differs only in
// what it does with the throw, which is skip rather than abort.
export function manifestIn(dir) {
  const m = readManifest(dir);
  validateManifest(m);
  return m;
}

async function buildModule(dir, manifest) {
  // Every install and update lands in a fresh dir, which is what busts Node's
  // ESM cache across versions; the query param only matters when one process
  // loads the same dir twice, which the tests do.
  const url = pathToFileURL(path.join(dir, manifest.main)).href + `?t=${Date.now()}`;
  const mod = await import(url);
  if (typeof mod.default !== "function")
    throw new Error("plugin main must default-export a factory: (ctx) => …");
  return mod.default(makeCtx(manifest));
}

function registerBuilt(manifest, built) {
  KIND_DEFS[manifest.kind].register(manifest, built);
  resetDefs(); // the live registries changed → rebuild the memoized catalog defs
}

// Undo a registration (uninstall). `manifest` is the stored one,
// so a connector-domain's declared faceProducers are known without the built module.
export function unregister(manifest) {
  KIND_DEFS[manifest.kind]?.unregister(manifest);
  resetDefs();
}

// Whether a plugin holds a live registration right now, asked of the registries
// themselves (the catalog lists exactly what they hold) rather than read off
// load_error: a provider plugin whose domain plugin was removed has no
// load_error and nothing registered.
const registered = (id) => pluginDefs().some((d) => d.id === id);

// Load ONE plugin from its on-disk dir and register it (boot, install,
// update). Everything before the registry write has no side effects, so a
// throw leaves the registries untouched — an update builds here while the
// version it replaces is still serving. Returns { catalogId, manifest }.
export async function loadDir(dir, { replacing = false } = {}) {
  const manifest = manifestIn(dir);
  const built = await buildModule(dir, manifest);
  validateBuilt(manifest, built);
  // A connector-domain must NOT shadow an existing domain (a built-in like
  // crypto, or another plugin's) — replacing a domain wholesale is not what
  // "add a data source" means; adding a provider to an existing domain is
  // connector-provider. A live domain plugin's update replaces its own
  // domain, the one domain it may.
  if (!replacing && manifest.kind === "connector-domain" && getConnector(manifest.domain))
    throw new Error(`domain "${manifest.domain}" already exists — use kind "connector-provider" to add a provider to it`);
  registerBuilt(manifest, built);
  return { catalogId: catalogIdFor(manifest), manifest };
}

// Boot hook: load every recorded external plugin, isolated. A failure records a
// structured load_error (surfaced as an errored card by pluginCatalog) and is
// logged; the next plugin still loads and boot proceeds.
export async function loadAll(db) {
  // Reclaim staging dirs orphaned by a hard kill mid-install — nothing else
  // sweeps them, and installs recreate `.staging` on demand. Safe here: boot runs
  // before any route serves, so no install is ever in flight.
  fs.rmSync(path.join(pluginsDir(), ".staging"), { recursive: true, force: true });
  // Load connector-domain plugins first: a connector-provider may extend a domain
  // another plugin supplies, and registering into an absent domain throws. DB row
  // order is otherwise arbitrary, so pin domains ahead of everything else.
  const rows = (await listExternalPlugins(db))
    .sort((a, b) => (a.kind === "connector-domain" ? 0 : 1) - (b.kind === "connector-domain" ? 0 : 1));
  let ok = 0;
  for (const row of rows) {
    try {
      await loadDir(row.dir);
      if (row.load_error) await setExternalLoadError(db, row.id, null); // heal only if it was errored
      ok++;
    } catch (err) {
      console.error(`plugin ${row.id}: load failed — ${err.message}`);
      await setExternalLoadError(db, row.id, err).catch(() => {});
    }
  }
  if (rows.length) console.log(`plugins: loaded ${ok}/${rows.length} external plugin(s)`);
}

// --- install / uninstall (slice 2) ---

const run = promisify(execFile);
const NPM_TIMEOUT_MS = Number(process.env.PLUGIN_NPM_TIMEOUT_MS) || 180000;

// Where installed code lives — a node-owned dir on the persistent /data volume,
// so installs survive restarts AND image rebuilds. Read lazily so tests can point
// it at a temp dir.
export const pluginsDir = () => process.env.PLUGINS_DIR || "/data/plugins";

const sanitizeRef = (ref) => String(ref || "ref").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "ref";

// Run `npm install --omit=dev` in a plugin dir — but ONLY if it declares
// dependencies. A dep-free plugin (the common connector/AI case) skips npm
// entirely, so there's no network when there's nothing to fetch and the install
// path stays offline-testable. Lifecycle scripts are OFF unless the manifest
// opts in (`allowScripts`) — nothing executes before validate + load.
async function npmInstall(dir, { allowScripts }) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); }
  catch { return; } // no package.json → nothing to install
  if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) return;
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  if (!allowScripts) args.push("--ignore-scripts");
  try {
    // maxBuffer well above execFile's 1 MB default — a chatty-but-successful npm
    // install must not spuriously fail with ENOBUFS.
    await run("npm", args, { cwd: dir, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NODE_ENV: "production" } });
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message || "").split("\n").slice(-8).join("\n").trim();
    throw new Error(`npm install failed: ${tail}`);
  }
}

// Fetch a source into a fresh staging dir, read the manifest it holds, and
// hand both to `fn` — the half install and update share. `fn` checks the
// catalog id before anything runs, then commits the dir (commitDir) or
// doesn't; either way the staging dir is gone when this returns.
async function withStage(url, fn) {
  const source = resolveSource(url);
  const root = pluginsDir();
  fs.mkdirSync(path.join(root, ".staging"), { recursive: true });
  const staging = path.join(root, ".staging", crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(staging, { recursive: true });
  try {
    const { resolvedRef } = await fetchModule(source, staging);
    const manifest = manifestIn(staging);
    return await fn({ staging, manifest, catalogId: catalogIdFor(manifest), resolvedRef });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true }); // no-op once renamed away
  }
}

// npm-install a staged plugin and commit it into a fresh, unique dir
// (`…@<ref>-<nonce>`). Every install and update lands in its own directory, so
// a failed one can never overwrite the code already on disk — the prior
// version is always recoverable. The dir name is cosmetic: installs dedupe by
// catalog id (the DB row) and `resolved_ref` is shown from its own column, not
// parsed from the name. The full catalog id (not manifest.id alone) keeps one
// vendor.name used across two domains from colliding.
async function commitDir({ staging, manifest, catalogId, resolvedRef }) {
  await npmInstall(staging, { allowScripts: !!manifest.allowScripts });
  const dir = path.join(pluginsDir(), `${catalogId.replace(/[:/\\]/g, "__")}@${sanitizeRef(resolvedRef)}-${crypto.randomBytes(3).toString("hex")}`);
  fs.renameSync(staging, dir); // atomic commit (same filesystem as PLUGINS_DIR)
  return dir;
}

// Install a plugin from a URL: fetch → npm install → validate → move into place →
// register → persist. Atomic — everything happens in a staging dir first, and
// only an atomic rename commits it; any failure cleans up and persists nothing.
// An id already installed is refused (409), errored or not: bringing it up to
// date — Retry, on an errored card — is updatePlugin, from its stored source.
// Returns the loaded plugin's catalog id.
export async function installFromUrl(db, url) {
  return withStage(url, async (staged) => {
    const { manifest, catalogId, resolvedRef } = staged;
    const existing = await getExternalPlugin(db, catalogId);
    if (existing) throw Object.assign(new Error(existing.load_error
      ? `${manifest.label} is installed but failed to load — Retry it from its card, or remove it`
      : `${manifest.label} is already installed — update or remove it`), { status: 409 });
    const dir = await commitDir(staged);
    try {
      await loadDir(dir); // validates + registers (register-last)
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true }); // nothing was registered or recorded
      throw err;
    }
    await upsertExternalPlugin(db, { id: catalogId, kind: manifest.kind, sourceUrl: String(url), resolvedRef, dir, manifest });
    await setPluginState(db, catalogId, { installed: true }); // enforcement (pluginRowState) reads this
    // A provider's declared rates reach the meter's rate table now, not at the
    // next restart (boot rebuilds it after loadAll for the same reason).
    await refreshRateTable(db);
    console.log(`plugin ${catalogId} installed from ${url}`);
    return catalogId;
  });
}

// Update an external plugin from the source it was installed from (D6),
// keeping everything stored about it — keys, config, bindings, board pins —
// because nothing here touches them. Register-last holds for a replacement
// too: the new version is fetched, built and validated while the old one keeps
// serving, and the swap is one synchronous write. Every registry overwrites on
// re-register, and the registers that can refuse (the AI registry's install()
// rules, a provider whose domain is gone) do so before their write — so a
// failed update never touched the registry and there is nothing to roll back.
// A plugin holding no registration (an errored card's Retry is this same verb)
// gets a fresh install's shadow check instead, and a failure refreshes its
// stored reason so the card says why this attempt failed.
export async function updatePlugin(db, id) {
  const row = await getExternalPlugin(db, id);
  if (!row) throw new Error("not an installed plugin (built-ins update with the app)");
  const live = registered(id);
  return withStage(row.source_url, async (staged) => {
    const { manifest, catalogId, resolvedRef } = staged;
    // The same id AND kind: the two connector kinds share `<domain>:<id>`, and a
    // changed kind would register into, or over, a domain this plugin doesn't
    // own. It is also what lets a live domain plugin skip the shadow check.
    if (catalogId !== id || manifest.kind !== row.kind)
      throw Object.assign(new Error(`the source now names a different plugin (${manifest.kind} ${catalogId}) — remove this one and install that`), { status: 409 });
    const dir = await commitDir(staged);
    try {
      await loadDir(dir, { replacing: live });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!live) await setExternalLoadError(db, id, err).catch(() => {});
      throw err;
    }
    // What the old version registered and this one doesn't. The catalog id
    // fixes every other registry key, so only face producers can differ.
    if (live) {
      for (const n of row.manifest.faceProducers || [])
        if (!(manifest.faceProducers || []).includes(n)) unregisterFaceProducer(n);
    }
    await upsertExternalPlugin(db, { id, kind: manifest.kind, sourceUrl: row.source_url, resolvedRef, dir, manifest });
    // The new version's declared rates, not the old one's: costs are stamped
    // at write time and never recomputed.
    await refreshRateTable(db);
    if (row.dir && row.dir !== dir) fs.rmSync(row.dir, { recursive: true, force: true });
    console.log(`plugin ${id} updated from ${row.source_url} (${resolvedRef})`);
    return id;
  });
}

// Uninstall an external plugin: unregister → drop both rows → clear its stored
// secrets/selection → remove its code. Built-in ids have no external_plugins row
// → readable throw (they use PATCH installed:false, which is availability, not
// removal, and deliberately keeps their config).
export async function uninstall(db, id) {
  const row = await getExternalPlugin(db, id);
  if (!row) throw new Error("not an installed plugin (built-ins can't be uninstalled)");
  // Only a live plugin has anything to take out of the registries. One that
  // never loaded registered nothing, and what its manifest names may belong to
  // another plugin by now: the domain it failed to load can have been claimed
  // by the next install of that name.
  const live = registered(id);
  if (live) unregister(row.manifest);
  await deleteExternalPlugin(db, id);
  await deletePluginRow(db, id); // its config/health
  await cleanupPluginConfig(db, row.manifest, { live });
  await refreshRateTable(db); // its declared rates leave the meter with it
  if (row.dir) fs.rmSync(row.dir, { recursive: true, force: true });
  console.log(`plugin ${id} uninstalled`);
}

// A true uninstall leaves NOTHING behind (unlike a built-in's reversible
// installed:false). Runtime paths already degrade gracefully when these linger —
// activeProvider falls back, the worker gates on aiPluginInstalled — but keeping
// them would retain key material after removal AND silently re-activate the
// provider on a later reinstall. Surgical, never prefix-based: a domain name
// could otherwise collide with another setting family (e.g. a domain "embed"
// vs the embed_key_id / embed_model settings).
async function cleanupPluginConfig(db, manifest, { live }) {
  if (manifest.kind === "ai-provider") {
    // Every key registered for this provider (deleteAiKey also handles board
    // fallback + clearing the default-tagger/embed/transcribe key pointers).
    for (const k of await listAiKeys(db)) {
      if (k.provider === manifest.id) {
        await deleteAiKey(db, k.id);
        invalidateModelListCache(k.id); // same eviction the admin DELETE route does
      }
    }
    // NAME-based slot pointers too: an on-device plugin is selected by name,
    // not key row, so no deleteAiKey cascade reaches these — left behind they
    // would silently re-activate the slot on a later reinstall. Iterated over
    // CAPABILITY_DEFS: the hand-written version covered embed and transcribe
    // and forgot detect, which is exactly the re-activation this warns about.
    for (const cap of CAPABILITY_DEFS) {
      const providerSetting = cap.binding.keys?.provider;
      if (!providerSetting || (await getSetting(db, providerSetting)) !== manifest.id) continue;
      for (const s of bindingSettings(cap)) await setSetting(db, s, null); // → the capability's floor
    }
    // BOARD pins of the name too (slice 5), for the same reason: a board's
    // on-device pin has no key row, so no cascade reaches it, and left behind
    // it re-activates the provider on that board at reinstall. Key-row board
    // pins need nothing here — deleteAiKey above FK-NULLs the pointer and
    // clears the pinned model. Reversible removal (the Plugins page's
    // installed:false) deliberately does NOT reach these: pins survive it,
    // like every other stored choice.
    for (const cap of CAPABILITY_DEFS) {
      const bk = cap.binding.boardKeys;
      if (bk?.provider) await db.query(`UPDATE boards SET ${bk.provider}=NULL WHERE ${bk.provider}=$1`, [manifest.id]);
    }
    return;
  }
  // A source's saved connections go with it, as an AI plugin's connections and
  // a data plugin's key do: keeping them kept the secrets they hold for a type
  // nothing can read any more (plugin-contract-plan.md, Stage 5; the Remove
  // confirm says so). Bringing a plugin up to date is
  // Update, which keeps them. The source's type is its id, which no other
  // plugin can hold, so this is safe for one that never loaded. A cached
  // listing of one needs no eviction: a read through it refuses at the
  // install gate, and a new connection gets a new id.
  if (manifest.kind === "source") {
    for (const c of await listSourceConnections(db, manifest.id)) await deleteSourceConnection(db, c.id);
    return;
  }
  // connector-provider | connector-domain: the provider's API-key slot, plus the
  // domain's active-provider pointer. A live whole-domain uninstall clears the
  // pointer outright — the domain goes with it; otherwise it's cleared only if
  // it named this provider (a single provider, or a domain plugin that never
  // loaded, whose domain may be another plugin's by now).
  const domain = manifest.domain;
  await setSetting(db, `${domain}_key_${manifest.id}`, null);
  if ((manifest.kind === "connector-domain" && live) || (await getSetting(db, `${domain}_provider`)) === manifest.id)
    await setSetting(db, `${domain}_provider`, null);
}
