# Microsoft Store release (APP-11)

How a Meshkeep version gets from a git tag to the Store, and what is decided where.

## Build flavors

| Flavor | Command | Updater | Package | Audience |
|---|---|---|---|---|
| Dev | `npm run tauri:dev` / `npm run tauri:build` | no | plain exe | development |
| Private | `npm run tauri:build:updater` | yes (`updater` feature, `tauri.updater.conf.json`) | NSIS installer + `latest.json` on GitHub Releases | the author and testers |
| Store | `npm run tauri:build:store` + `msix/build-msix.ps1` | no (`store` feature) | MSIX | Microsoft Store |

The Store build never contains the updater (spec `04-quality.md`): the `updater` cargo
feature is simply not compiled in, so there is no code path to hide at runtime. The
settings page shows "Updates arrive through the Microsoft Store" for Store builds.

## Dev channel (fast local iteration)

`.github/workflows/dev-channel.yml` turns every push to `main` into installable,
self-updating Windows and macOS builds without a local toolchain. Working branches
(`claude/**`, `feat/**`, `fix/**`) run CI only: while they published too, the channel
flipped between the states of branches worked on side by side, and a build with an older
index schema discarded the newer index. A branch build can be published on purpose with
"Run workflow" on that branch. One job per platform, both from the same commit:

1. Builds with `--features updater,devtools` and the dev overlay
   (`src-tauri/tauri.updater.dev.conf.json`: dev endpoint, channel `dev`), versioned
   `<package.json version>-dev.<run number>` so every build is newer than the last and
   older than the next stable release. LTO is off for this job; it takes about half the
   time of a release build. Windows produces the NSIS installer, macOS the `.app` bundle
   packed as `Meshkeep.app.tar.gz` (Apple Silicon only; `macos-latest` is an arm64
   runner. A universal build would also cover Intel Macs at twice the compile time).
2. Signs the artifact with the updater key and publishes it, its `.sig` and the
   platform's feed to the rolling pre-release tagged **`dev`**
   (`.github/scripts/dev-channel-publish.sh`). The feed is per platform:
   `latest-windows.json` and `latest-darwin.json`, selected by the `{{target}}`
   placeholder in the updater endpoint, so each job only replaces its own assets and a
   failed build on one platform leaves the other platform's feed intact. The plain
   `latest.json` that dev builds from before the split (2026-10-21) read is no longer
   written since 2026-11-21, and the next publish removes the copy left on the release. A
   dev build that old and never updated has to be installed by hand once.
3. An installed dev build checks its feed once on startup and offers "Install and
   restart"; nothing installs without the click. Settings shows the channel badge and a
   manual check.

First install on Windows: download `Meshkeep_<version>_x64-setup.exe` from the `dev`
release once (SmartScreen warns because the installer is not code-signed; updates fetched
by the app do not trigger that prompt).

First install on macOS: download `Meshkeep.app.tar.gz`, unpack it and move `Meshkeep.app`
to Applications. The build is neither signed with a Developer ID nor notarized, so
Gatekeeper blocks the first launch (on macOS 15 the right-click "Open" workaround no
longer exists). Either open System Settings → Privacy & Security and click "Open Anyway"
below the message about Meshkeep, or clear the quarantine flag in a terminal:

```bash
xattr -d com.apple.quarantine /Applications/Meshkeep.app
```

Updates the app downloads itself carry no quarantine flag, so later dev builds install
without this step. Signing and notarization (Apple Developer Program, `APPLE_CERTIFICATE`,
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets consumed by
`tauri build`) remove the Gatekeeper step and are the planned follow-up; the Mac App Store
build (spec `04-quality.md`, APP-11) is a separate, sandboxed flavor and not what the dev
channel ships. The dev channel is also the first place the app is built on macOS at all;
CI (`ci.yml`) still builds and tests the real app on Windows only.

From then on, push and restart the app; the release body names the branch and commit the
build came from.

The stable channel uses `src-tauri/tauri.updater.conf.json` (`releases/latest`) and is
produced by `release.yml` on tags. Store builds have no updater at all.

## Pipeline

`.github/workflows/release.yml` runs on every `v*` tag:

0. **Identity gate.** Before anything is built, `msix/check-store-identity.ps1` checks the
   three repository variables with the Partner Center identity (below). A tag without
   them, or with a publisher that does not start with `CN=`, fails the run at once: the
   workflow used to fall back to the side-load identity and attach a "Store" MSIX that
   Partner Center rejects on upload. A manual run from a branch ("Run workflow") only warns
   and packs with the side-load identity, which is enough to try the pipeline. CI runs the
   gate's cases on every push (`msix/check-store-identity.test.ps1`).
1. **Private installer.** `tauri-apps/tauri-action` builds the NSIS installer. When the
   secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` exist, the
   build carries the updater and the action publishes `latest.json` plus `.sig` files next
   to the installer, which is exactly what the in-app "Check for updates" reads.
2. **Store flavor.** `npm run tauri:build:store`, then `msix/build-msix.ps1 -Store` packs an
   **unsigned** MSIX for Partner Center (the Store signs on submission) with the identity
   from the repository variables `MSIX_IDENTITY_NAME`, `MSIX_PUBLISHER`,
   `MSIX_PUBLISHER_DISPLAY_NAME`.
3. **Side-load check.** The same exe is packed and self-signed, installed with
   `Add-AppxPackage`, asked for an MCP answer through its app execution alias (see
   "Inside the package" below), launched through its AUMID, and removed
   (`msix/sideload-test.ps1`). CI does this on every push as well, so a broken manifest
   never reaches a release.
4. Both MSIX files are attached to the draft GitHub release.

## Inside the package

A packaged exe lives in `C:\Program Files\WindowsApps\<name>_<version>_x64__<id>\`. That
path carries the version, so it changes with every Store update, and it is not a path
other programs are meant to start. The MCP stdio bridge (`meshkeep --mcp`, ADR-0004) is
exactly that case: Claude Desktop and similar clients launch a command from a
configuration file the user pasted once.

The manifest therefore registers the app execution alias `meshkeep.exe`
(`uap3:AppExecutionAlias` in `msix/AppxManifest.xml`), which Windows keeps in
`%LOCALAPPDATA%\Microsoft\WindowsApps\` for as long as the app is installed. Settings
writes that alias into the client configuration when the app runs from a package and the
plain exe path otherwise (`mcp_bridge::client_command`, decided by the exe's own path).
`sideload-test.ps1` starts the bridge through the alias with pipes on stdin and stdout,
the way a client does, and expects a JSON-RPC answer. A user can switch aliases off under
Windows Settings → Apps → Advanced app settings → App execution aliases; then the bridge
is not reachable until it is switched back on.

## Icons

The icon is a castle keep built from flat facets, drawn three times in
`src/assets/brand/`: `keep-detail.svg` for 48 px and up, `keep-small.svg` for 20 to 47 px
(taller merlons, wider gate) and `keep-tiny.svg` below that (no gate; it is only a smudge
at 16 px). `npm run icons` (`scripts/generate-icons.mjs`) renders every raster file from
them with the Chromium the UI tests use and picks the drawing by the size of the artwork:

- `src-tauri/icons/`: window, installer and bundle icons (PNG, `icon.ico`, `icon.icns`).
- `msix/Assets/`: tiles in five scales (the unqualified name is the 100 % variant) and
  `Square44x44Logo.targetsize-*` in fourteen sizes, each also as `_altform-unplated` and
  `_altform-lightunplated` so the taskbar shows the shape itself instead of a plate in
  both themes. The folder holds generated files only and is rebuilt on every run.
- `site/assets/`: website logo, favicon and touch icon.

The generated files are committed; run the script after changing a drawing. The app
itself imports the SVGs (top bar, welcome page).

`msix/build-msix.ps1` builds `resources.pri` with `makepri` before packing. That index is
what lets Windows pick `scale-200` or `targetsize-24_altform-unplated` for the logical
name the manifest uses; without it only the 100 % files are ever shown. The script checks
that the index lists the qualified variants, and the side-load test that the installed
package contains it. How the icons look in the taskbar and Start menu at 100 % and 200 %,
in the light and the dark theme, still needs a look on a real machine.

## One-time setup

### Updater signing key (private builds)

Status: generated 2026-10-19 (minisign key id `0C7DD2E789BBD1C8`); the public key is in
both updater overlays, the private key and password are repository secrets
`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

To rotate: `npx tauri signer generate -w ~/.tauri/meshkeep.key`, paste the **public** key
into `src-tauri/tauri.updater.conf.json` and `tauri.updater.dev.conf.json`, replace the
secrets. Never commit the private key; losing it means every installed private build
has to be reinstalled by hand once.

### Partner Center identity (Store builds)

Status: account created and the name **Meshkeep** reserved (2026-10-19); the domain
**meshkeep.app** is registered for the website, support and privacy-policy URLs. The
product identity is known since 2026-11-23 (below).

1. ~~Create a Microsoft Partner Center developer account.~~ Done.
2. ~~Reserve the name "Meshkeep".~~ Done. Reservations last three months and are renewed
   by submitting.
3. Product management → Product identity shows three values. They go into the repository
   variables (Settings → Secrets and variables → Actions → Variables), exactly as shown:

   | Variable | Partner Center field | Value |
   |---|---|---|
   | `MSIX_IDENTITY_NAME` | `Package/Identity/Name` | `18031Medienstudio.net.Meshkeep` |
   | `MSIX_PUBLISHER` | `Package/Identity/Publisher` | `CN=0CEBA8FF-9F6C-4528-A24A-8C3F8C5E84E3` |
   | `MSIX_PUBLISHER_DISPLAY_NAME` | `Package/Properties/PublisherDisplayName` | `Medienstudio.net` |

   None of this is secret: every package that ships carries these values in its manifest.
   They are variables, not part of the manifest in the repository, so that side-load builds
   keep their own identity and can be installed next to the Store version.

   The Store ID of the product is `9P0BCR7295GS`. Once the first submission is live, the
   listing is at `https://apps.microsoft.com/detail/9P0BCR7295GS`, and
   `ms-windows-store://pdp/?productid=9P0BCR7295GS` opens it in the Store app. The website
   still says "in preparation"; that line becomes this link when the app is published.
4. Tag a release; upload `Meshkeep_<version>_x64_store.msix` from the release in the
   Packages step of the submission. Until step 3 is done, a tag fails in the identity gate
   and produces no release at all, the private installer included.

### Submission checklist

- Age rating questionnaire: no user-generated content, no purchases. Data collection by
  the publisher: none. Two optional features talk to third parties only on the user's
  action (AI assistance with the user's own API key; "Load model pages", off by default);
  a third, the local MCP server, accepts connections from programs on the same computer
  only, off by default (a connected program can trigger the AI assistance only behind a
  further switch, also off by default); all three are described on the privacy page,
  which is the answer to the privacy questions.
- Privacy policy URL: `https://meshkeep.app/privacy/` (EN) and
  `https://meshkeep.app/de/datenschutz/` (DE), served from `site/` by `pages.yml`.
  Website `https://meshkeep.app`, support `https://meshkeep.app/support/`.
- `runFullTrust` capability: the submission form asks for a reason. Text: "Desktop app
  that indexes user-selected folders of 3D model files; file access is limited to folders
  the user picks through the system dialog."
- Screenshots: at least one 1366×768 or larger PNG per listing language. Four per
  language are in `docs/store/screenshots/`, taken by `npm run screenshots`; see
  "Screenshots" in `docs/store/listing.md`.
- Icons: see "Icons" below. The listing's own logos (1:1 at 1080×1080 or 2160×2160,
  optionally 2:3 at 720×1080) are uploaded in Partner Center and are not part of the
  package; without them the Store shows the package icon.
- Listing texts in `docs/store/listing.md`, English and German, with the Store rules they
  have to keep at the top of that file: seven search terms at most and no other products'
  titles among them (policy 10.1.3).
- Generative AI (policy 11.16): the AI suggestions make the app a product with live
  generative AI content. The description discloses it, the submission declares it, and the
  notes for certification name the reporting path (Settings → Feedback, support page).
  Declaration and notes are in `docs/store/listing.md` under "Partner Center answers".

## Versioning

The MSIX version has four parts and must increase with every submission. The scripts use
`<package.json version>.0` by default; the release workflow derives it from the tag
(`v0.2.1` → `0.2.1.0`). Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and
`Cargo.toml` together before tagging.
