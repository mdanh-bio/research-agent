import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { FileReference } from '../../shared/artifacts'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { imageAttachmentMimeType, parseUploadVersionReference } from '../../shared/uploads'
import type { ArtifactRepository } from '../artifacts/repository'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { UploadRepository } from '../uploads/repository'

export type FileReferenceContext = {
  projectId: string
  sessionId: string
}

export type ResolvedFileReference = {
  absolutePath: string
  uri: string
  name: string
  mimeType?: string
  size: number
  allowSkillImportReference: boolean
}

export type ImmutableFileReference = Readonly<{
  canonicalReference: FileReference
  versionId: string
  name: string
  mimeType?: string
  sizeBytes: number
  sha256: `sha256:${string}`
  imageInput: boolean
}>

const checksumFile = async (path: string): Promise<`sha256:${string}`> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

// This adapter is the deliberate extension seam for linked folders and other future file origins.
// An adapter must validate its own capability before returning an absolute path.
export type FileReferenceAdapter = {
  source: FileReference['source']
  resolve(
    context: FileReferenceContext,
    reference: FileReference
  ): Promise<Omit<ResolvedFileReference, 'uri' | 'size'>>
}

export class FileReferenceResolver {
  private readonly adapters = new Map<FileReference['source'], FileReferenceAdapter>()

  constructor(adapters: FileReferenceAdapter[]) {
    for (const adapter of adapters) this.adapters.set(adapter.source, adapter)
  }

  async resolve(
    context: FileReferenceContext,
    reference: FileReference
  ): Promise<ResolvedFileReference> {
    const adapter = this.adapters.get(reference.source)
    if (!adapter) throw new Error(`File reference source is not configured: ${reference.source}`)

    const resolved = await adapter.resolve(context, reference)
    const fileInfo = await stat(resolved.absolutePath)
    if (!fileInfo.isFile()) throw new Error('Referenced path is not a file.')

    return {
      ...resolved,
      uri: pathToFileURL(resolved.absolutePath).href,
      size: fileInfo.size
    }
  }

  // Routed runs require a native immutable Version rather than a compatibility path.  The managed
  // resolver re-checks ownership and version bytes; this additional digest binds the exact contents
  // to the routing ledger without persisting a local path.
  async resolveImmutable(
    context: FileReferenceContext,
    reference: FileReference
  ): Promise<ImmutableFileReference> {
    if (reference.source === 'linked-folder') {
      throw new Error('Transparent routing requires an immutable managed File Version reference.')
    }
    const locator =
      reference.source === 'upload'
        ? parseUploadVersionReference(reference.path)
        : parseArtifactVersionLocator(reference.path)
    if (!locator) {
      throw new Error(
        'Transparent routing requires an immutable Version reference, not a legacy file path.'
      )
    }
    if (reference.versionId && reference.versionId !== locator.versionId) {
      throw new Error('Referenced File Version id does not match its immutable locator.')
    }
    const resolved = await this.resolve(context, reference)
    const sha256 = await checksumFile(resolved.absolutePath)
    const canonicalReference = Object.freeze({
      ...reference,
      versionId: locator.versionId,
      name: resolved.name,
      ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {})
    }) as FileReference
    return Object.freeze({
      canonicalReference,
      versionId: locator.versionId,
      name: resolved.name,
      ...(resolved.mimeType ? { mimeType: resolved.mimeType } : {}),
      sizeBytes: resolved.size,
      sha256,
      imageInput: Boolean(imageAttachmentMimeType(resolved.name, resolved.mimeType))
    })
  }
}

export const createManagedFileReferenceResolver = (dependencies: {
  uploads?: UploadRepository
  artifacts?: ArtifactRepository
  artifactVersions?: Partial<Pick<ArtifactProvenanceRepository, 'resolveVersionContent'>>
}): FileReferenceResolver => {
  const adapters: FileReferenceAdapter[] = []

  if (dependencies.uploads) {
    adapters.push({
      source: 'upload',
      resolve: async ({ projectId, sessionId }, reference) => {
        if (reference.source !== 'upload') throw new Error('Invalid upload reference.')
        let absolutePath: string
        try {
          absolutePath = await dependencies.uploads!.resolveSessionUploadPath(
            sessionId,
            { path: reference.path },
            projectId
          )
        } catch {
          // A turn-scoped `@` selection is an explicit user capability and may intentionally refer
          // to a managed upload from another Session. Project ownership remains an app-issued
          // boundary: native Versions and trusted legacy mappings must still belong to this Project.
          absolutePath = await dependencies.uploads!.resolveManagedUploadPath(
            { path: reference.path },
            { projectId }
          )
        }
        return {
          absolutePath,
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: true
        }
      }
    })
  }

  if (dependencies.artifacts) {
    adapters.push({
      source: 'artifact',
      resolve: async ({ projectId }, reference) => {
        if (reference.source !== 'artifact') throw new Error('Invalid artifact reference.')
        const versionIdentity = parseArtifactVersionLocator(reference.path)
        if (versionIdentity) {
          if (versionIdentity.projectId !== projectId) {
            throw new Error('Artifact Version belongs to a different project.')
          }
          if (!dependencies.artifactVersions?.resolveVersionContent) {
            throw new Error('Artifact Provenance is not configured.')
          }
          const resolved =
            await dependencies.artifactVersions.resolveVersionContent(versionIdentity)
          return {
            absolutePath: resolved.path,
            name: resolved.filename,
            mimeType: resolved.contentType ?? reference.mimeType,
            allowSkillImportReference: false
          }
        }
        return {
          absolutePath: await dependencies.artifacts!.resolveManagedFilePath({
            path: reference.path
          }),
          name: reference.name,
          mimeType: reference.mimeType,
          allowSkillImportReference: false
        }
      }
    })
  }

  return new FileReferenceResolver(adapters)
}
