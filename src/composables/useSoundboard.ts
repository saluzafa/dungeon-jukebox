import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ActiveTrack, AudioCategory, AudioFileEntry, AudioMeta, CollectionEntry } from '@/types/soundboard'
import { loadFolderHandle, saveFolderHandle } from '@/utils/folderHandleStore'

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'])
const COLLECTION_META_FILE = 'collection.json'

interface CollectionMeta {
  title?: string | null
  iconImage?: string | null
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

function getAudioDisplayTitle(audio: AudioFileEntry): string {
  return audio.metadata.title?.trim() || audio.name
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

function createTrackId(audioId: string): string {
  return `${audioId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useSoundboard() {
  let webAudioContext: AudioContext | null = null
  const rootHandle = ref<FileSystemDirectoryHandle | null>(null)
  const collections = ref<CollectionEntry[]>([])
  const selectedCollectionName = ref<string | null>(null)
  const activeTracks = ref<ActiveTrack[]>([])
  const globalVolume = ref(100)
  const loading = ref(false)
  const restoring = ref(false)
  const status = ref<string>('Connect a local folder to start.')

  const isFileSystemAccessSupported =
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    'indexedDB' in window &&
    'FileSystemDirectoryHandle' in window

  const selectedCollection = computed(() =>
    collections.value.find((collection) => collection.name === selectedCollectionName.value) ?? null,
  )

  const allAudioFiles = computed(() =>
    collections.value.flatMap((collection) => collection.audioFiles.map((audio) => audio)),
  )

  function clampVolume(volume: number): number {
    if (!Number.isFinite(volume)) {
      return 100
    }
    return Math.max(0, Math.min(100, Math.round(volume)))
  }

  function applyTrackOutputVolume(track: ActiveTrack): void {
    const outputVolume = (track.volume / 100) * (globalVolume.value / 100)
    if (track.outputGainNode) {
      track.outputGainNode.gain.value = outputVolume
      return
    }
    if (track.audioElement) {
      track.audioElement.volume = outputVolume
    }
  }

  function getWebAudioContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') {
      return null
    }
    if (!webAudioContext) {
      webAudioContext = new AudioContext()
    }
    return webAudioContext
  }

  function findNearestZeroCrossing(
    channelData: Float32Array,
    targetSample: number,
    searchRadiusSamples: number,
  ): number {
    const minSample = Math.max(1, targetSample - searchRadiusSamples)
    const maxSample = Math.min(channelData.length - 1, targetSample + searchRadiusSamples)
    let bestSample = targetSample
    let bestDistance = Number.POSITIVE_INFINITY

    for (let i = minSample; i <= maxSample; i += 1) {
      const previous = channelData[i - 1]
      const current = channelData[i]
      if (previous === undefined || current === undefined) {
        continue
      }
      const crossesZero = (previous <= 0 && current >= 0) || (previous >= 0 && current <= 0)
      if (!crossesZero) {
        continue
      }
      const distance = Math.abs(i - targetSample)
      if (distance < bestDistance) {
        bestDistance = distance
        bestSample = i
      }
    }

    return bestSample
  }

  function detectLeadingAndTrailingSilence(
    buffer: AudioBuffer,
    threshold = 0.0008,
  ): { startSample: number; endSample: number } {
    const channelCount = buffer.numberOfChannels
    const length = buffer.length
    if (channelCount < 1 || length < 2) {
      return { startSample: 0, endSample: length }
    }

    let startSample = 0
    let endSample = length
    const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index))

    for (let sample = 0; sample < length; sample += 1) {
      let maxAbs = 0
      for (const channel of channels) {
        const value = Math.abs(channel[sample] ?? 0)
        if (value > maxAbs) {
          maxAbs = value
        }
      }
      if (maxAbs >= threshold) {
        startSample = sample
        break
      }
    }

    for (let sample = length - 1; sample >= 0; sample -= 1) {
      let maxAbs = 0
      for (const channel of channels) {
        const value = Math.abs(channel[sample] ?? 0)
        if (value > maxAbs) {
          maxAbs = value
        }
      }
      if (maxAbs >= threshold) {
        endSample = sample + 1
        break
      }
    }

    if (endSample <= startSample) {
      return { startSample: 0, endSample: length }
    }

    return { startSample, endSample }
  }

  function syncTrackTiming(trackId: string, element: HTMLAudioElement): void {
    const track = activeTracks.value.find((item) => item.id === trackId)
    if (!track) {
      return
    }

    track.currentSeconds = Math.max(0, element.currentTime || 0)
    const duration = Number.isFinite(element.duration) ? element.duration : 0
    track.totalSeconds = Math.max(0, duration)
  }

  async function writeCollectionMeta(collection: CollectionEntry): Promise<void> {
    await writeTextFileJson(collection.dirHandle, COLLECTION_META_FILE, {
      title: collection.title,
      iconImage: collection.iconImage,
    } satisfies CollectionMeta)
  }

  async function writeAudioMeta(audio: AudioFileEntry): Promise<void> {
    await writeTextFileJson(audio.audioDirHandle, audio.metadataFileName, audio.metadata)
  }

  async function loadCollections(handle: FileSystemDirectoryHandle): Promise<void> {
    const collectionsDir = await ensureDirectory(handle, 'collections', true)
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
            fileHandle,
            audioDirHandle: currentDirHandle,
            metadataFileName,
            metadata,
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
        dirHandle,
        audioDirHandle,
        directoryPaths,
        audioFiles,
      })
    }

    nextCollections.sort((a, b) => a.name.localeCompare(b.name))
    collections.value = nextCollections

    if (!selectedCollectionName.value && nextCollections.length > 0) {
      selectedCollectionName.value = nextCollections[0]?.name ?? null
    } else if (
      selectedCollectionName.value &&
      !nextCollections.some((collection) => collection.name === selectedCollectionName.value)
    ) {
      selectedCollectionName.value = nextCollections[0]?.name ?? null
    }
  }

  async function loadFromDirectoryHandle(
    handle: FileSystemDirectoryHandle,
    options?: { restored?: boolean },
  ): Promise<boolean> {
    loading.value = true
    try {
      const granted = await hasFolderPermission(handle, true)
      if (!granted) {
        status.value = 'Folder permission was denied.'
        return false
      }

      rootHandle.value = handle
      await saveFolderHandle(handle)
      await loadCollections(handle)

      status.value = options?.restored
        ? `Reopened folder: ${handle.name}`
        : `Connected folder: ${handle.name}`
      return true
    } catch (error) {
      console.error(error)
      status.value = 'Unable to read folder. Verify permissions and folder structure.'
      return false
    } finally {
      loading.value = false
    }
  }

  async function connectFolder(): Promise<void> {
    if (!isFileSystemAccessSupported) {
      status.value = 'File System Access API is not supported in this browser.'
      return
    }

    const picker = window.showDirectoryPicker
    if (!picker) {
      status.value = 'Directory picker is not available.'
      return
    }

    try {
      const handle = await picker({ mode: 'readwrite' })
      await loadFromDirectoryHandle(handle)
    } catch {
      status.value = 'Folder selection cancelled.'
    }
  }

  async function tryRestoreLastFolder(): Promise<void> {
    if (!isFileSystemAccessSupported) {
      return
    }

    restoring.value = true
    try {
      const handle = await loadFolderHandle()
      if (!handle) {
        return
      }

      const granted = await hasFolderPermission(handle, true)
      if (!granted) {
        status.value = `Reconnect folder "${handle.name}" to restore access.`
        return
      }

      await loadFromDirectoryHandle(handle, { restored: true })
    } catch (error) {
      console.error(error)
      status.value = 'Could not restore previous folder. Connect it again.'
    } finally {
      restoring.value = false
    }
  }

  async function createCollection(name: string, iconFile?: File | null): Promise<void> {
    if (!rootHandle.value) {
      throw new Error('No root folder connected')
    }

    const trimmed = name.trim()
    if (!trimmed) {
      throw new Error('Collection name is required')
    }

    const collectionsDir = await ensureDirectory(rootHandle.value, 'collections', true)
    const dirHandle = await ensureDirectory(collectionsDir, trimmed, true)
    await ensureDirectory(dirHandle, 'audio_files', true)

    const newCollection: CollectionEntry = {
      name: trimmed,
      title: trimmed,
      iconImage: null,
      dirHandle,
      audioDirHandle: await ensureDirectory(dirHandle, 'audio_files', true),
      directoryPaths: [],
      audioFiles: [],
    }

    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `collection-icon${iconExt}`
      const iconHandle = await dirHandle.getFileHandle(iconName, { create: true })
      const writable = await iconHandle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      newCollection.iconImage = iconName
    }

    await writeCollectionMeta(newCollection)
    await loadCollections(rootHandle.value)
    selectedCollectionName.value = trimmed
  }

  async function importAudioFiles(
    collectionName: string,
    files: File[],
    targetDirectoryPath = '',
  ): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection || files.length === 0) {
      return
    }

    const targetAudioDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
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

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }
  }

  async function createCollectionSubDirectory(
    collectionName: string,
    parentDirectoryPath: string,
    directoryName: string,
  ): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    const trimmedDirectoryName = directoryName.trim()
    if (!collection || !trimmedDirectoryName) {
      return
    }

    const normalizedDirectoryName = normalizeRelativePath(trimmedDirectoryName)
    if (!normalizedDirectoryName) {
      return
    }

    const parentHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      parentDirectoryPath,
      true,
    )
    await resolveRelativeDirectoryHandle(parentHandle, normalizedDirectoryName, true)

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }
  }

  async function createCollectionSubDirectoryWithSelectedAudio(
    collectionName: string,
    parentDirectoryPath: string,
    directoryName: string,
    audioIds: string[],
  ): Promise<void> {
    const normalizedParentPath = normalizeRelativePath(parentDirectoryPath)
    const normalizedDirectoryName = normalizeRelativePath(directoryName.trim())
    if (!normalizedDirectoryName) {
      return
    }

    await createCollectionSubDirectory(collectionName, normalizedParentPath, normalizedDirectoryName)
    const targetDirectoryPath = joinRelativePath(normalizedParentPath, normalizedDirectoryName)
    await moveAudioFilesToDirectory(collectionName, audioIds, targetDirectoryPath)
  }

  async function renameCollectionSubDirectory(
    collectionName: string,
    directoryPath: string,
    newDirectoryName: string,
  ): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    if (!normalizedDirectoryPath) {
      return
    }

    const nextDirectoryName = normalizeRelativePath(newDirectoryName.trim())
    if (!nextDirectoryName || nextDirectoryName.includes('/')) {
      status.value = 'Directory name must be a single folder name.'
      return
    }

    const sourceSegments = normalizedDirectoryPath.split('/')
    const sourceLeafName = sourceSegments[sourceSegments.length - 1] ?? ''
    if (!sourceLeafName) {
      return
    }

    const parentDirectoryPath = sourceSegments.slice(0, -1).join('/')
    const normalizedTargetPath = joinRelativePath(parentDirectoryPath, nextDirectoryName)
    if (normalizedTargetPath === normalizedDirectoryPath) {
      return
    }

    const existingTargetHandle = await tryResolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedTargetPath,
    )
    if (existingTargetHandle) {
      status.value = `Directory "${nextDirectoryName}" already exists.`
      return
    }

    const sourceDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedDirectoryPath,
      false,
    )
    const parentDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      parentDirectoryPath,
      false,
    )
    const targetDirHandle = await parentDirHandle.getDirectoryHandle(nextDirectoryName, { create: true })

    await copyDirectoryContents(sourceDirHandle, targetDirHandle)
    await parentDirHandle.removeEntry(sourceLeafName, { recursive: true })

    const activeTrackIds = activeTracks.value
      .filter((track) => {
        const prefix = `${collectionName}/${normalizedDirectoryPath}/`
        return track.audioId.startsWith(prefix)
      })
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Renamed directory: /${normalizedDirectoryPath} -> /${normalizedTargetPath}`
  }

  async function moveCollectionSubDirectory(
    collectionName: string,
    directoryPath: string,
    targetParentDirectoryPath: string,
  ): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    const normalizedTargetParentPath = normalizeRelativePath(targetParentDirectoryPath)
    if (!normalizedDirectoryPath) {
      return
    }

    const sourceSegments = normalizedDirectoryPath.split('/')
    const sourceLeafName = sourceSegments[sourceSegments.length - 1] ?? ''
    if (!sourceLeafName) {
      return
    }

    const sourceParentPath = sourceSegments.slice(0, -1).join('/')
    const normalizedTargetPath = joinRelativePath(normalizedTargetParentPath, sourceLeafName)
    if (normalizedTargetPath === normalizedDirectoryPath) {
      return
    }

    if (
      normalizedTargetParentPath === normalizedDirectoryPath ||
      normalizedTargetParentPath.startsWith(`${normalizedDirectoryPath}/`)
    ) {
      status.value = 'Cannot move a folder into itself or one of its subfolders.'
      return
    }

    const existingTargetHandle = await tryResolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedTargetPath,
    )
    if (existingTargetHandle) {
      status.value = `Directory "${sourceLeafName}" already exists in /${normalizedTargetParentPath || ''}`
      return
    }

    const sourceDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedDirectoryPath,
      false,
    )
    const sourceParentDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      sourceParentPath,
      false,
    )
    const targetParentDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedTargetParentPath,
      false,
    )
    const targetDirHandle = await targetParentDirHandle.getDirectoryHandle(sourceLeafName, { create: true })

    await copyDirectoryContents(sourceDirHandle, targetDirHandle)
    await sourceParentDirHandle.removeEntry(sourceLeafName, { recursive: true })

    const sourcePrefix = `${collectionName}/${normalizedDirectoryPath}/`
    const activeTrackIds = activeTracks.value
      .filter((track) => track.audioId.startsWith(sourcePrefix))
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Moved directory: /${normalizedDirectoryPath} -> /${normalizedTargetPath}`
  }

  async function deleteCollectionSubDirectory(
    collectionName: string,
    directoryPath: string,
  ): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    const normalizedDirectoryPath = normalizeRelativePath(directoryPath)
    if (!normalizedDirectoryPath) {
      return
    }

    const directorySegments = normalizedDirectoryPath.split('/')
    const directoryName = directorySegments[directorySegments.length - 1] ?? ''
    if (!directoryName) {
      return
    }

    const parentDirectoryPath = directorySegments.slice(0, -1).join('/')
    const parentDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      parentDirectoryPath,
      false,
    )

    await parentDirHandle.removeEntry(directoryName, { recursive: true })

    const activeTrackIds = activeTracks.value
      .filter((track) => {
        const prefix = `${collectionName}/${normalizedDirectoryPath}/`
        return track.audioId.startsWith(prefix)
      })
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Deleted directory: /${normalizedDirectoryPath}`
  }

  async function setCollectionIcon(collectionName: string, iconFile: File | null): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `collection-icon${iconExt}`
      const handle = await collection.dirHandle.getFileHandle(iconName, { create: true })
      const writable = await handle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      collection.iconImage = iconName
    } else {
      collection.iconImage = null
    }

    await writeCollectionMeta(collection)
    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }
  }

  async function setCollectionTitle(collectionName: string, title: string): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    collection.title = getCollectionDisplayTitle(title, collection.name)
    await writeCollectionMeta(collection)

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }
  }

  async function deleteCollection(collectionName: string): Promise<void> {
    if (!rootHandle.value) {
      throw new Error('No root folder connected')
    }

    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    const activeTrackIds = activeTracks.value
      .filter((track) => track.audioId.startsWith(`${collectionName}/`))
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    const collectionsDir = await ensureDirectory(rootHandle.value, 'collections', true)
    await collectionsDir.removeEntry(collectionName, { recursive: true })
    await loadCollections(rootHandle.value)
    status.value = `Deleted collection: ${collection.title}`
  }

  function stopTrack(trackId: string): void {
    const track = activeTracks.value.find((item) => item.id === trackId)
    if (!track) {
      return
    }

    track.audioElement?.pause()
    track.cleanup()
    activeTracks.value = activeTracks.value.filter((item) => item.id !== trackId)
  }

  function stopAllTracks(): void {
    for (const track of [...activeTracks.value]) {
      stopTrack(track.id)
    }
  }

  function updateTrackVolume(trackId: string, volume: number): void {
    const track = activeTracks.value.find((item) => item.id === trackId)
    if (!track) {
      return
    }

    track.volume = clampVolume(volume)
    applyTrackOutputVolume(track)
  }

  function setGlobalVolume(volume: number): void {
    globalVolume.value = clampVolume(volume)
  }

  async function playAudio(audio: AudioFileEntry): Promise<void> {
    const activeTrackIdsForAudio = activeTracks.value
      .filter((track) => track.audioId === audio.id)
      .map((track) => track.id)

    if (activeTrackIdsForAudio.length > 0) {
      if (audio.metadata.infiniteLoop) {
        for (const trackId of activeTrackIdsForAudio) {
          stopTrack(trackId)
        }
      }
      return
    }

    const file = await audio.fileHandle.getFile()
    const trackId = createTrackId(audio.id)
    const start = audio.metadata.trimStart ?? 0
    const boundedStart = Math.max(0, start)
    const trackVolume = clampVolume(audio.metadata.volume ?? 100)
    const end = audio.metadata.trimEnd

    if (audio.metadata.infiniteLoop) {
      const context = getWebAudioContext()
      if (context) {
        try {
          if (context.state === 'suspended') {
            await context.resume()
          }

          const buffer = await context.decodeAudioData(await file.arrayBuffer())
          const sampleRate = buffer.sampleRate
          const firstChannel = buffer.getChannelData(0)
          const autoBounds =
            audio.metadata.trimStart === null && audio.metadata.trimEnd === null
              ? detectLeadingAndTrailingSilence(buffer)
              : null
          const requestedStart = autoBounds
            ? autoBounds.startSample / sampleRate
            : boundedStart
          const requestedEnd =
            end === null || end === undefined
              ? (autoBounds ? autoBounds.endSample / sampleRate : buffer.duration)
              : end

          const rawLoopStart = Math.min(requestedStart, buffer.duration || requestedStart)
          const rawLoopEndCandidate = Math.min(Math.max(requestedEnd, rawLoopStart), buffer.duration)
          const rawLoopEnd = rawLoopEndCandidate > rawLoopStart ? rawLoopEndCandidate : buffer.duration

          const zeroSearchRadiusSamples = Math.max(32, Math.round(sampleRate * 0.012))
          const snappedStartSample = findNearestZeroCrossing(
            firstChannel,
            Math.max(1, Math.round(rawLoopStart * sampleRate)),
            zeroSearchRadiusSamples,
          )
          const snappedEndSample = findNearestZeroCrossing(
            firstChannel,
            Math.max(1, Math.round(rawLoopEnd * sampleRate)),
            zeroSearchRadiusSamples,
          )
          const loopStart = Math.max(0, snappedStartSample / sampleRate)
          const loopEnd = Math.min(buffer.duration, snappedEndSample / sampleRate)

          if (!(loopEnd > loopStart)) {
            status.value = `Could not loop ${getAudioDisplayTitle(audio)} due to invalid trim range.`
            return
          }

          const gainNode = context.createGain()
          gainNode.connect(context.destination)
          const loopDuration = loopEnd - loopStart
          const crossfadeSeconds = Math.min(0.04, Math.max(0.006, loopDuration * 0.2))
          const firstBoundaryTime = context.currentTime + 0.08
          let nextBoundaryTime = firstBoundaryTime
          const scheduledSources = new Set<AudioBufferSourceNode>()

          const scheduleLoopIteration = (boundaryTime: number) => {
            const sourceNode = context.createBufferSource()
            const iterationGainNode = context.createGain()
            sourceNode.buffer = buffer
            sourceNode.loop = true
            sourceNode.loopStart = loopStart
            sourceNode.loopEnd = loopEnd
            sourceNode.connect(iterationGainNode)
            iterationGainNode.connect(gainNode)

            const startTime = boundaryTime - crossfadeSeconds
            const fadeOutStart = boundaryTime + loopDuration - crossfadeSeconds
            const stopTime = boundaryTime + loopDuration
            iterationGainNode.gain.setValueAtTime(0, startTime)
            iterationGainNode.gain.linearRampToValueAtTime(1, boundaryTime)
            iterationGainNode.gain.setValueAtTime(1, fadeOutStart)
            iterationGainNode.gain.linearRampToValueAtTime(0, stopTime)
            sourceNode.start(startTime, loopStart)
            sourceNode.stop(stopTime + 0.005)

            scheduledSources.add(sourceNode)
            sourceNode.onended = () => {
              scheduledSources.delete(sourceNode)
              sourceNode.disconnect()
              iterationGainNode.disconnect()
            }
          }

          const scheduleAheadSeconds = 0.7
          while (nextBoundaryTime < context.currentTime + scheduleAheadSeconds) {
            scheduleLoopIteration(nextBoundaryTime)
            nextBoundaryTime += loopDuration
          }

          const timingIntervalId = window.setInterval(() => {
            while (nextBoundaryTime < context.currentTime + scheduleAheadSeconds) {
              scheduleLoopIteration(nextBoundaryTime)
              nextBoundaryTime += loopDuration
            }

            const track = activeTracks.value.find((item) => item.id === trackId)
            if (!track) {
              return
            }
            const elapsedSinceFirstBoundary = context.currentTime - firstBoundaryTime
            const wrappedElapsed =
              ((elapsedSinceFirstBoundary % loopDuration) + loopDuration) % loopDuration
            track.currentSeconds = loopStart + wrappedElapsed
            track.totalSeconds = loopEnd
          }, 60)

          const cleanup = () => {
            window.clearInterval(timingIntervalId)
            for (const sourceNode of scheduledSources) {
              try {
                sourceNode.stop()
              } catch {
                // no-op; source may already be stopped
              }
              sourceNode.disconnect()
            }
            scheduledSources.clear()
            gainNode.disconnect()
          }

          activeTracks.value.push({
            id: trackId,
            audioId: audio.id,
            title: `${
              collections.value.find((collection) => collection.name === audio.collectionName)?.title ??
              audio.collectionName
            } / ${getAudioDisplayTitle(audio)}`,
            category: audio.metadata.category,
            volume: trackVolume,
            currentSeconds: loopStart,
            totalSeconds: loopEnd,
            audioElement: null,
            sourceUrl: null,
            outputGainNode: gainNode,
            timingIntervalId,
            startedAt: Date.now(),
            cleanup,
          })

          return
        } catch {
          // Fall back to HTMLAudioElement playback if Web Audio decode/play fails.
        }
      }
    }

    const sourceUrl = URL.createObjectURL(file)
    const element = new Audio(sourceUrl)

    const onLoadedMetadata = () => {
      element.currentTime = Math.min(boundedStart, element.duration || boundedStart)
      if (audio.metadata.infiniteLoop && (end === null || end === undefined)) {
        element.loop = true
      }
      syncTrackTiming(trackId, element)
      void element.play()
    }

    const onTimeUpdate = () => {
      syncTrackTiming(trackId, element)
      if (end === null || end === undefined) {
        return
      }
      if (element.currentTime < end) {
        return
      }

      if (audio.metadata.infiniteLoop) {
        element.currentTime = boundedStart
        void element.play()
      } else {
        stopTrack(trackId)
      }
    }

    const onEnded = () => {
      if (audio.metadata.infiniteLoop && (end === null || end === undefined)) {
        element.currentTime = boundedStart
        void element.play()
        return
      }
      stopTrack(trackId)
    }

    element.addEventListener('loadedmetadata', onLoadedMetadata)
    element.addEventListener('timeupdate', onTimeUpdate)
    element.addEventListener('ended', onEnded)

    const cleanup = () => {
      element.removeEventListener('loadedmetadata', onLoadedMetadata)
      element.removeEventListener('timeupdate', onTimeUpdate)
      element.removeEventListener('ended', onEnded)
      URL.revokeObjectURL(sourceUrl)
    }

    activeTracks.value.push({
      id: trackId,
      audioId: audio.id,
      title: `${
        collections.value.find((collection) => collection.name === audio.collectionName)?.title ??
        audio.collectionName
      } / ${getAudioDisplayTitle(audio)}`,
      category: audio.metadata.category,
      volume: trackVolume,
      currentSeconds: boundedStart,
      totalSeconds: 0,
      audioElement: element,
      sourceUrl,
      outputGainNode: null,
      timingIntervalId: null,
      startedAt: Date.now(),
      cleanup,
    })

    const createdTrack = activeTracks.value.find((track) => track.id === trackId)
    if (createdTrack) {
      applyTrackOutputVolume(createdTrack)
    }
  }

  async function updateAudioMeta(
    audioId: string,
    patch: Partial<AudioMeta>,
  ): Promise<void> {
    const audio = allAudioFiles.value.find((entry) => entry.id === audioId)
    if (!audio) {
      return
    }

    audio.metadata = sanitizeAudioMeta({ ...audio.metadata, ...patch })

    if (
      audio.metadata.trimStart !== null &&
      audio.metadata.trimEnd !== null &&
      audio.metadata.trimStart > audio.metadata.trimEnd
    ) {
      audio.metadata.trimEnd = audio.metadata.trimStart
    }

    await writeAudioMeta(audio)
  }

  async function setAudioIcon(audioId: string, iconFile: File | null): Promise<void> {
    const audio = allAudioFiles.value.find((entry) => entry.id === audioId)
    if (!audio) {
      return
    }

    if (iconFile) {
      const iconExt = extname(iconFile.name) || '.png'
      const iconName = `${audio.name}.icon${iconExt}`
      const iconHandle = await audio.audioDirHandle.getFileHandle(iconName, { create: true })
      const writable = await iconHandle.createWritable()
      await writable.write(await iconFile.arrayBuffer())
      await writable.close()
      audio.metadata.iconImage = iconName
    } else {
      audio.metadata.iconImage = null
    }

    await writeAudioMeta(audio)
  }

  async function deleteAudioFile(audioId: string): Promise<void> {
    const audio = allAudioFiles.value.find((entry) => entry.id === audioId)
    if (!audio) {
      return
    }

    const activeTrackIds = activeTracks.value
      .filter((track) => track.audioId === audioId)
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    try {
      await audio.audioDirHandle.removeEntry(audio.name)
    } catch {
      // no-op; file may have been removed already
    }

    try {
      await audio.audioDirHandle.removeEntry(audio.metadataFileName)
    } catch {
      // no-op; metadata file may not exist
    }

    if (audio.metadata.iconImage) {
      try {
        await audio.audioDirHandle.removeEntry(audio.metadata.iconImage)
      } catch {
        // no-op; icon file may not exist
      }
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Deleted audio file: ${getAudioDisplayTitle(audio)}`
  }

  async function moveAudioFileEntry(
    audio: AudioFileEntry,
    targetAudioDirHandle: FileSystemDirectoryHandle,
  ): Promise<string> {
    const activeTrackIds = activeTracks.value
      .filter((track) => track.audioId === audio.id)
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    const sourceAudioFile = await audio.fileHandle.getFile()
    const targetAudioName = await uniqueFileName(targetAudioDirHandle, audio.name)
    await writeBinaryFile(
      targetAudioDirHandle,
      targetAudioName,
      await sourceAudioFile.arrayBuffer(),
    )

    const nextMeta = { ...audio.metadata }
    if (audio.metadata.iconImage) {
      try {
        const sourceIconHandle = await audio.audioDirHandle.getFileHandle(audio.metadata.iconImage)
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
      await audio.audioDirHandle.removeEntry(audio.name)
    } catch {
      // no-op; file may have been removed already
    }
    try {
      await audio.audioDirHandle.removeEntry(audio.metadataFileName)
    } catch {
      // no-op; metadata file may have been removed already
    }
    if (audio.metadata.iconImage) {
      try {
        await audio.audioDirHandle.removeEntry(audio.metadata.iconImage)
      } catch {
        // no-op; icon file may have been removed already
      }
    }

    return getAudioDisplayTitle(audio)
  }

  async function moveAudioFilesToDirectory(
    collectionName: string,
    audioIds: string[],
    targetDirectoryPath: string,
  ): Promise<void> {
    const collection = collections.value.find((entry) => entry.name === collectionName)
    if (!collection || audioIds.length === 0) {
      return
    }

    const normalizedTargetPath = normalizeRelativePath(targetDirectoryPath)
    const targetAudioDirHandle = await resolveRelativeDirectoryHandle(
      collection.audioDirHandle,
      normalizedTargetPath,
      true,
    )

    const uniqueAudioIds = [...new Set(audioIds)]
    const movableAudio = uniqueAudioIds
      .map((audioId) => allAudioFiles.value.find((entry) => entry.id === audioId))
      .filter((audio): audio is AudioFileEntry => {
        if (!audio) {
          return false
        }
        if (audio.collectionName !== collectionName) {
          return false
        }
        return normalizeRelativePath(audio.relativePath) !== normalizedTargetPath
      })

    if (movableAudio.length === 0) {
      return
    }

    const movedTitles: string[] = []
    for (const audio of movableAudio) {
      movedTitles.push(await moveAudioFileEntry(audio, targetAudioDirHandle))
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    const targetLabel = normalizedTargetPath ? `/${normalizedTargetPath}` : '/'
    if (movedTitles.length === 1) {
      status.value = `Moved audio file: ${movedTitles[0]} -> ${targetLabel}`
      return
    }
    status.value = `Moved ${movedTitles.length} audio files -> ${targetLabel}`
  }

  async function moveAudioToDirectory(
    collectionName: string,
    audioId: string,
    targetDirectoryPath: string,
  ): Promise<void> {
    await moveAudioFilesToDirectory(collectionName, [audioId], targetDirectoryPath)
  }

  async function moveAudioFilesToCollection(audioIds: string[], targetCollectionName: string): Promise<void> {
    const targetCollection = collections.value.find((entry) => entry.name === targetCollectionName)
    if (!targetCollection || audioIds.length === 0) {
      return
    }

    const uniqueAudioIds = [...new Set(audioIds)]
    const movableAudio = uniqueAudioIds
      .map((audioId) => allAudioFiles.value.find((entry) => entry.id === audioId))
      .filter((audio): audio is AudioFileEntry => {
        if (!audio) {
          return false
        }
        return audio.collectionName !== targetCollectionName
      })

    if (movableAudio.length === 0) {
      return
    }

    const movedTitles: string[] = []
    for (const audio of movableAudio) {
      movedTitles.push(await moveAudioFileEntry(audio, targetCollection.audioDirHandle))
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    if (movedTitles.length === 1) {
      status.value = `Moved audio file: ${movedTitles[0]} -> ${targetCollection.title}`
      return
    }
    status.value = `Moved ${movedTitles.length} audio files -> ${targetCollection.title}`
  }

  async function moveAudioToCollection(audioId: string, targetCollectionName: string): Promise<void> {
    await moveAudioFilesToCollection([audioId], targetCollectionName)
  }

  async function resolveCollectionIconUrl(collection: CollectionEntry): Promise<string | null> {
    if (!collection.iconImage) {
      return null
    }
    try {
      const handle = await collection.dirHandle.getFileHandle(collection.iconImage)
      const file = await handle.getFile()
      return URL.createObjectURL(file)
    } catch {
      return null
    }
  }

  async function resolveAudioIconUrl(audio: AudioFileEntry): Promise<string | null> {
    const iconName = audio.metadata.iconImage
    if (!iconName) {
      return null
    }
    try {
      const handle = await audio.audioDirHandle.getFileHandle(iconName)
      const file = await handle.getFile()
      return URL.createObjectURL(file)
    } catch {
      return null
    }
  }

  onBeforeUnmount(() => {
    stopAllTracks()
    if (webAudioContext) {
      void webAudioContext.close()
      webAudioContext = null
    }
  })

  watch(globalVolume, () => {
    for (const track of activeTracks.value) {
      applyTrackOutputVolume(track)
    }
  })

  return {
    rootHandle,
    collections,
    selectedCollectionName,
    selectedCollection,
    allAudioFiles,
    activeTracks,
    globalVolume,
    status,
    loading,
    restoring,
    isFileSystemAccessSupported,
    connectFolder,
    tryRestoreLastFolder,
    createCollection,
    importAudioFiles,
    createCollectionSubDirectory,
    createCollectionSubDirectoryWithSelectedAudio,
    renameCollectionSubDirectory,
    moveCollectionSubDirectory,
    deleteCollectionSubDirectory,
    setCollectionIcon,
    setCollectionTitle,
    deleteCollection,
    playAudio,
    stopTrack,
    stopAllTracks,
    updateTrackVolume,
    setGlobalVolume,
    updateAudioMeta,
    setAudioIcon,
    deleteAudioFile,
    moveAudioFilesToDirectory,
    moveAudioToDirectory,
    moveAudioFilesToCollection,
    moveAudioToCollection,
    resolveCollectionIconUrl,
    resolveAudioIconUrl,
  }
}
