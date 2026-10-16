// Wire model names are opaque identifiers, never filesystem paths or URLs.
// Preserve the legacy grammar; additionally allow exactly one vendor/name pair.
export function modelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value);
}
