import { z } from 'zod'

import { validationCodec, type ApplicationCommandContract } from './application-command-contract'
import {
  validateMessageDeliveryRendererRequest,
  validateMessageDeliveryCommandResult,
  MESSAGE_DELIVERY_MODES,
  type MessageDeliveryCommandResult
} from './message-delivery'

const rendererMessagePartSchema = z.record(z.string(), z.unknown())
const rendererAttachmentSchema = z.record(z.string(), z.unknown())

export const messageDeliveryRendererRequestSchema = z
  .object({
    sessionId: z.string(),
    content: z.string().max(256_000),
    parts: z.array(rendererMessagePartSchema).optional(),
    attachments: z.array(rendererAttachmentSchema).optional(),
    requested: z.enum(MESSAGE_DELIVERY_MODES)
  })
  .strict()

export type MessageDeliveryRendererRequestCodec = z.infer<
  typeof messageDeliveryRendererRequestSchema
>

export const messageDeliveryApplicationCommandContract: ApplicationCommandContract<
  readonly [MessageDeliveryRendererRequestCodec],
  MessageDeliveryCommandResult
> = Object.freeze({
  args: validationCodec({
    parse: (value) => {
      const parsed = z.tuple([messageDeliveryRendererRequestSchema]).parse(value)
      validateMessageDeliveryRendererRequest(parsed[0])
      return parsed
    }
  }),
  result: validationCodec({
    parse: validateMessageDeliveryCommandResult
  }) as ApplicationCommandContract<
    readonly [MessageDeliveryRendererRequestCodec],
    MessageDeliveryCommandResult
  >['result']
})
