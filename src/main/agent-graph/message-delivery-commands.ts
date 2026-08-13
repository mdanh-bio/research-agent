import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import { messageDeliveryApplicationCommandContract } from '../../shared/message-delivery-contract'
import type { MessageDeliveryCommandResult } from '../../shared/message-delivery'

const messageDeliveryCommand = defineApplicationCommand<
  'message-delivery:deliver',
  readonly [request: unknown],
  MessageDeliveryCommandResult
>('message-delivery:deliver', messageDeliveryApplicationCommandContract)

const messageDeliveryApplicationCommandGroup = defineApplicationCommandGroup('message-delivery', [
  messageDeliveryCommand
] as const)

type MessageDeliveryCommandDependencies = Readonly<{
  owner: { deliver(value: unknown): Promise<MessageDeliveryCommandResult> }
  enabled: boolean
}>

const registerMessageDeliveryCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: MessageDeliveryCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(messageDeliveryApplicationCommandGroup, {
      'message-delivery:deliver': ({ args }) => {
        if (!dependencies.enabled) throw new Error('M2 delivery is not enabled.')
        return dependencies.owner.deliver(args[0])
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  messageDeliveryApplicationCommandGroup,
  messageDeliveryCommand,
  registerMessageDeliveryCommands
}
export type { MessageDeliveryCommandDependencies }
