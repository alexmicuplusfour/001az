// Never reached — manifest validation rejects the apiVersion before import.
export default function () {
  return { label: "Acme Old", async search() { return []; }, async fetchEntity() { return {}; } };
}
