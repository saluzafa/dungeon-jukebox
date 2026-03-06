import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ActiveTrack, AudioFileEntry, AudioMeta, CollectionEntry } from '@/types/soundboard'
import { createFileSystemStorageAdapter } from '@/storage/fileSystemStorageAdapter'
import type { StorageAdapter, StorageRoot } from '@/storage/storageAdapter'

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

function getAudioDisplayTitle(audio: AudioFileEntry): string {
  return audio.metadata.title?.trim() || audio.name
}

function filenameToFallbackTitle(name: string): string {
  const withoutExtension = name.replace(/\.[^./\\]+$/, '')
  const normalized = withoutExtension
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized || name
}

function sanitizeGeneratedTitle(raw: string, fallback: string): string {
  const strippedQuotes = raw.replace(/^["']+|["']+$/g, '')
  const normalized = strippedQuotes.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return fallback
  }
  return normalized.slice(0, 120)
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

function parseGeneratedTitlesByAudioId(content: string): Map<string, string> {
  const tryParse = (raw: string): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  let parsed = tryParse(content)
  if (!parsed) {
    const firstBrace = content.indexOf('{')
    const lastBrace = content.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      parsed = tryParse(content.slice(firstBrace, lastBrace + 1))
    }
  }

  const entries = (() => {
    if (Array.isArray(parsed)) {
      return parsed
    }
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { titles?: unknown }).titles)) {
      return (parsed as { titles: unknown[] }).titles
    }
    return []
  })()

  const byId = new Map<string, string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const id = (entry as { id?: unknown }).id
    const title = (entry as { title?: unknown }).title
    if (typeof id !== 'string' || typeof title !== 'string') {
      continue
    }
    byId.set(id, title)
  }

  return byId
}

function createTrackId(audioId: string): string {
  return `${audioId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useSoundboard(
  options?: {
    storageAdapter?: StorageAdapter
  },
) {
  const storageAdapter = options?.storageAdapter ?? createFileSystemStorageAdapter()
  let webAudioContext: AudioContext | null = null
  const superTrackSkippers = new Map<string, () => void>()
  const rootHandle = ref<StorageRoot | null>(null)
  const collections = ref<CollectionEntry[]>([])
  const selectedCollectionName = ref<string | null>(null)
  const activeTracks = ref<ActiveTrack[]>([])
  const globalVolume = ref(100)
  const loading = ref(false)
  const restoring = ref(false)
  const autoTitling = ref(false)
  const status = ref<string>('Connect a local folder to start.')

  const isFileSystemAccessSupported = storageAdapter.isSupported()

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

  function getTrackDisplayTitle(audio: AudioFileEntry): string {
    return `${
      collections.value.find((collection) => collection.name === audio.collectionName)?.title ??
      audio.collectionName
    } / ${getAudioDisplayTitle(audio)}`
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

  async function loadCollections(root: StorageRoot): Promise<void> {
    const nextCollections = await storageAdapter.loadCollections(root)
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

  async function loadFromRoot(
    root: StorageRoot,
    options?: { restored?: boolean },
  ): Promise<boolean> {
    loading.value = true
    try {
      const granted = await storageAdapter.ensureRootPermission(root, true)
      if (!granted) {
        status.value = 'Folder permission was denied.'
        return false
      }

      rootHandle.value = root
      await loadCollections(root)

      status.value = options?.restored
        ? `Reopened folder: ${root.name}`
        : `Connected folder: ${root.name}`
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

    try {
      const root = await storageAdapter.connectRoot()
      if (!root) {
        status.value = 'Directory picker is not available.'
        return
      }
      await loadFromRoot(root)
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
      const root = await storageAdapter.restoreRoot()
      if (!root) {
        return
      }

      const granted = await storageAdapter.ensureRootPermission(root, true)
      if (!granted) {
        status.value = `Reconnect folder "${root.name}" to restore access.`
        return
      }

      await loadFromRoot(root, { restored: true })
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

    await storageAdapter.createCollection(rootHandle.value, trimmed, iconFile)
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

    await storageAdapter.importAudioFiles(collection, files, targetDirectoryPath)

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

    await storageAdapter.createCollectionSubDirectory(collection, parentDirectoryPath, normalizedDirectoryName)

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

    try {
      const result = await storageAdapter.renameCollectionSubDirectory(
        collection,
        normalizedDirectoryPath,
        newDirectoryName,
      )
      if (!result) {
        return
      }

      const activeTrackIds = activeTracks.value
        .filter((track) => {
          const prefix = `${collectionName}/${result.fromPath}/`
          return track.audioId.startsWith(prefix)
        })
        .map((track) => track.id)
      for (const trackId of activeTrackIds) {
        stopTrack(trackId)
      }

      if (rootHandle.value) {
        await loadCollections(rootHandle.value)
      }

      status.value = `Renamed directory: /${result.fromPath} -> /${result.toPath}`
    } catch (error) {
      status.value = error instanceof Error ? error.message : 'Unable to rename directory.'
    }
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

    try {
      const result = await storageAdapter.moveCollectionSubDirectory(
        collection,
        normalizedDirectoryPath,
        normalizedTargetParentPath,
      )
      if (!result) {
        return
      }

      const sourcePrefix = `${collectionName}/${result.fromPath}/`
      const activeTrackIds = activeTracks.value
        .filter((track) => track.audioId.startsWith(sourcePrefix))
        .map((track) => track.id)
      for (const trackId of activeTrackIds) {
        stopTrack(trackId)
      }

      if (rootHandle.value) {
        await loadCollections(rootHandle.value)
      }

      status.value = `Moved directory: /${result.fromPath} -> /${result.toPath}`
    } catch (error) {
      status.value = error instanceof Error ? error.message : 'Unable to move directory.'
    }
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

    const deletedPath = await storageAdapter.deleteCollectionSubDirectory(collection, normalizedDirectoryPath)
    if (!deletedPath) {
      return
    }

    const activeTrackIds = activeTracks.value
      .filter((track) => {
        const prefix = `${collectionName}/${deletedPath}/`
        return track.audioId.startsWith(prefix)
      })
      .map((track) => track.id)
    for (const trackId of activeTrackIds) {
      stopTrack(trackId)
    }

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Deleted directory: /${deletedPath}`
  }

  async function setCollectionIcon(collectionName: string, iconFile: File | null): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    await storageAdapter.setCollectionIcon(collection, iconFile)
    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }
  }

  async function setCollectionTitle(collectionName: string, title: string): Promise<void> {
    const collection = collections.value.find((item) => item.name === collectionName)
    if (!collection) {
      return
    }

    await storageAdapter.setCollectionTitle(collection, title)

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

    await storageAdapter.deleteCollection(rootHandle.value, collectionName)
    await loadCollections(rootHandle.value)
    status.value = `Deleted collection: ${collection.title}`
  }

  function stopTrack(trackId: string): void {
    const track = activeTracks.value.find((item) => item.id === trackId)
    if (!track) {
      return
    }

    superTrackSkippers.delete(trackId)
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

  function skipSuperTrack(trackId: string): void {
    const skip = superTrackSkippers.get(trackId)
    if (!skip) {
      return
    }
    skip()
  }

  async function playAudio(audio: AudioFileEntry): Promise<void> {
    const activeTrackIdsForAudio = activeTracks.value
      .filter((track) => track.audioId === audio.id)
      .map((track) => track.id)

    if (activeTrackIdsForAudio.length > 0) {
      for (const trackId of activeTrackIdsForAudio) {
        stopTrack(trackId)
      }
      return
    }

    const file = await storageAdapter.getAudioFile(audio)
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
            title: getTrackDisplayTitle(audio),
            category: audio.metadata.category,
            isSuperTrack: false,
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
      title: getTrackDisplayTitle(audio),
      category: audio.metadata.category,
      isSuperTrack: false,
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

  async function playSuperAudio(audioIds: string[]): Promise<void> {
    const uniqueAudioIds = [...new Set(audioIds)]
    const queuedAudio = uniqueAudioIds
      .map((audioId) => allAudioFiles.value.find((entry) => entry.id === audioId))
      .filter((audio): audio is AudioFileEntry => Boolean(audio))

    if (queuedAudio.length === 0) {
      return
    }

    if (queuedAudio.length === 1) {
      const onlyAudio = queuedAudio[0]
      if (onlyAudio) {
        await playAudio(onlyAudio)
      }
      return
    }

    const firstAudio = queuedAudio[0]
    if (!firstAudio) {
      return
    }

    const trackId = createTrackId(`super-track-${firstAudio.id}`)
    const trackVolume = clampVolume(100)
    const trackTitle = `Super Audio Track (${queuedAudio.length} tracks)`
    let queueIndex = 0
    let currentElement: HTMLAudioElement | null = null
    let currentSourceUrl: string | null = null
    let disposed = false
    let transitionToken = 0

    const applySuperTrackState = (
      currentAudio: AudioFileEntry | null,
      currentSeconds: number,
      totalSeconds: number,
    ): void => {
      const track = activeTracks.value.find((item) => item.id === trackId)
      if (!track) {
        return
      }

      track.audioId = currentAudio?.id ?? track.audioId
      track.currentSeconds = Math.max(0, currentSeconds)
      track.totalSeconds = Math.max(0, totalSeconds)
      track.superTrackPosition = Math.min(queueIndex + 1, queuedAudio.length)
      track.superTrackTotal = queuedAudio.length
      track.superTrackCurrentTitle = currentAudio ? getTrackDisplayTitle(currentAudio) : null
      track.audioElement = currentElement
      applyTrackOutputVolume(track)
    }

    const cleanupCurrentElement = (): void => {
      if (currentElement) {
        currentElement.onloadedmetadata = null
        currentElement.ontimeupdate = null
        currentElement.onended = null
        currentElement.onerror = null
        currentElement.pause()
      }
      currentElement = null
      if (currentSourceUrl) {
        URL.revokeObjectURL(currentSourceUrl)
      }
      currentSourceUrl = null
    }

    const cleanup = (): void => {
      disposed = true
      superTrackSkippers.delete(trackId)
      cleanupCurrentElement()
    }

    const playNextQueueItem = async (nextIndex: number): Promise<void> => {
      if (disposed) {
        return
      }

      if (nextIndex >= queuedAudio.length) {
        stopTrack(trackId)
        return
      }

      queueIndex = nextIndex
      transitionToken += 1
      const currentToken = transitionToken
      const nextAudio = queuedAudio[queueIndex]
      if (!nextAudio) {
        stopTrack(trackId)
        return
      }

      cleanupCurrentElement()

      try {
        const file = await storageAdapter.getAudioFile(nextAudio)
        if (disposed || currentToken !== transitionToken) {
          return
        }

        const sourceUrl = URL.createObjectURL(file)
        const element = new Audio(sourceUrl)
        currentElement = element
        currentSourceUrl = sourceUrl

        const start = Math.max(0, nextAudio.metadata.trimStart ?? 0)
        const end = nextAudio.metadata.trimEnd

        element.onloadedmetadata = () => {
          if (disposed || currentToken !== transitionToken) {
            return
          }
          element.currentTime = Math.min(start, element.duration || start)
          applySuperTrackState(nextAudio, element.currentTime, Number.isFinite(element.duration) ? element.duration : 0)
          void element.play()
        }

        element.ontimeupdate = () => {
          if (disposed || currentToken !== transitionToken) {
            return
          }
          applySuperTrackState(nextAudio, element.currentTime, Number.isFinite(element.duration) ? element.duration : 0)
          if (end === null || end === undefined || element.currentTime < end) {
            return
          }
          void playNextQueueItem(queueIndex + 1)
        }

        element.onended = () => {
          if (disposed || currentToken !== transitionToken) {
            return
          }
          void playNextQueueItem(queueIndex + 1)
        }

        element.onerror = () => {
          if (disposed || currentToken !== transitionToken) {
            return
          }
          status.value = `Could not play ${getAudioDisplayTitle(nextAudio)} in Super Audio Track. Skipped.`
          void playNextQueueItem(queueIndex + 1)
        }

        applySuperTrackState(nextAudio, start, 0)
      } catch {
        status.value = `Could not load ${getAudioDisplayTitle(nextAudio)} in Super Audio Track. Skipped.`
        void playNextQueueItem(queueIndex + 1)
      }
    }

    superTrackSkippers.set(trackId, () => {
      if (disposed) {
        return
      }
      void playNextQueueItem(queueIndex + 1)
    })

    activeTracks.value.push({
      id: trackId,
      audioId: firstAudio.id,
      title: trackTitle,
      category: 'music',
      isSuperTrack: true,
      superTrackPosition: 1,
      superTrackTotal: queuedAudio.length,
      superTrackCurrentTitle: getTrackDisplayTitle(firstAudio),
      volume: trackVolume,
      currentSeconds: 0,
      totalSeconds: 0,
      audioElement: null,
      sourceUrl: null,
      outputGainNode: null,
      timingIntervalId: null,
      startedAt: Date.now(),
      cleanup,
    })

    const createdTrack = activeTracks.value.find((track) => track.id === trackId)
    if (createdTrack) {
      applyTrackOutputVolume(createdTrack)
    }

    await playNextQueueItem(0)
  }

  async function updateAudioMeta(
    audioId: string,
    patch: Partial<AudioMeta>,
  ): Promise<void> {
    const audio = allAudioFiles.value.find((entry) => entry.id === audioId)
    if (!audio) {
      return
    }

    audio.metadata = await storageAdapter.updateAudioMeta(audio, patch)
  }

  async function updateAudioMetaBatch(
    audioIds: string[],
    patch: Partial<AudioMeta>,
  ): Promise<void> {
    if (audioIds.length === 0) {
      return
    }

    const uniqueIds = [...new Set(audioIds)]
    const targetAudio = uniqueIds
      .map((audioId) => allAudioFiles.value.find((entry) => entry.id === audioId))
      .filter((audio): audio is AudioFileEntry => Boolean(audio))

    if (targetAudio.length === 0) {
      return
    }

    for (const audio of targetAudio) {
      audio.metadata = await storageAdapter.updateAudioMeta(audio, patch)
    }

    if (patch.category) {
      status.value = `Updated category for ${targetAudio.length} audio file${targetAudio.length === 1 ? '' : 's'}.`
    }
  }

  async function setAudioIcon(audioId: string, iconFile: File | null): Promise<void> {
    const audio = allAudioFiles.value.find((entry) => entry.id === audioId)
    if (!audio) {
      return
    }

    audio.metadata = await storageAdapter.setAudioIcon(audio, iconFile)
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

    await storageAdapter.deleteAudioFile(audio)

    if (rootHandle.value) {
      await loadCollections(rootHandle.value)
    }

    status.value = `Deleted audio file: ${getAudioDisplayTitle(audio)}`
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

    for (const audio of movableAudio) {
      const activeTrackIds = activeTracks.value
        .filter((track) => track.audioId === audio.id)
        .map((track) => track.id)
      for (const trackId of activeTrackIds) {
        stopTrack(trackId)
      }
    }
    const movedTitles = await storageAdapter.moveAudioFilesToDirectory(
      collection,
      movableAudio,
      normalizedTargetPath,
    )

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

    for (const audio of movableAudio) {
      const activeTrackIds = activeTracks.value
        .filter((track) => track.audioId === audio.id)
        .map((track) => track.id)
      for (const trackId of activeTrackIds) {
        stopTrack(trackId)
      }
    }
    const movedTitles = await storageAdapter.moveAudioFilesToCollection(targetCollection, movableAudio)

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

  async function autoAssignTitlesWithOpenRouter(
    audioIds: string[],
    apiKey: string,
    currentDirectoryPath = '',
  ): Promise<void> {
    const trimmedApiKey = apiKey.trim()
    if (!trimmedApiKey) {
      status.value = 'OpenRouter API key is required to auto assign titles.'
      return
    }

    const targetAudio = [...new Set(audioIds)]
      .map((audioId) => allAudioFiles.value.find((entry) => entry.id === audioId))
      .filter((audio): audio is AudioFileEntry => Boolean(audio))

    if (targetAudio.length === 0) {
      status.value = 'No displayed audio files available for title generation.'
      return
    }

    autoTitling.value = true
    status.value = `Generating titles for ${targetAudio.length} displayed audio files...`

    try {
      const promptItems = targetAudio.map((audio) => ({
        id: audio.id,
        filename: audio.name,
        relativePath: audio.relativePath,
        existingTitle: audio.metadata.title,
      }))

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${trimmedApiKey}`,
          'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
          'X-Title': 'Dungeon Jukebox',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4.1-mini',
          temperature: 0.2,
          max_tokens: 800,
          messages: [
            {
              role: 'system',
              content:
                'You generate concise audio track titles from filenames. Return JSON only.',
            },
            {
              role: 'user',
              content: [
                'Generate a short human-friendly title for each filename.',
                'Requirements:',
                '- Keep original language when obvious.',
                '- Remove file extensions.',
                '- Keep titles concise (2-7 words).',
                '- Avoid reusing words already implied by the current directory path.',
                '- Output strict JSON object: {"titles":[{"id":"...","title":"..."}]}',
                '- Include every provided id exactly once.',
                '',
                `currentDirectoryPath: ${currentDirectoryPath || '/'}`,
                JSON.stringify(promptItems),
              ].join('\n'),
            },
          ],
        }),
      })

      if (!response.ok) {
        const errorBody = await response.text()
        const details = errorBody.trim()
        throw new Error(
          `OpenRouter request failed (${response.status}${details ? `: ${details.slice(0, 180)}` : ''})`,
        )
      }

      const completion = await response.json()
      const assistantText = extractAssistantText(
        (completion as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content,
      )
      const generatedById = parseGeneratedTitlesByAudioId(assistantText)

      let updatedCount = 0
      for (const audio of targetAudio) {
        const fallbackTitle = filenameToFallbackTitle(audio.name)
        const generatedTitle = generatedById.get(audio.id)
        const nextTitle = sanitizeGeneratedTitle(generatedTitle ?? fallbackTitle, fallbackTitle)
        if ((audio.metadata.title?.trim() ?? '') === nextTitle) {
          continue
        }
        audio.metadata = await storageAdapter.updateAudioMeta(audio, { title: nextTitle })
        updatedCount += 1
      }

      status.value = `Auto-assigned titles for ${updatedCount} of ${targetAudio.length} displayed files.`
    } catch (error) {
      console.error(error)
      status.value = error instanceof Error
        ? `Auto title generation failed: ${error.message}`
        : 'Auto title generation failed.'
    } finally {
      autoTitling.value = false
    }
  }

  async function resolveCollectionIconUrl(collection: CollectionEntry): Promise<string | null> {
    return storageAdapter.resolveCollectionIconUrl(collection)
  }

  async function resolveAudioIconUrl(audio: AudioFileEntry): Promise<string | null> {
    return storageAdapter.resolveAudioIconUrl(audio)
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
    autoTitling,
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
    playSuperAudio,
    stopTrack,
    skipSuperTrack,
    stopAllTracks,
    updateTrackVolume,
    setGlobalVolume,
    updateAudioMeta,
    updateAudioMetaBatch,
    setAudioIcon,
    deleteAudioFile,
    moveAudioFilesToDirectory,
    moveAudioToDirectory,
    moveAudioFilesToCollection,
    moveAudioToCollection,
    autoAssignTitlesWithOpenRouter,
    resolveCollectionIconUrl,
    resolveAudioIconUrl,
  }
}
