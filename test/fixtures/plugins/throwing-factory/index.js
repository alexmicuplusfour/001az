// Fixture: the factory throws. Proves register-last — nothing must reach the
// live registries when a build fails.
export default function () {
  throw new Error("kaboom");
}
