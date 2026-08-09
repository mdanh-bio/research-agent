import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const isInside = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}

const canonicalExistingPath = (path: string, label: string): string => {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`)
  try {
    return realpathSync.native(resolve(path))
  } catch {
    throw new Error(`${label} must resolve to an existing path.`)
  }
}

const canonicalRoots = (roots: readonly string[], label: string): readonly string[] =>
  Object.freeze(
    Array.from(
      new Set(
        roots.map((root) => {
          const canonical = canonicalExistingPath(root, label)
          if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory.`)
          return canonical
        })
      )
    )
  )

export class CodexPathAuthority {
  readonly #authorizedRoots: readonly string[]
  readonly #workspaceWriteRoots: readonly string[]

  constructor(
    options: Readonly<{
      authorizedRoots?: readonly string[]
      workspaceWriteRoots?: readonly string[]
    }>
  ) {
    this.#workspaceWriteRoots = canonicalRoots(
      options.workspaceWriteRoots ?? [],
      'Codex workspace-write root'
    )
    this.#authorizedRoots = canonicalRoots(
      options.authorizedRoots ?? options.workspaceWriteRoots ?? [],
      'Codex authorized root'
    )
    if (this.#authorizedRoots.length === 0) {
      throw new Error('At least one Codex authorized root is required.')
    }
    for (const root of this.#workspaceWriteRoots) {
      if (!this.#authorizedRoots.some((authorized) => isInside(authorized, root))) {
        throw new Error('Every Codex workspace-write root must be inside an authorized root.')
      }
    }
  }

  resolveAuthorizedDirectory(path: string, label: string): string {
    return this.#resolveAuthorized(path, label, 'directory', this.#authorizedRoots)
  }

  resolveWorkspaceDirectory(path: string, label: string): string {
    return this.#resolveAuthorized(path, label, 'directory', this.#workspaceWriteRoots)
  }

  resolveAuthorizedFile(path: string, label: string): string {
    return this.#resolveAuthorized(path, label, 'file', this.#authorizedRoots)
  }

  #resolveAuthorized(
    path: string,
    label: string,
    kind: 'file' | 'directory',
    roots: readonly string[]
  ): string {
    const canonical = canonicalExistingPath(path, label)
    if (!roots.some((root) => isInside(root, canonical))) {
      throw new Error(`${label} is outside application-authorized roots.`)
    }
    const metadata = statSync(canonical)
    if (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory()) {
      throw new Error(`${label} must be a ${kind}.`)
    }
    return canonical
  }
}
