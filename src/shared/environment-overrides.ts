type Environment = Readonly<Record<string, string | undefined>>

export const LEGACY_OPEN_SCIENCE_ENV_OPT_IN =
  'RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV' as const

export const allowsLegacyOpenScienceEnvironment = (environment: Environment): boolean =>
  environment[LEGACY_OPEN_SCIENCE_ENV_OPT_IN] === '1'

// Research Agent variables always win, including when explicitly set to an empty string. Legacy
// Open Science variables are invisible unless the narrowly scoped compatibility switch is exactly 1.
export const readResearchAgentEnvironment = (
  environment: Environment,
  researchAgentName: string,
  legacyOpenScienceName: string
): string | undefined => {
  if (environment[researchAgentName] !== undefined) return environment[researchAgentName]
  if (!allowsLegacyOpenScienceEnvironment(environment)) return undefined
  return environment[legacyOpenScienceName]
}
