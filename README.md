# Meshkeep

A local-first desktop library manager for 3D printing models (STL, OBJ, 3MF): browse,
preview, tag and organize the models on your own disks, Lightroom-style. No account, no
cloud, no telemetry; your metadata lives in a small `project.yaml` next to your files.

Website: [meshkeep.app](https://meshkeep.app) · Download: [dev channel](https://github.com/ThomasPe/meshkeep/releases/tag/dev)

## Status

Phase 1 (the MVP) is complete and most of Phase 2 has landed. Every push to `main`
publishes self-updating dev builds for Windows (x64) and macOS (Apple Silicon); neither is
code-signed yet. The Microsoft Store build and its pipeline are ready, the first submission
still needs the Partner Center identity values and screenshots
([`docs/store/README.md`](docs/store/README.md)). Windows is the first-class platform:
CI builds and tests the real app there.

## What works today

**Library**

- library folders on local disks, network shares and external drives; watch, poll or manual
  sync; offline folders keep their projects
- read-only scanning: nothing is written until you edit something, then `project.yaml` is
  created and saved atomically with conflict detection
- packed projects: a zip download can stay a zip, the app reads models, previews and
  duplicates straight from it; pack and unpack any project on request
- duplicate detection by model-file content, with a view to keep one copy
- library conventions per folder (`.meshkeep/conventions.yaml`): layout, title cleanups, tag
  format, allowed licenses, with a deviation check

**Browsing**

- virtualized grid and list, full-text search, filters by tag, folder, creator, license,
  material and file type
- favorites, recent additions, collections and smart collections (saved searches)
- sidebar with folder tree, clickable breadcrumbs, multi-selection with batch actions and
  keyboard shortcuts for the common ones

**Preview**

- rendered thumbnails for STL, OBJ and 3MF in a background queue, one per model file;
  embedded slicer previews and model pictures from 3MF files
- a 3D viewer with progressive loading and 3MF colours (materials, Bambu/Orca and
  PrusaSlicer painting), an image viewer
- choose the preview yourself: any project image, or the current view in the viewer

**Import and file operations**

- import with a review step (zip, 7z, folders, loose files, drag and drop), an inbox per
  library folder for loose files
- rename, move between folders (with undo) and delete to the Recycle Bin / Trash

**Metadata**

- tags, creator, license, source link and printing notes, edited one project at a time or
  across a selection
- local hints for creator, license and source link from 3MF metadata, readmes, download
  shortcuts and file names
- optional, off by default: load the model page a project came from (Printables,
  Thingiverse, Thangs, MakerWorld) to fill in metadata and the cover picture, for one
  project or a whole selection
- optional, with your own API key: AI metadata suggestions that you review field by field;
  model geometry never leaves the machine
  ([ADR-0003](docs/decisions/0003-ai-integration.md))

**For AI agents**

- an MCP server for agents on the same machine (Claude Desktop, Claude Code): off by
  default, token-protected, read-only unless writes and deletes are allowed separately;
  agents can search, fill in metadata, import, tidy up duplicates and reorganize along the
  library conventions ([ADR-0004](docs/decisions/0004-mcp-server.md))

**App**

- settings for sync, ignore patterns, bundle folders, preview location, notifications,
  theme and language (English, German)
- self-updater in private builds, none in the Microsoft Store build
- feedback from inside the app: bug reports and ideas open as prefilled GitHub issues with
  version and system info, nothing is sent in the background

Still open, among others: drag-out to other applications, a configurable keymap, general
undo/redo, project tabs, a dashboard and a log viewer. The full list with requirement IDs
is in [`docs/backlog.md`](docs/backlog.md).

## Install

Download from the [`dev` pre-release](https://github.com/ThomasPe/meshkeep/releases/tag/dev);
installed builds update themselves from there.

- **Windows:** run `Meshkeep_<version>_x64-setup.exe`. SmartScreen warns once because the
  installer is not code-signed.
- **macOS (Apple Silicon):** unpack `Meshkeep.app.tar.gz` and move `Meshkeep.app` to
  Applications. The build is not notarized, so allow the first launch under System
  Settings → Privacy & Security ("Open Anyway").

## Development

Built on **Tauri 2 + Rust** with a **React 19 / TypeScript / Tailwind 4 / shadcn-style**
frontend. You need Node 22, a stable Rust toolchain and, on Windows, the MSVC Build Tools.

```bash
npm ci
npm run tauri:dev     # the app with hot reload
npm run dev           # frontend only, in the browser with a mock backend (http://localhost:1420)
```

```bash
cargo test                                         # engine and shell
npm run typecheck && npm run lint && npm test      # frontend
npx vite build && npm run test:ui                  # Playwright UI tests against the mock backend
npm run tauri:build:e2e && npm run test:e2e        # WebdriverIO against the real app
```

| Path | Content |
|---|---|
| `crates/engine` | The shell-agnostic Rust engine: scanner, sidecars, SQLite index, watcher, import, thumbnails, MCP tools |
| `src-tauri` | Tauri shell: commands, events, MCP endpoint, updater, credential store |
| `src` | React frontend |
| `tests` | Vitest unit tests, Playwright UI tests, WebdriverIO E2E |
| `fixtures` | Deterministic sample library and import bundles for tests |
| `msix`, `docs/store` | Microsoft Store packaging and release pipeline |
| `site` | The website at meshkeep.app (GitHub Pages) |
| `spike` | The Tauri de-risking spike from Phase 0, kept as reference |

Rules, conventions and the definition of done for humans and coding agents are in
[`AGENTS.md`](AGENTS.md).

## Documentation

- Specification: [`docs/`](docs/README.md), starting with
  [`docs/spec/01-vision.md`](docs/spec/01-vision.md)
- Backlog: [`docs/backlog.md`](docs/backlog.md)
- Decisions: [tech stack](docs/decisions/0001-tech-stack.md) (Tauri 2 with a Rust engine),
  [UI framework and visual direction](docs/decisions/0002-ui-framework.md) (shadcn/ui on
  Tailwind 4, direction "Gallery"), [AI assistance](docs/decisions/0003-ai-integration.md),
  [MCP server](docs/decisions/0004-mcp-server.md)
- Answered product questions: [`docs/open-questions.md`](docs/open-questions.md)
- The previous Electron/React implementation is preserved on the
  [`archive/electron-v1`](https://github.com/ThomasPe/meshkeep/tree/archive/electron-v1)
  branch.

## License

Meshkeep is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE): read it, build it, use it and change it
for any noncommercial purpose. Selling the app or offering it commercially is reserved to
the copyright holder; the Microsoft Store release is distributed under its own terms.
Keep the [`NOTICE`](NOTICE) file with every copy. Contributions are welcome under the
rights grant in [`CONTRIBUTING.md`](CONTRIBUTING.md).
"Meshkeep" is the name of this project and is not covered by the license.
