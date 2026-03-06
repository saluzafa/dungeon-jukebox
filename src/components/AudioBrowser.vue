<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ActiveTrack, AudioFileEntry, AudioMeta, CollectionEntry } from '@/types/soundboard'

interface DirectoryBrowserEntry {
  name: string
  relativePath: string
  isParentShortcut?: boolean
}

const props = defineProps<{
  selectedCollection: CollectionEntry | null
  allCollections: CollectionEntry[]
  audioIconUrls: Record<string, string>
  activeTracks: ActiveTrack[]
  currentDirectoryPath: string
  isAutoAssigningTitles: boolean
}>()

const emit = defineEmits<{
  playAudio: [audio: AudioFileEntry]
  playSuperAudio: [audioIds: string[]]
  autoAssignTitles: [audioIds: string[], apiKey: string, currentDirectoryPath: string]
  updateMeta: [audioId: string, patch: Partial<AudioMeta>]
  updateMetaBatch: [audioIds: string[], patch: Partial<AudioMeta>]
  setAudioIcon: [audioId: string, file: File | null]
  deleteAudio: [audioId: string]
  importFiles: [collectionName: string, files: File[], targetDirectoryPath: string]
  moveAudioToDirectory: [collectionName: string, audioIds: string[], targetDirectoryPath: string]
  createDirectory: [collectionName: string, parentDirectoryPath: string, directoryName: string]
  createDirectoryWithSelectedAudio: [
    collectionName: string,
    parentDirectoryPath: string,
    directoryName: string,
    audioIds: string[],
  ]
  renameDirectory: [collectionName: string, directoryPath: string, newDirectoryName: string]
  deleteDirectory: [collectionName: string, directoryPath: string]
  moveDirectory: [collectionName: string, directoryPath: string, targetParentDirectoryPath: string]
  updateCurrentDirectoryPath: [directoryPath: string]
}>()

const selectedAudioId = ref<string | null>(null)
const selectedAudioIds = ref<string[]>([])
const lastSelectedAudioId = ref<string | null>(null)
const searchQuery = ref('')
const audioSortMode = ref<'name' | 'title'>('name')
const OPENROUTER_API_KEY_STORAGE_KEY = 'dungeon-jukebox.openrouter-api-key'
const openRouterApiKey = ref('')
const isDropOver = ref(false)
const dragOverDirectoryPath = ref<string | null>(null)
const currentDirectoryPath = ref('')
const newDirectoryName = ref('')
const directoryContextMenu = ref<{
  x: number
  y: number
  directoryPath: string
  directoryName: string
} | null>(null)
const audioContextMenu = ref<{
  x: number
  y: number
  audioId: string
} | null>(null)
const audioFilesListContextMenu = ref<{
  x: number
  y: number
} | null>(null)

const allAudioFiles = computed(() => props.allCollections.flatMap((collection) => collection.audioFiles))
const isSearchActive = computed(() => searchQuery.value.trim().length > 0)
const filteredAudioFiles = computed(() => {
  if (!isSearchActive.value) {
    return props.selectedCollection?.audioFiles ?? []
  }

  const query = searchQuery.value.trim().toLowerCase()
  return allAudioFiles.value.filter((audio) => {
    const title = audioDisplayTitle(audio).toLowerCase()
    const collectionName = audio.collectionName.toLowerCase()
    return title.includes(query) || audio.name.toLowerCase().includes(query) || collectionName.includes(query)
  })
})

const sortedFilteredAudioFiles = computed(() => {
  return [...filteredAudioFiles.value].sort(compareAudioFiles)
})

const visibleDirectories = computed<DirectoryBrowserEntry[]>(() => {
  if (!props.selectedCollection || isSearchActive.value) {
    return []
  }

  const byPath = new Map<string, DirectoryBrowserEntry>()
  const normalizedCurrent = normalizePath(currentDirectoryPath.value)
  const prefix = normalizedCurrent ? `${normalizedCurrent}/` : ''

  for (const directoryPath of props.selectedCollection.directoryPaths) {
    const normalizedDir = normalizePath(directoryPath)
    if (!normalizedDir) {
      continue
    }

    let remainder = normalizedDir
    if (normalizedCurrent) {
      if (!normalizedDir.startsWith(prefix)) {
        continue
      }
      remainder = normalizedDir.slice(prefix.length)
      if (!remainder) {
        continue
      }
    }

    const childName = remainder.split('/')[0]
    if (!childName) {
      continue
    }

    const childPath = joinPath(normalizedCurrent, childName)
    if (!byPath.has(childPath)) {
      byPath.set(childPath, {
        name: childName,
        relativePath: childPath,
      })
    }
  }

  const directories = Array.from(byPath.values()).sort((a, b) => a.name.localeCompare(b.name))
  const parentPath = resolveParentDirectoryPath(currentDirectoryPath.value)
  if (parentPath !== null) {
    directories.unshift({
      name: '..',
      relativePath: parentPath,
      isParentShortcut: true,
    })
  }

  return directories
})

const visibleAudioFiles = computed<AudioFileEntry[]>(() => {
  if (!props.selectedCollection || isSearchActive.value) {
    return []
  }

  const normalizedCurrent = normalizePath(currentDirectoryPath.value)
  return props.selectedCollection.audioFiles
    .filter((audio) => normalizePath(audio.relativePath) === normalizedCurrent)
    .sort(compareAudioFiles)
})
const currentlyDisplayedAudioFiles = computed<AudioFileEntry[]>(() =>
  isSearchActive.value ? sortedFilteredAudioFiles.value : visibleAudioFiles.value,
)

const selectedAudio = computed(() => allAudioFiles.value.find((audio) => audio.id === selectedAudioId.value) ?? null)
const selectedAudioIdSet = computed(() => new Set(selectedAudioIds.value))
const selectedAudioFiles = computed(() => {
  const selectedIdSet = selectedAudioIdSet.value
  return allAudioFiles.value.filter((audio) => selectedIdSet.has(audio.id))
})
const selectedAudioCount = computed(() => selectedAudioIds.value.length)
const canPlayAllAsSuperTrack = computed(
  () => selectedAudioCount.value >= 2 || currentlyDisplayedAudioFiles.value.length >= 2,
)
const bulkSelectionCategoryValue = computed(() => {
  if (selectedAudioFiles.value.length === 0) {
    return ''
  }
  const firstCategory = selectedAudioFiles.value[0]?.metadata.category
  if (!firstCategory) {
    return ''
  }
  const hasMixedCategories = selectedAudioFiles.value.some((audio) => audio.metadata.category !== firstCategory)
  return hasMixedCategories ? '' : firstCategory
})
const playingAudioIds = computed(() => new Set(props.activeTracks.map((track) => track.audioId)))
const hasVisibleItems = computed(() => {
  if (isSearchActive.value) {
    return filteredAudioFiles.value.length > 0
  }
  return visibleDirectories.value.length > 0 || visibleAudioFiles.value.length > 0
})

const directoryBreadcrumbs = computed(() => {
  const normalizedCurrent = normalizePath(currentDirectoryPath.value)
  if (!normalizedCurrent) {
    return [] as Array<{ label: string; path: string }>
  }

  const segments = normalizedCurrent.split('/')
  return segments.map((label, index) => ({
    label,
    path: segments.slice(0, index + 1).join('/'),
  }))
})

function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

function joinPath(parent: string, child: string): string {
  const normalizedParent = normalizePath(parent)
  const normalizedChild = normalizePath(child)
  if (!normalizedParent) {
    return normalizedChild
  }
  if (!normalizedChild) {
    return normalizedParent
  }
  return `${normalizedParent}/${normalizedChild}`
}

function resolveParentDirectoryPath(path: string): string | null {
  const normalizedPath = normalizePath(path)
  if (!normalizedPath) {
    return null
  }
  const segments = normalizedPath.split('/')
  segments.pop()
  return segments.join('/')
}

function audioDisplayTitle(audio: AudioFileEntry): string {
  return audio.metadata.title?.trim() || audio.name
}

function compareAudioFiles(a: AudioFileEntry, b: AudioFileEntry): number {
  if (audioSortMode.value === 'title') {
    const byTitle = audioDisplayTitle(a).localeCompare(audioDisplayTitle(b))
    if (byTitle !== 0) {
      return byTitle
    }
  }

  return a.name.localeCompare(b.name)
}

function resolveAudioPathLabel(audio: AudioFileEntry): string {
  if (!audio.relativePath) {
    return '/'
  }
  return `/${audio.relativePath}`
}

function isPlaying(audioId: string): boolean {
  return playingAudioIds.value.has(audioId)
}

function updateSelectedAudioMeta(patch: Partial<AudioMeta>): void {
  if (!selectedAudio.value) {
    return
  }
  emit('updateMeta', selectedAudio.value.id, patch)
}

function updateSelectedAudioCategory(value: string): void {
  if (value !== 'music' && value !== 'effect' && value !== 'sound') {
    return
  }
  updateSelectedAudioMeta({ category: value })
}

function updateSelectionCategory(value: string): void {
  if (value !== 'music' && value !== 'effect' && value !== 'sound') {
    return
  }
  if (selectedAudioIds.value.length === 0) {
    return
  }
  emit('updateMetaBatch', [...selectedAudioIds.value], { category: value })
}

function onSelectedAudioIconChange(event: Event): void {
  if (!selectedAudio.value) {
    return
  }
  onAudioIconChange(selectedAudio.value.id, event)
}

function resolveCollectionTitle(collectionName: string): string {
  const collection = props.allCollections.find((entry) => entry.name === collectionName)
  return collection?.title ?? collectionName
}

watch(
  () => props.selectedCollection?.name,
  () => {
    selectedAudioId.value = null
    selectedAudioIds.value = []
    lastSelectedAudioId.value = null
    currentDirectoryPath.value = normalizePath(props.currentDirectoryPath)
    closeContextMenus()
  },
)

watch(
  () => props.currentDirectoryPath,
  (nextPath) => {
    const normalizedNext = normalizePath(nextPath)
    if (normalizePath(currentDirectoryPath.value) === normalizedNext) {
      return
    }
    currentDirectoryPath.value = normalizedNext
  },
  { immediate: true },
)

watch(currentDirectoryPath, (nextPath) => {
  const normalizedNext = normalizePath(nextPath)
  if (normalizedNext !== nextPath) {
    currentDirectoryPath.value = normalizedNext
    return
  }
  if (normalizePath(props.currentDirectoryPath) === normalizedNext) {
    return
  }
  emit('updateCurrentDirectoryPath', normalizedNext)
})

watch(
  () => props.selectedCollection?.directoryPaths.join('|') ?? '',
  () => {
    if (!props.selectedCollection) {
      currentDirectoryPath.value = ''
      return
    }

    const normalizedCurrent = normalizePath(currentDirectoryPath.value)
    if (!normalizedCurrent) {
      return
    }

    const exists = props.selectedCollection.directoryPaths.some((path) => normalizePath(path) === normalizedCurrent)
    if (!exists) {
      currentDirectoryPath.value = ''
      closeContextMenus()
    }
  },
)

function onAudioIconChange(audioId: string, event: Event): void {
  const input = event.target as HTMLInputElement
  emit('setAudioIcon', audioId, input.files?.[0] ?? null)
  input.value = ''
}

function onImportChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (props.selectedCollection && files.length > 0) {
    emit('importFiles', props.selectedCollection.name, files, normalizePath(currentDirectoryPath.value))
  }
  input.value = ''
}

function onCardDragStart(audio: AudioFileEntry, event: DragEvent): void {
  if (!event.dataTransfer) {
    return
  }
  const audioIds = selectedAudioIdSet.value.has(audio.id)
    ? selectedAudioIds.value
    : [audio.id]
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData('application/x-audio-id', audioIds[0] ?? audio.id)
  event.dataTransfer.setData('application/x-audio-ids', JSON.stringify(audioIds))
}

function onDirectoryCardDragStart(directory: DirectoryBrowserEntry, event: DragEvent): void {
  if (directory.isParentShortcut || !event.dataTransfer) {
    event.preventDefault()
    return
  }

  const normalizedPath = normalizePath(directory.relativePath)
  if (!normalizedPath) {
    event.preventDefault()
    return
  }

  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-directory-path', normalizedPath)
}

function selectAudioForEdit(audioId: string): void {
  selectedAudioId.value = audioId
}

function clearAudioSelection(): void {
  selectedAudioIds.value = []
  lastSelectedAudioId.value = null
}

function onAudioBrowserBackgroundClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element)) {
    return
  }

  if (target.closest('article, button, input, select, textarea, label')) {
    return
  }

  clearAudioSelection()
  closeAudioProperties()
}

function resolveSelectableAudioFiles(): AudioFileEntry[] {
  return isSearchActive.value ? filteredAudioFiles.value : visibleAudioFiles.value
}

function selectAudioRange(targetAudioId: string): void {
  const selectableAudioFiles = resolveSelectableAudioFiles()
  if (selectableAudioFiles.length === 0) {
    selectedAudioIds.value = [targetAudioId]
    lastSelectedAudioId.value = targetAudioId
    return
  }

  const anchorId = lastSelectedAudioId.value ?? selectedAudioIds.value[0] ?? targetAudioId
  const anchorIndex = selectableAudioFiles.findIndex((audio) => audio.id === anchorId)
  const targetIndex = selectableAudioFiles.findIndex((audio) => audio.id === targetAudioId)
  if (anchorIndex < 0 || targetIndex < 0) {
    selectedAudioIds.value = [targetAudioId]
    lastSelectedAudioId.value = targetAudioId
    return
  }

  const rangeStart = Math.min(anchorIndex, targetIndex)
  const rangeEnd = Math.max(anchorIndex, targetIndex)
  selectedAudioIds.value = selectableAudioFiles.slice(rangeStart, rangeEnd + 1).map((audio) => audio.id)
}

function onAudioCardClick(audioId: string, event: MouseEvent): boolean {
  if (event.shiftKey) {
    selectAudioRange(audioId)
    return false
  }

  if (event.metaKey || event.ctrlKey) {
    if (selectedAudioIdSet.value.has(audioId)) {
      selectedAudioIds.value = selectedAudioIds.value.filter((id) => id !== audioId)
    } else {
      selectedAudioIds.value = [...selectedAudioIds.value, audioId]
    }
    lastSelectedAudioId.value = audioId
    return false
  }

  selectedAudioIds.value = [audioId]
  lastSelectedAudioId.value = audioId
  return true
}

function closeAudioProperties(): void {
  selectedAudioId.value = null
}

function deleteSelectedAudio(): void {
  if (!selectedAudio.value) {
    return
  }

  const shouldDelete = window.confirm(
    `Delete "${audioDisplayTitle(selectedAudio.value)}"?\n\nThis will permanently remove the audio file and its metadata.`,
  )
  if (!shouldDelete) {
    return
  }

  emit('deleteAudio', selectedAudio.value.id)
  selectedAudioIds.value = selectedAudioIds.value.filter((id) => id !== selectedAudio.value?.id)
  closeAudioProperties()
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  event.stopPropagation()
  isDropOver.value = false
  dragOverDirectoryPath.value = null
  if (!props.selectedCollection || !event.dataTransfer?.files?.length) {
    return
  }
  const files = Array.from(event.dataTransfer.files)
  emit('importFiles', props.selectedCollection.name, files, normalizePath(currentDirectoryPath.value))
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  isDropOver.value = true
}

function onDragLeave(): void {
  isDropOver.value = false
}

function onDirectoryDragOver(directoryPath: string, event: DragEvent): void {
  const types = event.dataTransfer?.types
  const isAudioCardDrag = Boolean(
    types?.includes('application/x-audio-id') || types?.includes('application/x-audio-ids'),
  )
  const isDirectoryDrag = Boolean(types?.includes('application/x-directory-path'))
  const isFileDrag = Boolean(types?.includes('Files'))
  if (!isAudioCardDrag && !isDirectoryDrag && !isFileDrag) {
    return
  }
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = isFileDrag ? 'copy' : 'move'
  }
  dragOverDirectoryPath.value = normalizePath(directoryPath)
}

function onDirectoryDragLeave(directoryPath: string): void {
  if (dragOverDirectoryPath.value === normalizePath(directoryPath)) {
    dragOverDirectoryPath.value = null
  }
}

function onDirectoryDrop(directoryPath: string, event: DragEvent): void {
  event.preventDefault()
  event.stopPropagation()
  dragOverDirectoryPath.value = null
  isDropOver.value = false
  if (!props.selectedCollection || !event.dataTransfer) {
    return
  }

  const rawAudioIds = event.dataTransfer.getData('application/x-audio-ids')
  const audioIds = (() => {
    if (rawAudioIds) {
      try {
        const parsed = JSON.parse(rawAudioIds)
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
        }
      } catch {
        // no-op
      }
    }

    const audioId = event.dataTransfer.getData('application/x-audio-id')
    return audioId ? [audioId] : []
  })()

  if (audioIds.length > 0) {
    emit(
      'moveAudioToDirectory',
      props.selectedCollection.name,
      audioIds,
      normalizePath(directoryPath),
    )
    clearAudioSelection()
    return
  }

  const sourceDirectoryPath = normalizePath(
    event.dataTransfer.getData('application/x-directory-path'),
  )
  if (sourceDirectoryPath) {
    const targetParentDirectoryPath = normalizePath(directoryPath)
    emit(
      'moveDirectory',
      props.selectedCollection.name,
      sourceDirectoryPath,
      targetParentDirectoryPath,
    )
    return
  }

  if (!event.dataTransfer.files?.length) {
    return
  }
  const files = Array.from(event.dataTransfer.files)
  emit('importFiles', props.selectedCollection.name, files, normalizePath(directoryPath))
}

function closeDirectoryContextMenu(): void {
  directoryContextMenu.value = null
}

function closeAudioContextMenu(): void {
  audioContextMenu.value = null
}

function closeAudioFilesListContextMenu(): void {
  audioFilesListContextMenu.value = null
}

function closeContextMenus(): void {
  closeDirectoryContextMenu()
  closeAudioContextMenu()
  closeAudioFilesListContextMenu()
}

function onDirectoryContextMenu(directory: DirectoryBrowserEntry, event: MouseEvent): void {
  if (isSearchActive.value) {
    return
  }
  if (directory.isParentShortcut) {
    return
  }

  event.preventDefault()
  event.stopPropagation()

  const menuWidth = 170
  const menuHeight = 92
  const padding = 8
  const clampedX = Math.max(0, Math.min(event.clientX, window.innerWidth - menuWidth - padding))
  const clampedY = Math.max(0, Math.min(event.clientY, window.innerHeight - menuHeight - padding))

  closeAudioContextMenu()
  directoryContextMenu.value = {
    x: clampedX,
    y: clampedY,
    directoryPath: normalizePath(directory.relativePath),
    directoryName: directory.name,
  }
}

function renameDirectoryFromContextMenu(): void {
  if (!props.selectedCollection || !directoryContextMenu.value) {
    return
  }

  const selectedDirectory = directoryContextMenu.value
  closeDirectoryContextMenu()
  const nextName = window.prompt('Rename folder', selectedDirectory.directoryName)
  if (nextName === null) {
    return
  }

  const trimmed = nextName.trim()
  if (!trimmed || trimmed === selectedDirectory.directoryName) {
    return
  }

  emit('renameDirectory', props.selectedCollection.name, selectedDirectory.directoryPath, trimmed)
}

function deleteDirectoryFromContextMenu(): void {
  if (!props.selectedCollection || !directoryContextMenu.value) {
    return
  }

  const selectedDirectory = directoryContextMenu.value
  closeDirectoryContextMenu()

  const shouldDelete = window.confirm(
    `Delete folder "/${selectedDirectory.directoryPath}"?\n\nThis will permanently remove this folder and all files/subfolders inside it.`,
  )
  if (!shouldDelete) {
    return
  }

  emit('deleteDirectory', props.selectedCollection.name, selectedDirectory.directoryPath)
}

function onAudioContextMenu(audio: AudioFileEntry, event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()

  const menuWidth = 170
  const menuHeight = 52
  const padding = 8
  const clampedX = Math.max(0, Math.min(event.clientX, window.innerWidth - menuWidth - padding))
  const clampedY = Math.max(0, Math.min(event.clientY, window.innerHeight - menuHeight - padding))

  closeDirectoryContextMenu()
  audioContextMenu.value = {
    x: clampedX,
    y: clampedY,
    audioId: audio.id,
  }
}

function onAudioFilesListContextMenu(event: MouseEvent): void {
  if (!props.selectedCollection || isSearchActive.value) {
    return
  }

  event.preventDefault()
  event.stopPropagation()

  const menuWidth = 170
  const menuHeight = 52
  const padding = 8
  const clampedX = Math.max(0, Math.min(event.clientX, window.innerWidth - menuWidth - padding))
  const clampedY = Math.max(0, Math.min(event.clientY, window.innerHeight - menuHeight - padding))

  closeDirectoryContextMenu()
  closeAudioContextMenu()
  audioFilesListContextMenu.value = {
    x: clampedX,
    y: clampedY,
  }
}

function newFolderFromAudioFilesContextMenu(): void {
  if (!props.selectedCollection) {
    return
  }

  closeAudioFilesListContextMenu()
  const enteredName = window.prompt('New folder name', newDirectoryName.value)
  if (enteredName === null) {
    return
  }

  const trimmed = enteredName.trim()
  if (!trimmed) {
    return
  }

  newDirectoryName.value = trimmed
  createDirectory()
}

function editAudioFromContextMenu(): void {
  if (!audioContextMenu.value) {
    return
  }
  selectAudioForEdit(audioContextMenu.value.audioId)
  closeAudioContextMenu()
}

function enterDirectory(directoryPath: string): void {
  currentDirectoryPath.value = normalizePath(directoryPath)
}

function goToDirectory(directoryPath: string): void {
  currentDirectoryPath.value = normalizePath(directoryPath)
  closeContextMenus()
}

function goUpDirectory(): void {
  const normalizedCurrent = normalizePath(currentDirectoryPath.value)
  if (!normalizedCurrent) {
    return
  }

  const segments = normalizedCurrent.split('/')
  segments.pop()
  currentDirectoryPath.value = segments.join('/')
  closeContextMenus()
}

function createDirectory(): void {
  const trimmed = newDirectoryName.value.trim()
  if (!props.selectedCollection || !trimmed) {
    return
  }

  const normalizedCurrentDirectoryPath = normalizePath(currentDirectoryPath.value)
  if (selectedAudioCount.value > 1) {
    emit(
      'createDirectoryWithSelectedAudio',
      props.selectedCollection.name,
      normalizedCurrentDirectoryPath,
      trimmed,
      [...selectedAudioIds.value],
    )
    newDirectoryName.value = ''
    return
  }

  emit(
    'createDirectory',
    props.selectedCollection.name,
    normalizedCurrentDirectoryPath,
    trimmed,
  )
  newDirectoryName.value = ''
}

function playRandomDisplayedAudio(): void {
  const displayedAudioFiles = currentlyDisplayedAudioFiles.value
  if (displayedAudioFiles.length === 0) {
    return
  }

  const randomIndex = Math.floor(Math.random() * displayedAudioFiles.length)
  const randomAudio = displayedAudioFiles[randomIndex]
  if (!randomAudio) {
    return
  }

  selectedAudioIds.value = [randomAudio.id]
  lastSelectedAudioId.value = randomAudio.id
  selectAudioForEdit(randomAudio.id)
  emit('playAudio', randomAudio)
}

function playSelectedAsSuperTrack(): void {
  if (selectedAudioCount.value >= 2) {
    const selectedIdSet = new Set(selectedAudioIds.value)
    const orderedVisibleIds = resolveSelectableAudioFiles()
      .map((audio) => audio.id)
      .filter((audioId) => selectedIdSet.has(audioId))
    const missingSelectedIds = selectedAudioIds.value.filter((audioId) => !orderedVisibleIds.includes(audioId))
    const orderedAudioIds = [...orderedVisibleIds, ...missingSelectedIds]
    if (orderedAudioIds.length < 2) {
      return
    }

    emit('playSuperAudio', orderedAudioIds)
    return
  }

  const displayedAudioIds = currentlyDisplayedAudioFiles.value.map((audio) => audio.id)
  if (displayedAudioIds.length < 2) {
    return
  }
  emit('playSuperAudio', displayedAudioIds)
}

function promptOpenRouterApiKey(): string | null {
  if (openRouterApiKey.value.trim()) {
    return openRouterApiKey.value.trim()
  }

  const entered = window.prompt(
    'Enter your OpenRouter API key to auto-generate titles for displayed files.',
    openRouterApiKey.value,
  )
  if (entered === null) {
    return null
  }

  const trimmed = entered.trim()
  if (!trimmed) {
    window.alert('OpenRouter API key is required.')
    return null
  }

  openRouterApiKey.value = trimmed
  window.localStorage.setItem(OPENROUTER_API_KEY_STORAGE_KEY, trimmed)
  return trimmed
}

function autoAssignDisplayedTitles(): void {
  if (props.isAutoAssigningTitles) {
    return
  }

  const displayedAudio = currentlyDisplayedAudioFiles.value
  if (displayedAudio.length === 0) {
    return
  }

  const apiKey = promptOpenRouterApiKey()
  if (!apiKey) {
    return
  }

  const shouldProceed = window.confirm(
    `Generate titles for ${displayedAudio.length} currently displayed audio files?\n\nExisting custom titles may be overwritten.`,
  )
  if (!shouldProceed) {
    return
  }

  emit(
    'autoAssignTitles',
    displayedAudio.map((audio) => audio.id),
    apiKey,
    normalizePath(currentDirectoryPath.value),
  )
}

onMounted(() => {
  const savedApiKey = window.localStorage.getItem(OPENROUTER_API_KEY_STORAGE_KEY)
  if (savedApiKey) {
    openRouterApiKey.value = savedApiKey
  }

  window.addEventListener('click', closeContextMenus)
  window.addEventListener('resize', closeContextMenus)
  window.addEventListener('scroll', closeContextMenus, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeContextMenus)
  window.removeEventListener('resize', closeContextMenus)
  window.removeEventListener('scroll', closeContextMenus, true)
})

watch(
  () => allAudioFiles.value.map((audio) => audio.id).join('|'),
  () => {
    const validAudioIds = new Set(allAudioFiles.value.map((audio) => audio.id))
    selectedAudioIds.value = selectedAudioIds.value.filter((id) => validAudioIds.has(id))
    if (selectedAudioId.value && !validAudioIds.has(selectedAudioId.value)) {
      selectedAudioId.value = null
    }
    if (lastSelectedAudioId.value && !validAudioIds.has(lastSelectedAudioId.value)) {
      lastSelectedAudioId.value = null
    }
  },
)
</script>

<template>
  <section class="bg-slate-800/90 rounded-2xl border border-slate-700 p-4 flex flex-col gap-4">
    <header class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-xl font-semibold text-slate-100">
          {{ props.selectedCollection?.title ?? 'Select a collection' }}
        </h3>
        <p class="text-sm text-slate-300">Tap to play instantly, drag cards to the track deck.</p>
      </div>
      <input
        v-model="searchQuery"
        type="search"
        class="w-64 max-w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        placeholder="Search audio in all collections"
      />
      <label class="px-3 py-2 rounded-lg bg-indigo-400 hover:bg-indigo-300 text-slate-900 text-sm font-semibold cursor-pointer">
        Import Audio
        <input type="file" accept="audio/*" multiple class="hidden" @change="onImportChange" />
      </label>
      <button
        type="button"
        class="px-3 py-2 rounded-lg border border-emerald-400/70 bg-emerald-400/10 hover:bg-emerald-400/20 text-emerald-200 text-sm font-semibold disabled:opacity-50"
        :disabled="currentlyDisplayedAudioFiles.length === 0"
        @click="playRandomDisplayedAudio"
      >
        Play Random
      </button>
      <button
        type="button"
        class="px-3 py-2 rounded-lg border border-sky-400/70 bg-sky-400/10 hover:bg-sky-400/20 text-sky-200 text-sm font-semibold disabled:opacity-50"
        :disabled="currentlyDisplayedAudioFiles.length === 0 || props.isAutoAssigningTitles"
        @click="autoAssignDisplayedTitles"
      >
        {{ props.isAutoAssigningTitles ? 'Generating Titles...' : 'Auto Assign Titles (AI)' }}
      </button>
    </header>

    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2 text-sm text-slate-300 min-w-0">
        <button
          type="button"
          class="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          :disabled="!currentDirectoryPath || isSearchActive"
          @click="goUpDirectory"
        >
          Up
        </button>
        <button
          type="button"
          class="text-cyan-200 hover:text-cyan-100 cursor-pointer"
          :class="!props.selectedCollection || isSearchActive ? 'pointer-events-none opacity-50' : ''"
          @click="goToDirectory('')"
        >
          Root
        </button>
        <template v-for="crumb in directoryBreadcrumbs" :key="crumb.path">
          <span>/</span>
          <button
            type="button"
            class="text-cyan-200 hover:text-cyan-100 truncate cursor-pointer"
            :class="isSearchActive ? 'pointer-events-none opacity-50' : ''"
            @click="goToDirectory(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </div>

      <div class="flex items-center gap-3 flex-wrap justify-end">
        <label class="text-xs text-slate-300 inline-flex items-center gap-2">
          Sort
          <select
            v-model="audioSortMode"
            class="rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
          >
            <option value="name">File name</option>
            <option value="title">Title</option>
          </select>
        </label>
        <div class="text-xs text-slate-300">
          {{ selectedAudioCount }} selected
          <span class="text-slate-400">(Ctrl/Cmd to toggle, Shift for range)</span>
        </div>
        <button
          type="button"
          class="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          :disabled="selectedAudioCount === 0"
          @click="clearAudioSelection"
        >
          Clear Selection
        </button>
        <button
          type="button"
          class="rounded-md border border-cyan-500/60 bg-cyan-500/10 px-2 py-1 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
          :disabled="!canPlayAllAsSuperTrack"
          @click="playSelectedAsSuperTrack"
        >
          Play all as Super Track
        </button>
        <!-- SEP -->
        <label class="text-xs text-slate-300 inline-flex items-center gap-2">
          Set category
          <select
            class="rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100 disabled:opacity-50"
            :value="bulkSelectionCategoryValue"
            :disabled="selectedAudioCount === 0"
            @change="updateSelectionCategory(($event.target as HTMLSelectElement).value)"
          >
            <option value="" disabled>
              {{ selectedAudioCount > 1 ? 'mixed' : 'Select category' }}
            </option>
            <option value="music">music</option>
            <option value="effect">effect</option>
            <option value="sound">sound</option>
          </select>
        </label>
        <input
          v-model="newDirectoryName"
          type="text"
          class="w-52 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100"
          placeholder="New folder name"
          :disabled="!props.selectedCollection || isSearchActive"
          @keydown.enter.prevent="createDirectory"
        />
        <button
          type="button"
          class="rounded-lg border border-cyan-500/60 bg-cyan-500/10 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
          :disabled="!props.selectedCollection || isSearchActive || !newDirectoryName.trim()"
          @click="createDirectory"
        >
          {{ selectedAudioCount > 1 ? 'New folder with selection' : 'New Folder' }}
        </button>
      </div>

    </div>

    <div
      class="audio-files-list flex-1 min-h-0 overflow-y-auto rounded-xl border border-dashed p-3"
      :class="isDropOver ? 'border-emerald-400 bg-emerald-400/10' : 'border-slate-700'"
      @drop="onDrop"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @click="onAudioBrowserBackgroundClick"
      @contextmenu="onAudioFilesListContextMenu"
    >
      <div
        v-if="!props.selectedCollection && !isSearchActive"
        class="h-full grid place-items-center text-slate-400 text-sm"
      >
        Create or select a collection to view audio files.
      </div>

      <div v-else-if="hasVisibleItems" class="grid grid-cols-8 gap-3">
        <article
          v-if="!isSearchActive"
          v-for="directory in visibleDirectories"
          :key="directory.relativePath"
          class="rounded-xl border p-3 bg-slate-900 hover:bg-slate-700/70 transition-all duration-200"
          :class="
            dragOverDirectoryPath === directory.relativePath
              ? 'border-emerald-400 bg-emerald-400/10'
              : 'border-slate-700'
          "
          @dragover="(event) => onDirectoryDragOver(directory.relativePath, event)"
          @dragleave="() => onDirectoryDragLeave(directory.relativePath)"
          @drop="(event) => onDirectoryDrop(directory.relativePath, event)"
          :draggable="!directory.isParentShortcut"
          @dragstart="(event) => onDirectoryCardDragStart(directory, event)"
          @contextmenu="(event) => onDirectoryContextMenu(directory, event)"
        >
          <button
            type="button"
            class="w-full text-left"
            @click="enterDirectory(directory.relativePath)"
          >
            <div class="aspect-square rounded-lg mb-2 bg-slate-700 overflow-hidden grid place-items-center">
              <svg viewBox="0 0 24 24" class="h-10 w-10 text-amber-300" fill="currentColor" aria-hidden="true">
                <path d="M10.5 4a1 1 0 0 1 .8.4l1.2 1.6H19a2 2 0 0 1 2 2v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h4.5Z" />
              </svg>
            </div>
            <div class="text-sm font-medium text-slate-100 truncate">{{ directory.name }}</div>
            <div class="text-xs text-slate-300 mt-1">directory</div>
          </button>
        </article>

        <article
          v-for="audio in currentlyDisplayedAudioFiles"
          :key="audio.id"
          class="rounded-xl border p-3 transition-all duration-200"
          :class="[
            selectedAudioIdSet.has(audio.id) ? 'bg-slate-700' : 'bg-slate-900 hover:bg-slate-700/70',
            isPlaying(audio.id)
              ? 'border-emerald-300 shadow-[0_0_0_2px_rgba(110,231,183,0.35),0_0_22px_rgba(16,185,129,0.45)] animate-pulse'
              : selectedAudioIdSet.has(audio.id)
                ? 'border-cyan-400'
                : 'border-slate-700',
          ]"
          draggable="true"
          @dragstart="(event) => onCardDragStart(audio, event)"
          @contextmenu="(event) => onAudioContextMenu(audio, event)"
        >
          <button
            type="button"
            class="w-full text-left"
            @click="
              (event) => {
                if (onAudioCardClick(audio.id, event)) {
                  emit('playAudio', audio)
                }
              }
            "
            @auxclick="selectAudioForEdit(audio.id)"
          >
            <div class="aspect-square rounded-lg mb-2 bg-slate-700 overflow-hidden grid place-items-center">
              <img
                v-if="props.audioIconUrls[audio.id]"
                :src="props.audioIconUrls[audio.id]"
                :alt="audioDisplayTitle(audio)"
                class="w-full h-full object-cover"
              />
              <span v-else class="text-xs text-slate-300 uppercase">{{ audio.metadata.category }}</span>
            </div>
            <div class="text-sm font-medium text-slate-100 truncate">{{ audioDisplayTitle(audio) }}</div>
            <div class="text-xs text-slate-300 mt-1">
              {{ audio.metadata.category }}
              <span v-if="isSearchActive" class="text-slate-400">• {{ resolveCollectionTitle(audio.collectionName) }} {{ resolveAudioPathLabel(audio) }}</span>
            </div>
          </button>
        </article>
      </div>

      <div v-else class="h-full grid place-items-center text-slate-400 text-sm">
        <span v-if="isSearchActive">No audio files found for "{{ searchQuery.trim() }}".</span>
        <span v-else-if="props.selectedCollection">This folder has no sub-directories or audio files yet.</span>
        <span v-else>Create or select a collection to view audio files.</span>
      </div>
    </div>

    <div
      v-if="directoryContextMenu"
      class="fixed inset-0 z-40"
      @click="closeDirectoryContextMenu"
      @contextmenu.prevent="closeDirectoryContextMenu"
    >
      <div
        class="fixed z-50 min-w-[170px] rounded-lg border border-slate-600 bg-slate-900 p-1 shadow-xl"
        :style="{ left: `${directoryContextMenu.x}px`, top: `${directoryContextMenu.y}px` }"
        @click.stop
      >
        <button
          type="button"
          class="w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-800"
          @click="renameDirectoryFromContextMenu"
        >
          Rename
        </button>
        <button
          type="button"
          class="w-full rounded-md px-3 py-2 text-left text-sm text-rose-200 hover:bg-rose-500/20"
          @click="deleteDirectoryFromContextMenu"
        >
          Delete
        </button>
      </div>
    </div>

    <div
      v-if="audioContextMenu"
      class="fixed inset-0 z-40"
      @click="closeAudioContextMenu"
      @contextmenu.prevent="closeAudioContextMenu"
    >
      <div
        class="fixed z-50 min-w-[170px] rounded-lg border border-slate-600 bg-slate-900 p-1 shadow-xl"
        :style="{ left: `${audioContextMenu.x}px`, top: `${audioContextMenu.y}px` }"
        @click.stop
      >
        <button
          type="button"
          class="w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-800"
          @click="editAudioFromContextMenu"
        >
          Edit properties
        </button>
      </div>
    </div>

    <div
      v-if="audioFilesListContextMenu"
      class="fixed inset-0 z-40"
      @click="closeAudioFilesListContextMenu"
      @contextmenu.prevent="closeAudioFilesListContextMenu"
    >
      <div
        class="fixed z-50 min-w-[170px] rounded-lg border border-slate-600 bg-slate-900 p-1 shadow-xl"
        :style="{ left: `${audioFilesListContextMenu.x}px`, top: `${audioFilesListContextMenu.y}px` }"
        @click.stop
      >
        <button
          type="button"
          class="w-full rounded-md px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-800"
          @click="newFolderFromAudioFilesContextMenu"
        >
          New folder
        </button>
      </div>
    </div>

    <div v-if="selectedAudio" class="rounded-xl border border-slate-700 bg-slate-900/80 p-3 grid grid-cols-2 gap-3 text-sm text-slate-100">
      <div class="col-span-2 flex items-center justify-between">
        <p class="font-semibold truncate">Edit: {{ audioDisplayTitle(selectedAudio) }}</p>
        <div class="flex items-center gap-3">
          <label class="text-xs text-cyan-300 cursor-pointer">
            Change icon
            <input type="file" accept="image/*" class="hidden" @change="onSelectedAudioIconChange" />
          </label>
          <button
            type="button"
            class="rounded-md border border-rose-500/70 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
            @click="deleteSelectedAudio"
          >
            Delete
          </button>
          <button
            type="button"
            class="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
            @click="closeAudioProperties"
          >
            Close
          </button>
        </div>
      </div>

      <label class="col-span-2 space-y-1">
        <span class="text-xs text-slate-300">Title</span>
        <input
          type="text"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1"
          :value="selectedAudio.metadata.title ?? ''"
          :placeholder="selectedAudio.name"
          @input="
            updateSelectedAudioMeta({
              title: ($event.target as HTMLInputElement).value || null,
            })
          "
        />
      </label>

      <label class="space-y-1">
        <span class="text-xs text-slate-300">Category</span>
        <select
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1"
          :value="selectedAudio.metadata.category"
          @change="updateSelectedAudioCategory(($event.target as HTMLSelectElement).value)"
        >
          <option value="music">music</option>
          <option value="effect">effect</option>
          <option value="sound">sound</option>
        </select>
      </label>

      <label class="space-y-1">
        <span class="text-xs text-slate-300">Volume ({{ selectedAudio.metadata.volume }}%)</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          :value="selectedAudio.metadata.volume"
          class="w-full"
          @input="updateSelectedAudioMeta({ volume: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="col-span-2 inline-flex items-center gap-2 text-slate-200">
        <input
          type="checkbox"
          :checked="selectedAudio.metadata.infiniteLoop"
          @change="updateSelectedAudioMeta({ infiniteLoop: ($event.target as HTMLInputElement).checked })"
        />
        Infinite loop
      </label>

      <label class="space-y-1">
        <span class="text-xs text-slate-300">Trim start (seconds)</span>
        <input
          type="number"
          min="0"
          step="0.1"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1"
          :value="selectedAudio.metadata.trimStart ?? ''"
          @input="
            updateSelectedAudioMeta({
              trimStart: ($event.target as HTMLInputElement).value
                ? Number(($event.target as HTMLInputElement).value)
                : null,
            })
          "
        />
      </label>

      <label class="space-y-1">
        <span class="text-xs text-slate-300">Trim end (seconds)</span>
        <input
          type="number"
          min="0"
          step="0.1"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-2 py-1"
          :value="selectedAudio.metadata.trimEnd ?? ''"
          @input="
            updateSelectedAudioMeta({
              trimEnd: ($event.target as HTMLInputElement).value
                ? Number(($event.target as HTMLInputElement).value)
                : null,
            })
          "
        />
      </label>
    </div>
  </section>
</template>
