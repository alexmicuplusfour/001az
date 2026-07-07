import * as coingecko from "./coingecko.js";

const CONNECTORS = { coingecko };

export function getConnector(name) {
  return CONNECTORS[name] || null;
}

export function listConnectors() {
  return Object.entries(CONNECTORS).map(([name, c]) => ({
    name,
    label: c.manifest.label,
    description: c.manifest.description,
    fields: c.manifest.fields,
    template: c.manifest.template,
  }));
}
