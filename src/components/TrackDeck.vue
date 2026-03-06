<script setup lang="ts">
import { ref } from 'vue'
import type { ActiveTrack, AudioFileEntry } from '@/types/soundboard'

const props = defineProps<{
  activeTracks: ActiveTrack[]
  allAudioFiles: AudioFileEntry[]
  globalVolume: number
}>()

const emit = defineEmits<{
  playAudio: [audio: AudioFileEntry]
  playSuperAudio: [audioIds: string[]]
  stopTrack: [trackId: string]
  skipSuperTrack: [trackId: string]
  stopAll: []
  updateTrackVolume: [trackId: string, volume: number]
  updateGlobalVolume: [volume: number]
}>()

const isDropOver = ref(false)

function onDrop(event: DragEvent): void {
  event.preventDefault()
  isDropOver.value = false

  const rawAudioIds = event.dataTransfer?.getData('application/x-audio-ids') ?? ''
  const audioIds = (() => {
    if (!rawAudioIds) {
      return [] as string[]
    }
    try {
      const parsed = JSON.parse(rawAudioIds)
      if (!Array.isArray(parsed)) {
        return [] as string[]
      }
      return parsed.filter((audioId): audioId is string => typeof audioId === 'string' && audioId.length > 0)
    } catch {
      return [] as string[]
    }
  })()

  if (audioIds.length > 1) {
    emit('playSuperAudio', audioIds)
    return
  }

  const audioId = audioIds[0] ?? event.dataTransfer?.getData('application/x-audio-id')
  if (!audioId) {
    return
  }

  const audio = props.allAudioFiles.find((item) => item.id === audioId)
  if (audio) {
    emit('playAudio', audio)
  }
}

function onDragOver(event: DragEvent): void {
  event.preventDefault()
  isDropOver.value = true
}

function onDragLeave(): void {
  isDropOver.value = false
}

function onTrackVolumeInput(trackId: string, event: Event): void {
  const input = event.target as HTMLInputElement
  emit('updateTrackVolume', trackId, Number(input.value))
}

function onGlobalVolumeInput(event: Event): void {
  const input = event.target as HTMLInputElement
  emit('updateGlobalVolume', Number(input.value))
}

function formatSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return 0
  }
  return Math.max(0, Math.floor(seconds))
}
</script>

<template>
  <section
    class="rounded-2xl border p-4 bg-slate-950/90"
    :class="isDropOver ? 'border-cyan-400' : 'border-slate-700'"
    @drop="onDrop"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
  >
    <header class="flex items-center justify-between mb-3">
      <div>
        <h3 class="text-slate-100 text-lg font-semibold">Active Tracks</h3>
        <p class="text-xs text-slate-300">Drop cards here or click audio to play.</p>
      </div>
      <button
        class="px-3 py-2 rounded-lg text-sm font-semibold bg-rose-500 hover:bg-rose-400 text-slate-950"
        :disabled="props.activeTracks.length === 0"
        @click="emit('stopAll')"
      >
        Stop All
      </button>
    </header>

    <div class="mb-3 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2">
      <label class="flex items-center justify-between text-xs text-slate-300 mb-1">
        <span>Global Volume</span>
        <span>{{ props.globalVolume }}%</span>
      </label>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        class="w-full accent-sky-400"
        :value="props.globalVolume"
        @input="onGlobalVolumeInput"
      />
    </div>
    <hr class="my-3 border-slate-700" />
    <div class="space-y-2">
      <article
        v-for="track in props.activeTracks"
        :key="track.id"
        class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
      >
        <div class="mb-2">
          <div>
            <div class="text-sm text-slate-100 truncate w-[80%] block">{{ track.title }}</div>
            <div class="text-[11px] uppercase text-slate-400">{{ track.category }}</div>
            <div
              v-if="track.isSuperTrack"
              class="text-[11px] text-cyan-300 mt-1"
            >
              {{ track.superTrackPosition ?? 1 }}/{{ track.superTrackTotal ?? 1 }}:
              {{ track.superTrackCurrentTitle ?? 'Loading…' }}
            </div>
            <div class="text-[11px] text-slate-300 mt-1">
              {{ formatSeconds(track.currentSeconds) }}s / {{ formatSeconds(track.totalSeconds) }}s
            </div>
          </div>
        </div>
        <div class="mb-2">
          <label class="mt-2 flex items-center justify-between text-xs text-slate-300 mb-1">
            <span>Track Volume</span>
            <span>{{ track.volume }}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            class="w-full accent-cyan-400"
            :value="track.volume"
            @input="(event) => onTrackVolumeInput(track.id, event)"
          />
        </div>
        <div class="flex items-center justify-between gap-2">
          <button
            v-if="track.isSuperTrack"
            class="px-2 py-1 rounded-md bg-cyan-600/80 hover:bg-cyan-500 text-sm text-slate-100"
            :disabled="(track.superTrackPosition ?? 1) >= (track.superTrackTotal ?? 1)"
            @click="emit('skipSuperTrack', track.id)"
          >
            Next Track
          </button>
          <button
            class="block px-2 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-sm text-slate-100"
            :class="track.isSuperTrack ? 'flex-1' : 'w-full'"
            @click="emit('stopTrack', track.id)"
          >
            Stop
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
