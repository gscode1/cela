import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";

/**
 * The image processor of a Host (docs/decisions/0055-fit-images.md): Photon (WebAssembly) in a worker thread, so a large
 * screenshot does not block the event loop that serves every session of the shard. Loaded at the first image, never at
 * start: a shard that never sees one pays nothing, and neither do the tests that load the Host. A load that failed is
 * tried again at the next image; the image of that call is left out with a note, the run goes on.
 */
export function lazyImageProcessor(
  create: () => Promise<ImageProcessor> = () => createNodePhotonImages(),
): ImageProcessor {
  let loading: Promise<ImageProcessor> | undefined;
  return {
    async prepare(bytes, mimeType, limits) {
      loading ??= create().catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
      return (await loading).prepare(bytes, mimeType, limits);
    },
  };
}
