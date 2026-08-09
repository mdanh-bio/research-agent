/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const LEGACY_OPEN_SCIENCE_ENV_OPT_IN = 'RESEARCH_AGENT_ALLOW_LEGACY_OPEN_SCIENCE_ENV'

export const allowsLegacyOpenScienceEnvironment = (environment = process.env) =>
  environment[LEGACY_OPEN_SCIENCE_ENV_OPT_IN] === '1'

export const readResearchAgentEnvironment = (
  environment,
  researchAgentName,
  legacyOpenScienceName
) => {
  if (environment[researchAgentName] !== undefined) return environment[researchAgentName]
  if (!allowsLegacyOpenScienceEnvironment(environment)) return undefined
  return environment[legacyOpenScienceName]
}
