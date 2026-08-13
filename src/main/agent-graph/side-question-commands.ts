import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import {
  sideQuestionListApplicationCommandContract,
  sideQuestionCancelApplicationCommandContract
} from '../../shared/side-question-contract'
import type { SideQuestionOwner } from './side-question-owner'

const sideQuestionListCommand = defineApplicationCommand<
  'side-question:list',
  readonly [sessionId: string],
  Awaited<ReturnType<SideQuestionOwner['list']>>
>('side-question:list', sideQuestionListApplicationCommandContract)

const sideQuestionCancelCommand = defineApplicationCommand<
  'side-question:cancel',
  readonly [sessionId: string, sideQuestionId: string],
  Awaited<ReturnType<SideQuestionOwner['cancel']>>
>('side-question:cancel', sideQuestionCancelApplicationCommandContract)

const sideQuestionApplicationCommandGroup = defineApplicationCommandGroup('side-question', [
  sideQuestionListCommand,
  sideQuestionCancelCommand
] as const)

type SideQuestionCommandDependencies = Readonly<{
  owner: Pick<SideQuestionOwner, 'list' | 'cancel'>
  enabled: boolean
}>

const registerSideQuestionCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: SideQuestionCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()
  try {
    scope.registerGroup(sideQuestionApplicationCommandGroup, {
      'side-question:list': ({ args }) => dependencies.owner.list(args[0]),
      'side-question:cancel': ({ args }) => {
        if (!dependencies.enabled) throw new Error('M2 side questions are not enabled.')
        return dependencies.owner.cancel(args[0], args[1])
      }
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerSideQuestionCommands,
  sideQuestionApplicationCommandGroup,
  sideQuestionCancelCommand,
  sideQuestionListCommand
}
export type { SideQuestionCommandDependencies }
