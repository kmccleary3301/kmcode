import { serveMarkdownWorker } from "@stream-mdx/worker/engine";
import { createKmMarkdownExtensions, KM_MARKDOWN_EXTENSION_ID } from "./kmMarkdownExtensions";

serveMarkdownWorker({
  extensions: createKmMarkdownExtensions(),
  extensionId: KM_MARKDOWN_EXTENSION_ID,
});
