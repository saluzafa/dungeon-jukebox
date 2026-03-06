<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AudioBrowser from '@/components/AudioBrowser.vue'
import CollectionSidebar from '@/components/CollectionSidebar.vue'
import TrackDeck from '@/components/TrackDeck.vue'
import { useSoundboard } from '@/composables/useSoundboard'

const {
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
  moveAudioFilesToCollection,
  autoAssignTitlesWithOpenRouter,
  resolveCollectionIconUrl,
  resolveAudioIconUrl,
} = useSoundboard()

const collectionIconUrls = ref<Record<string, string>>({})
const audioIconUrls = ref<Record<string, string>>({})
const currentDirectoryPath = ref('')

const rootFolderName = computed(() => rootHandle.value?.name ?? null)
const hasRootFolder = computed(() => !!rootHandle.value)

function normalizePath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

function readViewStateFromHash(): { collectionName: string | null; directoryPath: string } {
  if (typeof window === 'undefined') {
    return {
      collectionName: null,
      directoryPath: '',
    }
  }

  const raw = window.location.hash.replace(/^#/, '')
  if (!raw) {
    return {
      collectionName: null,
      directoryPath: '',
    }
  }

  if (raw.includes('=')) {
    const params = new URLSearchParams(raw)
    return {
      collectionName: params.get('collection'),
      directoryPath: normalizePath(params.get('dir') ?? ''),
    }
  }

  try {
    return {
      collectionName: decodeURIComponent(raw),
      directoryPath: '',
    }
  } catch {
    return {
      collectionName: raw,
      directoryPath: '',
    }
  }
}

function writeViewStateToHash(collectionName: string | null, directoryPath: string): void {
  if (typeof window === 'undefined') {
    return
  }

  const normalizedDirectoryPath = normalizePath(directoryPath)
  const nextHash = (() => {
    if (!collectionName) {
      return ''
    }

    if (!normalizedDirectoryPath) {
      return `#${encodeURIComponent(collectionName)}`
    }

    const params = new URLSearchParams()
    params.set('collection', collectionName)
    params.set('dir', normalizedDirectoryPath)
    return `#${params.toString()}`
  })()

  if (window.location.hash === nextHash) {
    return
  }

  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${nextHash}`,
  )
}

async function refreshAudioIconUrls(): Promise<void> {
  for (const url of Object.values(audioIconUrls.value)) {
    URL.revokeObjectURL(url)
  }

  const next: Record<string, string> = {}
  for (const audio of allAudioFiles.value) {
    const url = await resolveAudioIconUrl(audio)
    if (url) {
      next[audio.id] = url
    }
  }

  audioIconUrls.value = next
}

async function refreshCollectionIconUrls(): Promise<void> {
  for (const url of Object.values(collectionIconUrls.value)) {
    URL.revokeObjectURL(url)
  }

  const next: Record<string, string> = {}
  for (const collection of collections.value) {
    const url = await resolveCollectionIconUrl(collection)
    if (url) {
      next[collection.name] = url
    }
  }

  collectionIconUrls.value = next
}

onMounted(async () => {
  const viewState = readViewStateFromHash()
  selectedCollectionName.value = viewState.collectionName
  currentDirectoryPath.value = viewState.directoryPath
  await tryRestoreLastFolder()

  window.addEventListener('hashchange', onHashChange)
})

function onHashChange(): void {
  const viewState = readViewStateFromHash()
  selectedCollectionName.value = viewState.collectionName
  currentDirectoryPath.value = viewState.directoryPath
}

watch(selectedCollectionName, () => {
  writeViewStateToHash(selectedCollectionName.value, currentDirectoryPath.value)
})

watch(currentDirectoryPath, (nextDirectoryPath) => {
  currentDirectoryPath.value = normalizePath(nextDirectoryPath)
  writeViewStateToHash(selectedCollectionName.value, currentDirectoryPath.value)
})

watch(
  () => collections.value.map((collection) => `${collection.name}-${collection.iconImage}`).join('|'),
  async () => {
    await refreshCollectionIconUrls()
  },
  { immediate: true },
)

watch(
  () => allAudioFiles.value.map((audio) => `${audio.id}-${audio.metadata.iconImage}`).join('|'),
  async () => {
    await refreshAudioIconUrls()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', onHashChange)

  for (const url of Object.values(collectionIconUrls.value)) {
    URL.revokeObjectURL(url)
  }
  for (const url of Object.values(audioIconUrls.value)) {
    URL.revokeObjectURL(url)
  }
})
</script>

<template>
  <main class="min-h-screen w-full bg-[radial-gradient(circle_at_top,_#1f2a44_0%,_#0b1020_45%,_#05070f_100%)] text-slate-100 p-4 md:p-6">
    <div
      v-if="hasRootFolder"
      class="grid grid-cols-12 gap-4"
    >
      <div class="col-span-2">
        <CollectionSidebar
          :collections="collections"
          :collection-icon-urls="collectionIconUrls"
          :selected-collection-name="selectedCollectionName"
          :root-folder-name="rootFolderName"
          @connect-folder="connectFolder"
          @select-collection="
            (name) => {
              selectedCollectionName = name
              currentDirectoryPath = ''
            }
          "
          @create-collection="(name, iconFile) => createCollection(name, iconFile)"
          @update-collection-icon="(collectionName, file) => setCollectionIcon(collectionName, file)"
          @update-collection-title="(collectionName, title) => setCollectionTitle(collectionName, title)"
          @destroy-collection="(collectionName) => deleteCollection(collectionName)"
          @move-audio-to-collection="
            (audioIds, targetCollectionName) => moveAudioFilesToCollection(audioIds, targetCollectionName)
          "
        />
      </div>

      <section class="col-span-10">
        <div class="grid grid-cols-12 gap-2">
          <div class="col-span-10">
            <AudioBrowser
              :selected-collection="selectedCollection"
              :all-collections="collections"
              :audio-icon-urls="audioIconUrls"
              :active-tracks="activeTracks"
              :current-directory-path="currentDirectoryPath"
              :is-auto-assigning-titles="autoTitling"
              @play-audio="playAudio"
              @play-super-audio="(audioIds) => playSuperAudio(audioIds)"
              @auto-assign-titles="
                (audioIds, apiKey, directoryPath) =>
                  autoAssignTitlesWithOpenRouter(audioIds, apiKey, directoryPath)
              "
              @update-current-directory-path="(directoryPath) => (currentDirectoryPath = directoryPath)"
              @update-meta="(audioId, patch) => updateAudioMeta(audioId, patch)"
              @update-meta-batch="(audioIds, patch) => updateAudioMetaBatch(audioIds, patch)"
              @set-audio-icon="(audioId, file) => setAudioIcon(audioId, file)"
              @delete-audio="(audioId) => deleteAudioFile(audioId)"
              @import-files="(collectionName, files, targetDirectoryPath) => importAudioFiles(collectionName, files, targetDirectoryPath)"
              @move-audio-to-directory="
              (collectionName, audioIds, targetDirectoryPath) =>
                moveAudioFilesToDirectory(collectionName, audioIds, targetDirectoryPath)
            "
              @create-directory="
              (collectionName, parentDirectoryPath, directoryName) =>
                createCollectionSubDirectory(collectionName, parentDirectoryPath, directoryName)
            "
              @create-directory-with-selected-audio="
              (collectionName, parentDirectoryPath, directoryName, audioIds) =>
                createCollectionSubDirectoryWithSelectedAudio(
                  collectionName,
                  parentDirectoryPath,
                  directoryName,
                  audioIds,
                )
            "
              @rename-directory="
              (collectionName, directoryPath, newDirectoryName) =>
                renameCollectionSubDirectory(collectionName, directoryPath, newDirectoryName)
            "
              @move-directory="
              (collectionName, directoryPath, targetParentDirectoryPath) =>
                moveCollectionSubDirectory(collectionName, directoryPath, targetParentDirectoryPath)
            "
              @delete-directory="
              (collectionName, directoryPath) =>
                deleteCollectionSubDirectory(collectionName, directoryPath)
            "
            />
          </div>

          <div class="col-span-2">
            <TrackDeck
              :active-tracks="activeTracks"
              :all-audio-files="allAudioFiles"
              :global-volume="globalVolume"
              @play-audio="playAudio"
              @play-super-audio="(audioIds) => playSuperAudio(audioIds)"
              @stop-track="stopTrack"
              @skip-super-track="(trackId) => skipSuperTrack(trackId)"
              @stop-all="stopAllTracks"
              @update-track-volume="(trackId, volume) => updateTrackVolume(trackId, volume)"
              @update-global-volume="(volume) => setGlobalVolume(volume)"
            />
          </div>
        </div>
      </section>
    </div>

    <section
      v-else
      class="mx-auto w-full max-w-2xl h-[calc(100vh-2rem)] md:h-[calc(100vh-3rem)] flex items-center justify-center"
    >
      <div class="w-full rounded-2xl border border-slate-700 bg-slate-900/85 p-8 text-center shadow-xl backdrop-blur">
        <h1 class="text-2xl font-semibold tracking-wide">Select a Local Folder</h1>
        <p class="mt-3 text-sm text-slate-300">
          Choose your soundboard folder to continue. The interface stays hidden until a folder is connected.
        </p>
        <button
          class="mt-6 px-5 py-3 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-900 font-semibold text-sm disabled:opacity-60 disabled:cursor-not-allowed"
          :disabled="!isFileSystemAccessSupported || loading || restoring"
          @click="connectFolder"
        >
          Select Folder
        </button>
        <p v-if="!isFileSystemAccessSupported" class="mt-4 text-xs text-amber-300">
          This browser does not support the File System Access API.
        </p>
      </div>
    </section>

    <div class="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full border border-slate-600 bg-slate-900/80 text-xs backdrop-blur">
      {{ status }}
      <span v-if="loading || restoring" class="ml-2 text-sky-300">Loading…</span>
      <span v-if="!isFileSystemAccessSupported" class="ml-2 text-amber-300">File System Access API required.</span>
    </div>
  </main>
</template>
