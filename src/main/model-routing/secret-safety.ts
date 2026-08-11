const FORBIDDEN_KEY =
  /(?:api[_-]?key|secret|password|credential|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key)/i
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^bearer\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{16,}$/,
  /^AIza[A-Za-z0-9_-]{20,}$/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
]

// Routing documents have a deliberately small, secret-free vocabulary. This runtime assertion is
// defense in depth against an unsafe cast or future schema drift before JSON reaches settings or the
// immutable ledger; credentials continue to be resolved only by SettingsService after selection.
export const assertSecretFreeRoutingValue = (value: unknown, path = 'routing'): void => {
  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`Secret-like material is not allowed in ${path}.`)
    }
    return
  }
  if (value === null || value === undefined || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSecretFreeRoutingValue(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`Secret-bearing field ${path}.${key} is not allowed in routing data.`)
    }
    assertSecretFreeRoutingValue(entry, `${path}.${key}`)
  }
}
