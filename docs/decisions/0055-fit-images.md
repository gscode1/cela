# 0055: Fit images to the model's limits

Status: accepted, 2026-11-22. Follows [0053](0053-pi-1.6-upgrade.md) (its "Deferred" list) and [0007](0007-native-remote-mcp.md)
(MCP tools). Closes gscode1/cela#359.

## Context

An image a tool returns goes into the transcript as it came: a browser screenshot from an MCP server, or the image
`read` finds in the workspace. One that is larger than the model takes (dimensions, or 5 MB for Anthropic) or damaged is
rejected by the provider, and because it is in the transcript every later request of the session fails the same way.
Pi Durable 1.6.0 has the parts: `createFitImagesExtension(processor)` (`pi-durable/images/fit`), an `afterTool` hook that
fits the images of every result the model gets, MCP tools and code mode's `image()` included, to the limits of the
conversation's model (`imageLimits(model)`: its `inputLimits.images.resize`, else 2000 x 2000 px and 4.5 MiB of base64),
and a Photon (WebAssembly) `ImageProcessor` in `pi-durable/images/node`.

## Decision

- **One processor per Host**, `lazyImageProcessor` (`packages/orchestrator/src/images.ts`): `createNodePhotonImages()`,
  loaded at the first image, so a shard that sees none, and every test that opens a Host, loads no WebAssembly. It keeps
  Pi's default of a **worker thread**: preparing a 12-megapixel photo takes a second or two, and the orchestrator serves
  every session of the shard on one event loop. The worker exits 30 s after its last image, which frees Photon's memory
  (it never shrinks while the worker lives). A load that failed is tried again at the next image; that image is left out
  with a note and the run goes on.
- The processor is passed to `createCodingTools({ images })`, so `read` prepares the images it returns (and takes BMP),
  and to `createFitImagesExtension`. An image `read` already fitted comes back unchanged from the extension (it decodes
  it once more; nothing else changes).
- **Where the extension is installed: the pinned default `settings.extensions`, `[coding, fit-images]`.** Pi Durable
  selects a conversation's extensions at every start: the array `pi.agent` stores, else the host default
  (`settings.extensions`, which is not stored) edited by the stored `{ add, remove }`. Looked at against the four needs:
  - (a) New conversations, with or without MCP servers, get it: a profile with MCP servers stores `{ add: [tool-search,
    mcp-<name>] }`, an edit of the default, and the default has `fit-images`.
  - (b) A conversation created before this change stores no array and no `fit-images` either, so it gets the extension at
    the next start of the orchestrator, with no `configure()` and nothing written to its `pi.agent`. The test restarts the
    host over such storage.
  - (c) `capabilities()` lists `fit-images` in `extensions` (published for ingest, which checks profile **tools** and
    MCP names against it, never extension names).
  - (d) It has no tools, so `toolFilters`, the profile allow-lists, `modelTools` and the pre-resume `configure()` loop see
    no change; a profile that limits tools to `read` still offers exactly `read` and `tool_search`.
  - Adding it in `#agentFor` (`extensions.add`) fails (b): it would reach only conversations created afterwards, and
    editing stored agents at start (a loop like the tool filters) rewrites state that is the user's. Folding the hook into
    the coding extension is not possible without forking `createCodingTools`, and the coding tools' list is the allow-list
    vocabulary of profiles.
- Pi's `fit-images` order rule: hooks of extensions installed before it see the images unfitted. `coding` and the MCP
  extensions have no `afterTool` hooks, so nothing in cela does.

## Consequences

- What the model sees: the fitted image, and an `info` diagnostic (`code: "image"`) saying what changed (resized from
  W x H to w x h, or converted). An image that cannot be prepared (damaged, not a format providers take) is left out and
  the diagnostic says so; the call does not fail. The `[image]` marker in session events (`toEvent`) is unchanged.
- **Memory.** Decoding takes the image's RGBA size in WebAssembly memory inside the worker, for a 12-megapixel photo
  about 50 MB, until the worker exits. Size the orchestrator's memory limit for that
  burst (not measured here); there is no option to turn the processor off.
- **Operators.** Nothing to configure and no new image or native build: Photon is WebAssembly inside the existing
  dependency, so the `pi-orchestrator` image has the same layers. Rollback to an orchestrator without this change leaves
  fitted images in transcripts and fits no new ones. Models that declare `inputLimits.images.resize` get those limits.
- Images arriving as host input (`fitImage`/`fitImages` for a user's attachment) are not in scope: the session API takes
  text.
