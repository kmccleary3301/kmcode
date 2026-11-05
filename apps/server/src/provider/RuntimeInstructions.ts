const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

const APERTURE_INSTRUCTIONS = `<aperture>
Aperture is connected. For experiment charts or run data: call aperture_status, read aperture_guide before writing a widget or figure spec, and state only numbers from aperture_query.
</aperture>`;

/**
 * KM Code turns a Markdown link to an absolute path into a file chip that opens
 * on the host. `~`, bare names, and paths relative to some other directory
 * often resolve wrong or not at all, and a slash-led code span such as a route
 * becomes a broken chip.
 */
const FILE_LINK_INSTRUCTIONS = `<file_links>
Write every file you mention as a Markdown link to its absolute path, labelled with its name or repo path: [REVIEW.md](/home/me/qc/REVIEW.md), [src/app.ts:42](/home/me/repo/src/app.ts:42). Never use ~, a bare filename, or a relative path; only those links open. Keep code spans for code and commands, and give a non-file path context, like \`GET /favicon.ico\`.
</file_links>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly aperture?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in KM Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${FILE_LINK_INSTRUCTIONS}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${
    runtime.aperture ? `\n\n${APERTURE_INSTRUCTIONS}` : ""
  }`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
