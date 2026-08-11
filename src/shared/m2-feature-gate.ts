// M2 development work is intentionally not a user-facing feature yet. Keep this constant in shared
// code so a future integration cannot accidentally make the composer advertise an unverified path.
export const M2_DEVELOPMENT_GATE_ENABLED = false as const
export const M2_DEVELOPMENT_GATE_USER_VISIBLE = false as const

export const isM2DevelopmentGateEnabled = (): false => M2_DEVELOPMENT_GATE_ENABLED
