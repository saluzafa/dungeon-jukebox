import type { AudioCategory, AudioFileEntry, AudioMeta, CollectionEntry } from '@/types/soundboard'
import { loadFolderHandle, saveFolderHandle } from '@/utils/folderHandleStore'
import type { StorageAdapter, StorageRoot } from './storageAdapter'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'])
const COLLECTION_META_FILE = 'collection.json'

interface CollectionMeta {
  title?: string | null
  iconImage?: string | null
}

interface FsRootRef {
  dirHandle: FileSystemDirectoryHandle
}

interface FsCollectionRef {
  dirHandle: FileSystemDirectoryHandle
  audioDirHandle: FileSystemDirectoryHandle
}

interface FsAudioRef {
  fileHandle: FileSystemFileHandle
  audioDirHandle: FileSystemDirectoryHandle
}

const defaultAudioMeta: AudioMeta = {
  title: null,
  iconImage: null,
  category: 'sound',
  infiniteLoop: false,
  trimStart: null,
  trimEnd: null,
  volume: 100,
}

function extname(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

function metadataFileNameForAudio(fileName: string): string {
  return `${fileName}.json`
}

function normalizeRelativePath(path: string | null | undefined): string {
  if (!path) {
    return ''
  }

  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

function joinRelativePath(parentPath: string, childName: string): string {
  const normalizedParent = normalizeRelativePath(parentPath)
  const normalizedChild = normalizeRelativePath(childName)
  if (!normalizedParent) {
    return normalizedChild
  }
  if (!normalizedChild) {
    return normalizedParent
  }
  return `${normalizedParent}/${normalizedChild}`
}

function sanitizeAudioMeta(meta: Partial<AudioMeta> | null | undefined): AudioMeta {
  const category: AudioCategory =
    meta?.category === 'music' || meta?.category === 'effect' || meta?.category === 'sound'
      ? meta.category
      : defaultAudioMeta.category

  return {
    title: typeof meta?.title === 'string' && meta.title.trim().length > 0 ? meta.title : null,
    iconImage: typeof meta?.iconImage === 'string' ? meta.iconImage : null,
    category,
    infiniteLoop: Boolean(meta?.infiniteLoop),
    trimStart: typeof meta?.trimStart === 'number' ? Math.max(0, meta.trimStart) : null,
    trimEnd: typeof meta?.trimEnd === 'number' ? Math.max(0, meta.trimEnd) : null,
    volume:
      typeof meta?.volume === 'number' && Number.isFinite(meta.volume)
        ? Math.min(100, Math.max(0, Math.round(meta.volume)))
        : defaultAudioMeta.volume,
  }
}

function getCollectionDisplayTitle(metaTitle: string | null | undefined, fallbackName: string): string {
  const trimmed = metaTitle?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallbackName
}

async function getTextFileJson<T>(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<T | null> {
  try {
    const handle = await dirHandle.getFileHandle(fileName)
    const file = await handle.getFile()
    const text = await file.text()
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function writeTextFileJson(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  value: unknown,
): Promise<void> {
  const handle = await dirHandle.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(value, null, 2))
  await writable.close()
}

async function writeBinaryFile(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  data: ArrayBuffer,
): Promise<void> {
  const handle = await dirHandle.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}

async function hasFile(
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(fileName)
    return true
  } catch {
    return false
  }
}

async function uniqueFileName(
  dirHandle: FileSystemDirectoryHandle,
  desiredName: string,
): Promise<string> {
  if (!(await hasFile(dirHandle, desiredName))) {
    return desiredName
  }

  const dotIndex = desiredName.lastIndexOf('.')
  const baseName = dotIndex >= 0 ? desiredName.slice(0, dotIndex) : desiredName
  const extension = dotIndex >= 0 ? desiredName.slice(dotIndex) : ''
  let counter = 2

  while (counter < 10000) {
    const candidate = `${baseName} (${counter})${extension}`
    if (!(await hasFile(dirHandle, candidate))) {
      return candidate
    }
    counter += 1
  }

  return `${baseName}-${Date.now()}${extension}`
}

async function ensureDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
  create = true,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create })
}

async function resolveRelativeDirectoryHandle(
  rootDirHandle: FileSystemDirectoryHandle,
  relativePath: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const normalizedPath = normalizeRelativePath(relativePath)
  if (!normalizedPath) {
    return rootDirHandle
  }

  let current = rootDirHandle
  const segments = normalizedPath.split('/')
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create })
  }
  return current
}

async function tryResolveRelativeDirectoryHandle(
  rootDirHandle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await resolveRelativeDirectoryHandle(rootDirHandle, relativePath, false)
  } catch {
    return null
  }
}

async function copyDirectoryContents(
  sourceDirHandle: FileSystemDirectoryHandle,
  targetDirHandle: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const [, entry] of sourceDirHandle.entries()) {
    if (entry.kind === 'directory') {
      const sourceChildDirHandle = entry as FileSystemDirectoryHandle
      const targetChildDirHandle = await targetDirHandle.getDirectoryHandle(sourceChildDirHandle.name, {
        create: true,
      })
      await copyDirectoryContents(sourceChildDirHandle, targetChildDirHandle)
      continue
    }

    if (entry.kind !== 'file') {
      continue
    }

    const sourceFileHandle = entry as FileSystemFileHandle
    const sourceFile = await sourceFileHandle.getFile()
    await writeBinaryFile(targetDirHandle, sourceFileHandle.name, await sourceFile.arrayBuffer())
  }
}

async function hasFolderPermission(
  handle: FileSystemDirectoryHandle,
  shouldRequest: boolean,
): Promise<boolean> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' }
  if (!handle.queryPermission || !handle.requestPermission) {
    return true
  }

  const queried = await handle.queryPermission(opts)
  if (queried === 'granted') {
    return true
  }
  if (!shouldRequest) {
    return false
  }
  const requested = await handle.requestPermission(opts)
  return requested === 'granted'
}

function getRootRef(root: StorageRoot): FsRootRef {
  return root.storageRef as FsRootRef
}

function getCollectionRef(collection: CollectionEntry): FsCollectionRef {
  return collection.storageRef as FsCollectionRef
}

function getAudioRef(audio: AudioFileEntry): FsAudioRef {
  return audio.storageRef as FsAudioRef
}

async function moveAudioFileEntry(
  audio: AudioFileEntry,
  targetAudioDirHandle: FileSystemDirectoryHandle,
): Promise<string> {
  const sourceRef = getAudioRef(audio)
  const sourceAudioFile = await sourceRef.fileHandle.getFile()
  const targetAudioName = await uniqueFileName(targetAudioDirHandle, audio.name)
  await writeBinaryFile(
    targetAudioDirHandle,
    targetAudioName,
    await sourceAudioFile.arrayBuffer(),
  )

  const nextMeta = { ...audio.metadata }
  if (audio.metadata.iconImage) {
    try {
      const sourceIconHandle = await sourceRef.audioDirHandle.getFileHandle(audio.metadata.iconImage)
      const sourceIconFile = await sourceIconHandle.getFile()
      const targetIconName = await uniqueFileName(targetAudioDirHandle, audio.metadata.iconImage)
      await writeBinaryFile(
        targetAudioDirHandle,
        targetIconName,
        await sourceIconFile.arrayBuffer(),
      )
      nextMeta.iconImage = targetIconName
    } catch {
      nextMeta.iconImage = null
    }
  }

  const targetMetaFileName = metadataFileNameForAudio(targetAudioName)
  await writeTextFileJson(targetAudioDirHandle, targetMetaFileName, nextMeta)

  try {
    await sourceRef.audioDirHandle.removeEntry(audio.name)
  } catch {
    // no-op; file may have been removed already
  }
  try {
    await sourceRef.audioDirHandle.removeEntry(audio.metadataFileName)
  } catch {
    // no-op; metadata file may have been removed already
  }
  if (audio.metadata.iconImage) {
    try {
      await sourceRef.audioDirHandle.removeEntry(audio.metadata.iconImage)
    } catch {
      // no-op; icon file may have been removed already
    }
  }

  return audio.metadata.title?.trim() || audio.name
}

export class FileSystemStorageAdapter implements StorageAdapter {
  isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'showDirectoryPicker' in window &&
      'indexedDB' in window &&
      'FileSystemDirectoryHandle' in window
    )
  }

  async connectRoot(): Promise<StorageRoot | null> {
    const picker = window.showDirectoryPicker
    if (!picker) {
      return null
    }

    const dirHandle = await picker({ mode: 'readwrite' })
    return {
      name: dirHandle.name,
      storageRef: { dirHandle } satisfies FsRootRef,
    }
  }

  async restoreRoot(): Promise<StorageRoot | null> {
    const dirHandle = await loadFolderHandle()
    if (!dirHandle) {
      return null
    }

    return {
      name: dirHandle.name,
      storageRef: { dirHandle } satisfies FsRootRef,
    }
  }

  async ensureRootPermission(root: StorageRoot, shouldRequest: boolean): Promise<boolean> {
    return hasFolderPermission(getRootRef(root).dirHandle, shouldRequest)
  }

  async loadCollections(root: StorageRoot): Promise<CollectionEntry[]> {
    const rootDirHandle = getRootRef(root).dirHandle
    const collectionsDir = await ensureDirectory(rootDirHandle, 'collections', true)
    const nextCollections: CollectionEntry[] = []

    for await (const [, entry] of collectionsDir.entries()) {
      if (entry.kind !== 'directory') {
        continue
      }

      const dirHandle = entry as FileSystemDirectoryHandle
      const meta = await getTextFileJson<CollectionMeta>(dirHandle, COLLECTION_META_FILE)
      const audioDirHandle = await ensureDirectory(dirHandle, 'audio_files', true)
      const audioFiles: AudioFileEntry[] = []
      const directoryPaths: string[] = []

      async function walkAudioDirectory(
        currentDirHandle: FileSystemDirectoryHandle,
        currentRelativePath: string,
      ): Promise<void> {
        for await (const [, child] of currentDirHandle.entries()) {
          if (child.kind === 'directory') {
            const childDirHandle = child as FileSystemDirectoryHandle
            const childRelativePath = joinRelativePath(currentRelativePath, childDirHandle.name)
            directoryPaths.push(childRelativePath)
            await walkAudioDirectory(childDirHandle, childRelativePath)
            continue
          }

          if (child.kind !== 'file') {
            continue
          }
          const fileHandle = child as FileSystemFileHandle
          if (!AUDIO_EXTENSIONS.has(extname(fileHandle.name))) {
            continue
          }

          const metadataFileName = metadataFileNameForAudio(fileHandle.name)
          const rawMeta = await getTextFileJson<Partial<AudioMeta>>(currentDirHandle, metadataFileName)
          const metadata = sanitizeAudioMeta(rawMeta)
          const relativeAudioPath = joinRelativePath(currentRelativePath, fileHandle.name)

          audioFiles.push({
            id: `${dirHandle.name}/${relativeAudioPath}`,
            name: fileHandle.name,
            relativePath: currentRelativePath,
            collectionName: dirHandle.name,
            metadataFileName,
            metadata,
            storageRef: {
              fileHandle,
              audioDirHandle: currentDirHandle,
            } satisfies FsAudioRef,
          })
        }
      }

      await walkAudioDirectory(audioDirHandle, '')

      directoryPaths.sort((a, b) => a.localeCompare(b))
      audioFiles.sort((a, b) => {
        if (a.relativePath !== b.relativePath) {
          return a.relativePath.localeCompare(b.relativePath)
        }
        return a.name.localeCompare(b.name)
      })

      nextCollections.push({
        name: dirHandle.name,
        title: getCollectionDisplayTitle(meta?.title, dirHandle.name),
        iconImage: meta?.iconImage ?? null,
        directoryPaths,
        audioFiles,
        storageRef: {
          dirHandle,
          audioDirHandle,
        } satisfies FsCollectionRef,
      })
    }

    nextCollections.sort((a, b) => a.name.localeCompare(b.name))
    await saveFolderHandle(rootDirHandle)
    return nextCollections
  }

  async createCollection(root: StorageRoot, name: string, iconFile?: File | null): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) {
      throw new Error('Collection name is required')
    }

    const rootDirHandle = getRootRef(root).dirHandle
    const collectionsDir = await ensureDirectory(rootDirHandle, 'collections', true)
    const dirHandle = await ensureDirectory(collectionsDir, trimmed, true)
    await ensureDirectory(dirHandle, 'audio_files', true)

    const meta: CollectionMeta = {
      title: trimmed,
      iconImage: null,
    }

    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `collection-icon${iconExt}`
      const iconHandle = await dirHandle.getFileHandle(iconName, { create: true })
      const writable = await iconHandle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      meta.iconImage = iconName
    }

    await writeTextFileJson(dirHandle, COLLECTION_META_FILE, meta)
  }

  async importAudioFiles(
    collection: CollectionEntry,
    files: File[],
    targetDirectoryPath = '',
  ): Promise<void> {
    if (files.length === 0) {
      return
    }

    const collectionRef = getCollectionRef(collection)
    const targetAudioDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      targetDirectoryPath,
      true,
    )

    for (const file of files) {
      if (!AUDIO_EXTENSIONS.has(extname(file.name))) {
        continue
      }
      const handle = await targetAudioDirHandle.getFileHandle(file.name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(await file.arrayBuffer())
      await writable.close()

      const metaFileName = metadataFileNameForAudio(file.name)
      await writeTextFileJson(targetAudioDirHandle, metaFileName, defaultAudioMeta)
    }
  }

  async createCollectionSubDirectory(
    collection: CollectionEntry,
    parentDirectoryPath: string,
    directoryName: string,
  ): Promise<void> {
    const trimmedDirectoryName = directoryName.trim()
    if (!trimmedDirectoryName) {
      return
    }

    const normalizedDirectoryName = normalizeRelativePath(trimmedDirectoryName)
    if (!normalizedDirectoryName) {
      return
    }

    const collectionRef = getCollectionRef(collection)
    const parentHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      parentDirectoryPath,
      true,
    )
    await resolveRelativeDirectoryHandle(parentHandle, normalizedDirectoryName, true)
  }

  async renameCollectionSubDirectory(
    collection: CollectionEntry,
    directoryPath: string,
    newDirectoryName: string,
  ): Promise<{ fromPath: string; toPath: string } | null> {
    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    if (!normalizedDirectoryPath) {
      return null
    }

    const nextDirectoryName = normalizeRelativePath(newDirectoryName.trim())
    if (!nextDirectoryName || nextDirectoryName.includes('/')) {
      throw new Error('Directory name must be a single folder name.')
    }

    const sourceSegments = normalizedDirectoryPath.split('/')
    const sourceLeafName = sourceSegments[sourceSegments.length - 1] ?? ''
    if (!sourceLeafName) {
      return null
    }

    const parentDirectoryPath = sourceSegments.slice(0, -1).join('/')
    const normalizedTargetPath = joinRelativePath(parentDirectoryPath, nextDirectoryName)
    if (normalizedTargetPath === normalizedDirectoryPath) {
      return null
    }

    const collectionRef = getCollectionRef(collection)
    const existingTargetHandle = await tryResolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedTargetPath,
    )
    if (existingTargetHandle) {
      throw new Error(`Directory "${nextDirectoryName}" already exists.`)
    }

    const sourceDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedDirectoryPath,
      false,
    )
    const parentDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      parentDirectoryPath,
      false,
    )
    const targetDirHandle = await parentDirHandle.getDirectoryHandle(nextDirectoryName, { create: true })

    await copyDirectoryContents(sourceDirHandle, targetDirHandle)
    await parentDirHandle.removeEntry(sourceLeafName, { recursive: true })

    return {
      fromPath: normalizedDirectoryPath,
      toPath: normalizedTargetPath,
    }
  }

  async moveCollectionSubDirectory(
    collection: CollectionEntry,
    directoryPath: string,
    targetParentDirectoryPath: string,
  ): Promise<{ fromPath: string; toPath: string } | null> {
    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    const normalizedTargetParentPath = normalizeRelativePath(targetParentDirectoryPath)
    if (!normalizedDirectoryPath) {
      return null
    }

    const sourceSegments = normalizedDirectoryPath.split('/')
    const sourceLeafName = sourceSegments[sourceSegments.length - 1] ?? ''
    if (!sourceLeafName) {
      return null
    }

    const sourceParentPath = sourceSegments.slice(0, -1).join('/')
    const normalizedTargetPath = joinRelativePath(normalizedTargetParentPath, sourceLeafName)
    if (normalizedTargetPath === normalizedDirectoryPath) {
      return null
    }

    if (
      normalizedTargetParentPath === normalizedDirectoryPath ||
      normalizedTargetParentPath.startsWith(`${normalizedDirectoryPath}/`)
    ) {
      throw new Error('Cannot move a folder into itself or one of its subfolders.')
    }

    const collectionRef = getCollectionRef(collection)
    const existingTargetHandle = await tryResolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedTargetPath,
    )
    if (existingTargetHandle) {
      throw new Error(`Directory "${sourceLeafName}" already exists in /${normalizedTargetParentPath || ''}`)
    }

    const sourceDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedDirectoryPath,
      false,
    )
    const sourceParentDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      sourceParentPath,
      false,
    )
    const targetParentDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedTargetParentPath,
      false,
    )
    const targetDirHandle = await targetParentDirHandle.getDirectoryHandle(sourceLeafName, { create: true })

    await copyDirectoryContents(sourceDirHandle, targetDirHandle)
    await sourceParentDirHandle.removeEntry(sourceLeafName, { recursive: true })

    return {
      fromPath: normalizedDirectoryPath,
      toPath: normalizedTargetPath,
    }
  }

  async deleteCollectionSubDirectory(collection: CollectionEntry, directoryPath: string): Promise<string | null> {
    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    if (!normalizedDirectoryPath) {
      return null
    }

    const directorySegments = normalizedDirectoryPath.split('/')
    const directoryName = directorySegments[directorySegments.length - 1] ?? ''
    if (!directoryName) {
      return null
    }

    const collectionRef = getCollectionRef(collection)
    const parentDirectoryPath = directorySegments.slice(0, -1).join('/')
    const parentDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      parentDirectoryPath,
      false,
    )

    await parentDirHandle.removeEntry(directoryName, { recursive: true })
    return normalizedDirectoryPath
  }

  async setCollectionIcon(collection: CollectionEntry, iconFile: File | null): Promise<void> {
    const collectionRef = getCollectionRef(collection)

    let nextIconImage: string | null = null
    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `collection-icon${iconExt}`
      const handle = await collectionRef.dirHandle.getFileHandle(iconName, { create: true })
      const writable = await handle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      nextIconImage = iconName
    }

    await writeTextFileJson(collectionRef.dirHandle, COLLECTION_META_FILE, {
      title: collection.title,
      iconImage: nextIconImage,
    } satisfies CollectionMeta)
  }

  async setCollectionTitle(collection: CollectionEntry, title: string): Promise<void> {
    const collectionRef = getCollectionRef(collection)
    const nextTitle = getCollectionDisplayTitle(title, collection.name)
    await writeTextFileJson(collectionRef.dirHandle, COLLECTION_META_FILE, {
      title: nextTitle,
      iconImage: collection.iconImage,
    } satisfies CollectionMeta)
  }

  async deleteCollection(root: StorageRoot, collectionName: string): Promise<void> {
    const rootDirHandle = getRootRef(root).dirHandle
    const collectionsDir = await ensureDirectory(rootDirHandle, 'collections', true)
    await collectionsDir.removeEntry(collectionName, { recursive: true })
  }

  async updateAudioMeta(audio: AudioFileEntry, patch: Partial<AudioMeta>): Promise<AudioMeta> {
    const audioRef = getAudioRef(audio)
    const nextMeta = sanitizeAudioMeta({ ...audio.metadata, ...patch })

    if (
      nextMeta.trimStart !== null &&
      nextMeta.trimEnd !== null &&
      nextMeta.trimStart > nextMeta.trimEnd
    ) {
      nextMeta.trimEnd = nextMeta.trimStart
    }

    await writeTextFileJson(audioRef.audioDirHandle, audio.metadataFileName, nextMeta)
    return nextMeta
  }

  async setAudioIcon(audio: AudioFileEntry, iconFile: File | null): Promise<AudioMeta> {
    const audioRef = getAudioRef(audio)
    const nextMeta = { ...audio.metadata }

    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `${audio.name}.icon${iconExt}`
      const iconHandle = await audioRef.audioDirHandle.getFileHandle(iconName, { create: true })
      const writable = await iconHandle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      nextMeta.iconImage = iconName
    } else {
      nextMeta.iconImage = null
    }

    await writeTextFileJson(audioRef.audioDirHandle, audio.metadataFileName, nextMeta)
    return nextMeta
  }

  async deleteAudioFile(audio: AudioFileEntry): Promise<void> {
    const audioRef = getAudioRef(audio)

    try {
      await audioRef.audioDirHandle.removeEntry(audio.name)
    } catch {
      // no-op; file may have been removed already
    }

    try {
      await audioRef.audioDirHandle.removeEntry(audio.metadataFileName)
    } catch {
      // no-op; metadata file may not exist
    }

    if (audio.metadata.iconImage) {
      try {
        await audioRef.audioDirHandle.removeEntry(audio.metadata.iconImage)
      } catch {
        // no-op; icon file may not exist
      }
    }
  }

  async moveAudioFilesToDirectory(
    collection: CollectionEntry,
    audios: AudioFileEntry[],
    targetDirectoryPath: string,
  ): Promise<string[]> {
    if (audios.length === 0) {
      return []
    }

    const normalizedTargetPath = normalizeRelativePath(targetDirectoryPath)
    const collectionRef = getCollectionRef(collection)
    const targetAudioDirHandle = await resolveRelativeDirectoryHandle(
      collectionRef.audioDirHandle,
      normalizedTargetPath,
      true,
    )

    const movedTitles: string[] = []
    for (const audio of audios) {
      movedTitles.push(await moveAudioFileEntry(audio, targetAudioDirHandle))
    }
    return movedTitles
  }

  async moveAudioFilesToCollection(targetCollection: CollectionEntry, audios: AudioFileEntry[]): Promise<string[]> {
    if (audios.length === 0) {
      return []
    }

    const targetCollectionRef = getCollectionRef(targetCollection)
    const movedTitles: string[] = []
    for (const audio of audios) {
      movedTitles.push(await moveAudioFileEntry(audio, targetCollectionRef.audioDirHandle))
    }
    return movedTitles
  }

  async getAudioFile(audio: AudioFileEntry): Promise<File> {
    return getAudioRef(audio).fileHandle.getFile()
  }

  async resolveCollectionIconUrl(collection: CollectionEntry): Promise<string | null> {
    if (!collection.iconImage) {
      return null
    }

    try {
      const collectionRef = getCollectionRef(collection)
      const handle = await collectionRef.dirHandle.getFileHandle(collection.iconImage)
      const file = await handle.getFile()
      return URL.createObjectURL(file)
    } catch {
      return null
    }
  }

  async resolveAudioIconUrl(audio: AudioFileEntry): Promise<string | null> {
    const iconName = audio.metadata.iconImage
    if (!iconName) {
      return null
    }

    try {
      const audioRef = getAudioRef(audio)
      const handle = await audioRef.audioDirHandle.getFileHandle(iconName)
      const file = await handle.getFile()
      return URL.createObjectURL(file)
    } catch {
      return null
    }
  }
}

export function createFileSystemStorageAdapter(): StorageAdapter {
  return new FileSystemStorageAdapter()
}
