<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CollectionEntry } from '@/types/soundboard'

const props = defineProps<{
  collections: CollectionEntry[]
  collectionIconUrls: Record<string, string>
  selectedCollectionName: string | null
  rootFolderName: string | null
}>()

const emit = defineEmits<{
  selectCollection: [name: string]
  createCollection: [name: string, iconFile: File | null]
  connectFolder: []
  updateCollectionIcon: [collectionName: string, iconFile: File | null]
  updateCollectionTitle: [collectionName: string, title: string]
  destroyCollection: [collectionName: string]
  moveAudioToCollection: [audioIds: string[], targetCollectionName: string]
}>()

const newCollectionName = ref('')
const newCollectionIconFile = ref<File | null>(null)
const configuringCollectionName = ref<string | null>(null)
const configuringCollectionTitle = ref('')
const configuringIconFile = ref<File | null>(null)
const configuringIconAction = ref<'keep' | 'replace' | 'remove'>('keep')
const dragOverCollectionName = ref<string | null>(null)

const configuringCollection = computed(() =>
  props.collections.find((collection) => collection.name === configuringCollectionName.value) ?? null,
)

function onCreateCollection(): void {
  const name = newCollectionName.value.trim()
  if (!name) {
    return
  }
  emit('createCollection', name, newCollectionIconFile.value)
  newCollectionName.value = ''
  newCollectionIconFile.value = null
}

function onCollectionIconChange(event: Event): void {
  const input = event.target as HTMLInputElement
  newCollectionIconFile.value = input.files?.[0] ?? null
}

function onConfigureIconChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  configuringIconFile.value = file
  configuringIconAction.value = file ? 'replace' : 'keep'
}

function openCollectionConfigure(collection: CollectionEntry): void {
  configuringCollectionName.value = collection.name
  configuringCollectionTitle.value = collection.title
  configuringIconFile.value = null
  configuringIconAction.value = 'keep'
}

function closeCollectionConfigure(): void {
  configuringCollectionName.value = null
  configuringCollectionTitle.value = ''
  configuringIconFile.value = null
  configuringIconAction.value = 'keep'
}

function removeConfiguredCollectionIcon(): void {
  configuringIconFile.value = null
  configuringIconAction.value = 'remove'
}

function commitCollectionConfigure(): void {
  if (!configuringCollection.value) {
    return
  }

  const collectionName = configuringCollection.value.name
  const nextTitle = configuringCollectionTitle.value.trim()
  emit('updateCollectionTitle', collectionName, nextTitle)

  if (configuringIconAction.value === 'replace') {
    emit('updateCollectionIcon', collectionName, configuringIconFile.value)
  } else if (configuringIconAction.value === 'remove') {
    emit('updateCollectionIcon', collectionName, null)
  }

  closeCollectionConfigure()
}

function destroyConfiguredCollection(): void {
  if (!configuringCollection.value) {
    return
  }

  const collection = configuringCollection.value
  const confirmed = window.confirm(
    `Destroy "${collection.title}"?\n\nThis will permanently delete this collection and everything contained in it.`,
  )
  if (!confirmed) {
    return
  }

  emit('destroyCollection', collection.name)
  closeCollectionConfigure()
}

function isAudioCardDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return Boolean(types?.includes('application/x-audio-id') || types?.includes('application/x-audio-ids'))
}

function onCollectionDragOver(collectionName: string, event: DragEvent): void {
  if (!isAudioCardDrag(event)) {
    return
  }
  event.preventDefault()
  dragOverCollectionName.value = collectionName
}

function onCollectionDragLeave(collectionName: string): void {
  if (dragOverCollectionName.value === collectionName) {
    dragOverCollectionName.value = null
  }
}

function onCollectionDrop(targetCollectionName: string, event: DragEvent): void {
  event.preventDefault()
  dragOverCollectionName.value = null
  const rawAudioIds = event.dataTransfer?.getData('application/x-audio-ids') ?? ''
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

    const audioId = event.dataTransfer?.getData('application/x-audio-id')
    return audioId ? [audioId] : []
  })()

  if (audioIds.length === 0) {
    return
  }
  emit('moveAudioToCollection', audioIds, targetCollectionName)
}
</script>

<template>
  <aside class="bg-slate-900/95 text-slate-100 p-4 rounded-2xl border border-slate-700 flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold tracking-wide">Soundboard</h2>
      <button
        class="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-900 font-semibold text-sm"
        @click="emit('connectFolder')"
      >
        Connect Folder
      </button>
    </div>

    <div class="text-xs text-slate-300 truncate">
      Root: {{ props.rootFolderName ?? 'Not connected' }}
    </div>

    <div class="space-y-2">
      <label class="text-xs uppercase tracking-wider text-slate-300">Create Collection</label>
      <input
        v-model="newCollectionName"
        class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
        placeholder="Collection name"
        @keydown.enter="onCreateCollection"
      />
      <button
        class="w-full px-3 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold text-sm"
        @click="onCreateCollection"
      >
        Add Collection
      </button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
      <div
        v-for="collection in props.collections"
        :key="collection.name"
        class="w-full p-3 rounded-lg border transition"
        :class="
          dragOverCollectionName === collection.name
            ? 'border-emerald-400 bg-emerald-500/10'
            : props.selectedCollectionName === collection.name
              ? 'border-sky-400 bg-slate-800'
              : 'border-slate-700 bg-slate-900/70 hover:bg-slate-800'
        "
        @dragover="(event) => onCollectionDragOver(collection.name, event)"
        @dragleave="onCollectionDragLeave(collection.name)"
        @drop="(event) => onCollectionDrop(collection.name, event)"
      >
        <div class="flex items-center justify-between gap-2">
          <button class="flex-1 min-w-0 text-left" @click="emit('selectCollection', collection.name)">
            <div class="min-w-0 flex items-center gap-2">
              <img
                v-if="props.collectionIconUrls[collection.name]"
                :src="props.collectionIconUrls[collection.name]"
                :alt="`${collection.title} icon`"
                class="h-6 w-6 rounded object-cover border border-slate-600 shrink-0"
              />
              <span class="font-medium truncate">{{ collection.title }}</span>
            </div>
            <span class="text-xs text-slate-300">{{ collection.audioFiles.length }} files</span>
          </button>
          <button
            class="shrink-0 px-2 py-1 rounded border border-slate-600 text-xs text-slate-200 hover:bg-slate-700"
            @click.stop="openCollectionConfigure(collection)"
          >
            Configure
          </button>
        </div>
      </div>
    </div>
  </aside>

  <div
    v-if="configuringCollection"
    class="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm p-4 flex items-center justify-center"
    @click.self="closeCollectionConfigure"
  >
    <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-4 space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold tracking-wide">Configure Collection</h3>
        <button class="text-xs text-slate-300 hover:text-slate-100" @click="closeCollectionConfigure">
          Close
        </button>
      </div>

      <div class="space-y-1">
        <label class="text-xs uppercase tracking-wider text-slate-300">Title</label>
        <input
          v-model="configuringCollectionTitle"
          type="text"
          class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-sm"
          placeholder="Collection title"
        />
      </div>

      <div class="space-y-2">
        <label class="text-xs uppercase tracking-wider text-slate-300">Icon</label>
        <div class="flex items-center gap-3">
          <img
            v-if="props.collectionIconUrls[configuringCollection.name] && configuringIconAction !== 'remove'"
            :src="props.collectionIconUrls[configuringCollection.name]"
            :alt="`${configuringCollection.title} icon`"
            class="h-10 w-10 rounded object-cover border border-slate-600"
          />
          <span v-else class="h-10 w-10 rounded border border-dashed border-slate-600 bg-slate-800" />
          <div class="min-w-0">
            <div class="text-xs text-slate-300 truncate">
              {{
                configuringIconFile
                  ? configuringIconFile.name
                  : configuringIconAction === 'remove'
                    ? 'Icon will be removed'
                    : 'Current icon'
              }}
            </div>
            <input type="file" accept="image/*" class="mt-1 text-xs text-slate-200" @change="onConfigureIconChange" />
          </div>
        </div>
        <button
          class="text-xs text-rose-300 hover:text-rose-200"
          :disabled="!props.collectionIconUrls[configuringCollection.name] && !configuringIconFile"
          @click="removeConfiguredCollectionIcon"
        >
          Remove icon
        </button>
      </div>

      <div class="pt-2 flex items-center justify-between gap-2">
        <button
          class="px-3 py-2 rounded-lg border border-rose-700 text-sm text-rose-200 hover:bg-rose-950/40"
          @click="destroyConfiguredCollection"
        >
          Destroy collection
        </button>

        <button
          class="px-3 py-2 rounded-lg border border-slate-600 text-sm text-slate-100 hover:bg-slate-800"
          @click="closeCollectionConfigure"
        >
          Cancel
        </button>
        <button
          class="px-3 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-900 font-semibold text-sm"
          @click="commitCollectionConfigure"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
