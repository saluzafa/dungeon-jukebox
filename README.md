# Dungeon Jukebox UI

Local-first soundboard UI for organizing and playing audio files from your own filesystem.

The app uses the browser File System Access API to work directly with a folder you choose (read/write), so collections, audio files, and metadata live on disk instead of a remote backend.

## Features

- Collection management (create, rename title, set/remove icon, delete).
- Audio import and organization by directory.
- Drag-and-drop for:
  - moving audio between folders in a collection,
  - moving audio between collections,
  - starting playback by dropping audio onto the track deck.
- Search across all collections.
- Multi-select audio cards (`Ctrl/Cmd` toggle, `Shift` range select).
- Per-audio metadata editing:
  - display title,
  - category (`music`, `effect`, `sound`),
  - volume,
  - trim start/end,
  - infinite loop,
  - icon image.
- Active track deck with per-track volume and global volume.
- "Play Random" from the currently displayed results.
- Hash-based view state (`#collection` / `#collection=<name>&dir=<path>`) so collection/folder context is shareable/restorable.
- Last selected root folder persisted in IndexedDB and restored on next load (with permission).

## Browser Requirements

This project requires the File System Access API. Use a Chromium-based browser (Chrome, Edge, Brave, Arc, etc.) for full support.

If the API is unavailable, the app cannot connect to a local folder.

## Supported Audio Formats

- `.mp3`
- `.wav`
- `.ogg`
- `.m4a`
- `.aac`
- `.flac`

## Getting Started

### Prerequisites

- Node.js `^20.19.0` or `>=22.12.0`
- npm

### Install

```sh
npm install
```

### Run Development Server

```sh
npm run dev
```

### Build for Production

```sh
npm run build
```

### Preview Production Build

```sh
npm run preview
```

## NPM Scripts

- `npm run dev` - start Vite dev server
- `npm run type-check` - run `vue-tsc`
- `npm run build` - type-check and build
- `npm run build-only` - build without type-check gate
- `npm run preview` - preview built app

## Local Folder Layout

After connecting a root folder, the app reads/writes this structure:

```text
<root>/
  collections/
    <collection-name>/
      collection.json
      collection-icon.<ext>              # optional
      audio_files/
        <audio-file>.<ext>
        <audio-file>.<ext>.json          # metadata
        <audio-file>.<ext>.icon.<ext>    # optional icon
        <subfolder>/
          ...
```

Notes:

- `collection.json` stores collection title and icon filename.
- Each imported audio file gets a sibling metadata JSON file.
- Audio and icon moves preserve metadata and avoid collisions with auto-renamed targets.

## Audio Metadata Schema

Each `<audio-file>.<ext>.json` contains:

```json
{
  "title": null,
  "iconImage": null,
  "category": "sound",
  "infiniteLoop": false,
  "trimStart": null,
  "trimEnd": null,
  "volume": 100
}
```

## Tech Stack

- Vue 3 + TypeScript
- Vite 7
- Tailwind CSS 4

## Development Notes

- The app is intentionally local-first; no backend services are required.
- Folder access is permission-based. If restore fails, reconnect the folder from the sidebar.
