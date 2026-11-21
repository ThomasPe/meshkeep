# ADR-0004: A local MCP server so an AI agent can work the library

- Status: **accepted** 2026-11-05
- Date: 2026-11-05
- Related: ADR-0003 (AI assistance, binding principles), META-7a (hints and model pages),
  IMP-1a (imports fill metadata), `spec/04-quality.md` (no network without the user).

## Context

ADR-0003 brought AI into the app as suggestions the user confirms one at a time. That is
the right shape for a click, and the wrong one for "please go through my 2,000 projects
and fill in what you can". Doing that well needs an agent that can plan, read, look things
up and write in a loop, with a conversation to steer it. Such agents exist on the user's
machine already (Claude Desktop, Claude Code, others), and they speak the Model Context
Protocol (MCP). Meshkeep does not need to run a model to let one work the library: it
needs to be an MCP server.

The user's words for the goal: let the AI enrich models with metadata as autonomously as
possible, add models (for example from the Downloads folder) and look up sources.

## Decision

Meshkeep exposes its engine as an MCP server, inside the running app.

1. **Transport.** The app listens on `127.0.0.1:<port>` (default 7340) and answers
   JSON-RPC over HTTP (the Streamable HTTP transport, POST only, JSON responses, no SSE,
   no session ids). The same executable started as `meshkeep --mcp [url] [token]` is a
   stdio bridge that forwards lines to that endpoint, for clients that only launch
   commands (Claude Desktop). The Store build registers the app execution alias
   `meshkeep.exe` for it, because the path of a packaged exe changes with every update
   (`docs/store/README.md`, "Inside the package"). One process owns the engine, the index and the watchers;
   the window sees every change an agent makes through the same events the commands
   emit.
2. **Access.** Off by default. Every request carries a bearer token the app mints when
   the server is first enabled (shown, copyable and replaceable in Settings). Requests
   with a browser `Origin` that is not this machine are refused, so no web page can
   reach the port. The token lives in `settings.json`, like the AI endpoint; it is not a
   secret from the user, it is a secret from everything else on the machine.
3. **Two switches.** "Run the MCP server" exposes reading tools only: roots, search
   (with a `missing` filter for the fields an agent should fill), project details with
   hints, readme text, model pages (behind the existing "Load model pages" setting),
   creator suggestions, inbox, duplicates, collections, and listing the import folders.
   "Allow writes" adds the writing tools: metadata (single and batch), imports,
   promoting inbox files, rename, move, favorites, collections, moving files between
   projects and removing folders left empty. No tool deletes a file behind these two
   switches; deleting has its own switch (amendment below).
4. **Import folders.** The only paths outside the libraries an agent may list or import
   from are the folders the user names in Settings (Downloads with one click). Paths are
   canonicalised before the check, so `..` and links cannot leave them.
5. **Engine owns the protocol.** `crates/engine/src/mcp.rs` turns a JSON-RPC value into a
   result and a list of changes; the shell adds the socket, the token check and the
   events. Every tool is tested without a socket; the socket is tested once.
6. **What leaves the machine** is the client's business, not the server's, and the
   Settings card says so in plain words: the tools return project metadata, file names,
   readme text, the listed import folders and (with the setting on) what model pages say;
   where the connected client sends that depends on the client. The privacy policy carries
   the same paragraph. Meshkeep still makes no network request of its own for this.

## Consequences

- ADR-0003's "suggestions, never silent writes" does not hold for an agent with writes
  allowed: that is the point of the switch, and why it is separate and off by default.
  The agent writes through the same paths the UI uses (`update_metadata` with the sidecar
  stamp, the import pipeline, rename, move), so conflicts and validation behave the same.
- A client with a kept-alive connection outlives "stop" until it gives up on it (the
  server library closes only on the request's own `Connection: close`); the bridge sends
  that header, a stopped server refuses new connections at once.
- The port is fixed per settings, so two users on one machine would collide; acceptable
  for a desktop app, the status line shows the bind error.
- MCP evolves; the server states protocol version 2025-06-18 and ignores what it does
  not implement (resources, sampling, elicitation). A client that needs SSE streaming
  gets 405 on GET and keeps working over POST.
- The feature is not Store-relevant beyond the privacy text: no new capability, no new
  outbound connection.

## Amendment 2026-11-07: deleting, behind a third switch (#57)

An agent that finds duplicates and reorganises a library could not finish the job: the
last step, removing a duplicate or a project, always fell back to the user. So:

- **A third switch "Allow deleting (to the trash)"**, off by default, only available while
  "Allow writes" is on, and turned off with it. It adds `delete_file`, `delete_project`,
  `resolve_duplicates` (keep one project, trash the members it fully covers, what the
  Duplicates view's "keep" does) and `remove_shared_files` (thin a collection out: trash
  the files that also exist in other projects). Everything goes through the trash deleter
  (IMP-5), nothing is removed permanently, `project.yaml` and the library root are refused.
- **Behind "Allow writes"** two tools that involve no deletion: `move_files` (take files
  out of a project into an existing or new project folder) and `remove_empty_folders`
  (folders with nothing at all in them, deepest first; a single remaining file keeps a
  folder, so do the root, the inbox and the app's folders).
- **Common rules:** every one of these takes `dry_run` and returns the paths it would
  touch; the index, collections and favorites follow in the same call; the usual change
  events reach the window. `find_duplicates` now lists each member's shared files with
  the projects that also hold them, so an agent can decide between the two resolutions.

## Amendment 2026-11-07: library conventions reach the agent (#58)

Many choices an agent makes while sorting a library are the owner's to make (where single
creators go, which license to use when the page is unclear, how tags are spelled), and
without written rules every session chooses differently. Each root may now carry
`.meshkeep/conventions.yaml` (edited in Settings, the file is the source of truth, it
travels with the folder): a layout pattern, title cleanups, tag format, allowed licenses,
a duplicate policy and free-text notes. The engine enforces the structured part
(`check_conventions` lists deviations, `organize` fixes folders, titles and tags, tag rules
apply on every metadata write) and reports a malformed file instead of ignoring it. The
MCP server appends the conventions of every root to the `initialize` instructions and
offers `get_conventions` and `check_conventions` as reading tools and `organize` behind
"Allow writes". Open questions from the issue, decided: no defaults without a file (a
starter set is one click away in Settings); `organize` lives behind "Allow writes" only,
the window shows the deviations and leaves fixing to an agent for now; placeholders stay
at `{creator}` and `{title}` until a case asks for more.

## Amendment 2026-11-09: packed projects (LIB-9)

`execute_import` takes the action `packed` for zip archives (the archive goes into the
project unextracted), and two tools behind "Allow writes" change how a project is stored:
`pack_projects` (loose models into `<folder>.zip`, verified, loose copies to the trash) and
`unpack_projects` (extract again, the zip to the trash unless kept). Both take `dry_run`.
They use the trash but lose no content, which is why they sit with the writing tools and
not behind "Allow deleting". `get_project` reports `packed` and lists archive entries as
`<archive>/<path>`; `read_project_file` reads them; `move_files`, `delete_file` and
`remove_shared_files` refuse them and say to unpack first.

## Amendment 2026-11-20: resources for clients that browse (#100)

Some clients do not call tools on their own; they show the user what a server offers and
attach what the user picks. For them every project is now a resource:

- `meshkeep://project/{id}`: the project as JSON, the same view `get_project` returns,
  plus the URIs of its preview and of its text files.
- `meshkeep://project/{id}/file/{+path}`: a text file of the project, under the limits of
  `read_project_file` (256 KiB, text only, packed entries included).
- `meshkeep://project/{id}/thumbnail`: the cached preview as PNG, when one was rendered.

`resources/list` pages through the projects by title (100 per page, the cursor is opaque
to the client), `resources/templates/list` names the three forms, `resources/read` answers
them and reports an unknown URI with MCP's code -32002. The id is a single path segment,
so its `:` and `/` are percent-encoded; an unencoded id is understood as long as it names a
project. No subscriptions and no list-changed notifications: the server stays stateless.

Resources only read, so they sit behind the token and the first switch like the reading
tools. The preview picture is the one thing they add to what an agent can see; the
Settings card and the privacy policy name it.

## Amendment 2026-11-20: the in-app AI suggestion as a tool (#101)

An agent that cannot see pictures has no use for a project's preview, and for many
downloads the preview is the only thing that says what the model is. The app already has
an assistant that looks at it (ADR-0003). `suggest_metadata` runs that assistant for one
project and returns its proposal: title, creator, license, description, tags, and what was
sent for it.

- **A switch of its own, "Allow AI suggestions", off by default.** It is the one tool that
  makes the app itself call out, and it spends the user's key; neither follows from
  "Run the MCP server" or from having stored a key for the window. It does not depend on
  "Allow writes": the tool writes nothing.
- **ADR-0003 holds on this path.** No key, no request (the same gate, `Engine::ai_provider`);
  the inputs are the documented ones and no others; the answer is validated by the engine
  and cached like any other; nothing is written. An agent that wants a proposal in
  `project.yaml` writes it with `update_metadata`, behind "Allow writes". Principle 1
  allows a call that is not a click when it is "a job the user switched on in settings
  with a visible scope": the switch is that setting, and its text says what each request
  sends and where.
- **The key stays in the shell.** The engine asks for it through `mcp::Session::ai_key`
  when a suggestion is requested and passes it to the provider; it is not stored, logged
  or returned.
- **The provider is called outside the engine lock.** `mcp::handle_with` returns the
  request as `Outcome::deferred`; the host releases the engine and then finishes it, as
  the window's own command does, so the library stays usable while a model thinks.

Point 6 of the decision ("Meshkeep still makes no network request of its own for this")
now has this one exception, and the Settings card and the privacy policy state it.

## Amendment 2026-11-20: progress for long tools (#102)

Hashing a large library, an import that reads model pages at one request per second and
packing many projects take minutes, and a client saw nothing until the answer. The
protocol has a way to say how far a request is: the client puts a `progressToken` into
`params._meta`, the server sends `notifications/progress` with that token while it works.

- **What reports.** `find_duplicates` (and the hashing inside `resolve_duplicates` and
  `remove_shared_files`) in files; `execute_import` in items, counted a second time when
  the metadata step follows; `pack_projects` and `unpack_projects` in projects, the files
  of the one in work as its fraction; `scan_root` in projects found, without a total. Each
  notification carries a one-line message. Values only rise, and at most four are sent
  per second, the last step always.
- **Transport.** The decision above said "POST only, JSON responses, no SSE". That holds
  for every request except this one case: a single `tools/call` with a progress token, from
  a client whose `Accept` lists `text/event-stream`, is answered on the same POST as a
  stream of server-sent events, the notifications as they happen and the response as the
  last event; then the stream ends. This is the Streamable HTTP transport as specified,
  and still stateless: no session, no `GET` stream, nothing sent outside a running
  request. A client that sends no token or does not accept a stream gets JSON as before.
- **The host writes that response by hand** (chunked, one flushed chunk per event),
  because the HTTP library sends a body only when it is complete.
- **The stdio bridge** accepts a stream and writes each message of it as its own line as
  it arrives, so in `--mcp` mode progress reaches the client as protocol notifications
  and nothing else touches stdout. A stream that ends before the answer becomes a JSON-RPC
  error for that request.
- **Who decides.** `mcp::wants_progress` tells the host whether to open a stream; the
  engine builds the notifications and the host only delivers them (`Session::notify`).
  Inside a batch no progress is sent.

Not part of this: cancelling a running tool (`notifications/cancelled` is ignored; the
tool finishes and its answer is dropped by the client).

## Amendment 2026-11-20: a journal of what agents changed (#103)

With writes allowed an agent changes projects without the user watching, and afterwards
there was no place to see what it did. The window now has one: Settings → "What agents
changed" lists every writing or deleting tool call that changed something, newest first,
with the tool, the time, the projects it touched (as links) and the arguments the agent
sent.

- **The journal** is `<app data>/mcp-audit.jsonl`, one JSON line per call, written by
  `mcp.rs` after the tool returned (`audit.rs`). Recorded: calls behind "Allow writes" or
  "Allow deleting" that succeeded and changed something. Not recorded: reading tools, dry
  runs, refused and failed calls, calls that found nothing to do. A call that failed in
  part is recorded with the number of failed items.
- **Projects are named as they were when the tool ran**, because ids change with a rename
  or a move and a deleted project has no title afterwards; a rename or move is recorded
  under the new id, so the link still leads there. At most 50 projects per entry are
  named, the count is kept; long argument lists and texts are shortened.
- **It is app data**, like the index: never inside a library, trimmed to its newer half
  beyond 2 MiB, cleared by the user from the card. A journal that cannot be written is
  logged and does not fail the change.
- **It is a record, not an undo log.** The backlog planned this view on top of the undo
  log of APP-6, so that a change can be inspected and taken back in the same place. APP-6
  does not exist yet and inspecting does not need it, so the record comes first, in a
  form undo can attach to: when APP-6 defines inverse operations, an entry here is where
  an agent's change gets its "take back". Until then the card says that it cannot take a
  change back and where a deleted file went (the trash).

## Amendment 2026-11-21: a settings change keeps the server up

The host restarted the server for every change of the MCP settings. The switches never
needed that (the engine reads them with every request), and the restart raced the old
listener, which the HTTP library closes on its own thread a moment after it is told to
stop: binding the same port again right away failed with "address in use", and the server
stayed down until the next change. Found by the real-app test of the amendments above,
where "Allow writes" took the server away.

Now a server that already listens on the configured port stays up; a new token is swapped
in place and holds from the next request. Only another port moves the server, and a start
on a port this host gave up within the last two seconds (off and on again) retries until
the old listener is gone. With no restart on a switch, the kept-alive connection named
under "Consequences" only matters when the server is stopped or moved.
