type ApiKeySecurityCopy = {
  title: string
  description: string
}

// Keeps the security promise aligned with the fail-closed safeStorage boundary.
const getApiKeySecurityCopy = (encryptionAvailable: boolean): ApiKeySecurityCopy =>
  encryptionAvailable
    ? {
        title: 'Your key stays private.',
        description:
          'Research Agent stores it only on this device in OS secure storage and sends it only to the selected provider when you make a request.'
      }
    : {
        title: 'Secure storage is unavailable.',
        description:
          'Research Agent will not save API keys until the operating-system credential vault is available. Unlock or authorize the system keychain, then retry.'
      }

export { getApiKeySecurityCopy }
