import { z } from 'zod'

import { validationCodec, type ApplicationCommandContract } from './application-command-contract'
import {
  validateSideQuestionAdmissionResult,
  validateSideQuestionRendererRequest,
  type SideQuestionAdmissionResult,
  type SideQuestionRendererRequest
} from './side-question'

const sideQuestionRequestSchema = z
  .object({
    sessionId: z.string(),
    question: z.string().max(64_000),
    parts: z.array(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional()
  })
  .strict()

export const sideQuestionApplicationCommandContract: ApplicationCommandContract<
  readonly [SideQuestionRendererRequest],
  SideQuestionAdmissionResult
> = Object.freeze({
  args: validationCodec({
    parse: (value) => {
      const parsed = z.tuple([sideQuestionRequestSchema]).parse(value)
      validateSideQuestionRendererRequest(parsed[0])
      return parsed as readonly [SideQuestionRendererRequest]
    }
  }),
  result: validationCodec({ parse: validateSideQuestionAdmissionResult })
})

export const sideQuestionListApplicationCommandContract: ApplicationCommandContract<
  readonly [string],
  readonly import('./side-question').PersistedSideQuestion[]
> = Object.freeze({
  args: validationCodec({
    parse: (value) => z.tuple([z.string()]).parse(value) as readonly [string]
  }),
  result: validationCodec({
    parse: (value) => value as readonly import('./side-question').PersistedSideQuestion[]
  })
})

export const sideQuestionCancelApplicationCommandContract: ApplicationCommandContract<
  readonly [string, string],
  import('./side-question').PersistedSideQuestion | undefined
> = Object.freeze({
  args: validationCodec({
    parse: (value) => z.tuple([z.string(), z.string()]).parse(value) as readonly [string, string]
  }),
  result: validationCodec({
    parse: (value) => value as import('./side-question').PersistedSideQuestion | undefined
  })
})
