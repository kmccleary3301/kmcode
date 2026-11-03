import type { ToolActivityIcon, ToolActivitySource } from "@t3tools/contracts";

import { parseToolDeviceArguments, parseToolDeviceName } from "@t3tools/shared/toolDevice";

import { mcpToolPresentation } from "../../provider/McpToolPresentation.ts";
import { piRecordNumber, piRecordString } from "./PiRpc.ts";

export type PiToolTurnItemFields =
  | {
      readonly type: "command_execution";
      readonly title: string;
      readonly intent?: string;
      readonly input: string;
      readonly output?: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: "file_change";
      readonly title: string;
      readonly intent?: string;
      readonly fileName: string;
      readonly diffStr?: string;
      readonly oldStr?: string;
      readonly newStr?: string;
      readonly additions?: number;
      readonly deletions?: number;
    }
  | {
      readonly type: "dynamic_tool";
      readonly title: string;
      readonly intent?: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output?: string;
      readonly details?: unknown;
      readonly toolIcon?: ToolActivityIcon;
      readonly toolSource?: ToolActivitySource;
    };

/** Turn-item fields for one Pi tool call, shared by live turns and native-history import. */
export function piToolTurnItemFields(input: {
  readonly toolName: string;
  readonly args: unknown;
  readonly outputText: string;
  /** The tool result's `details` record. */
  readonly details: unknown;
  readonly isError: boolean;
  /** OMP lifts the `i` argument out of a call it executes and reports it beside the call. */
  readonly intent?: string | undefined;
}): PiToolTurnItemFields {
  const { toolName, args, outputText } = input;
  const intent =
    input.intent?.trim() ||
    piRecordString(args, "i")?.trim() ||
    piRecordString(args, "_i")?.trim() ||
    undefined;
  const output = outputText.length > 0 ? { output: outputText } : {};
  if (toolName === "bash") {
    const exitCode = piRecordNumber(input.details, "exitCode");
    return {
      title: toolName,
      ...(intent === undefined ? {} : { intent }),
      type: "command_execution",
      input: piRecordString(args, "command") ?? "",
      ...output,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
  // Writes to OMP's xd:// tool devices invoke the mounted tool, not a file edit.
  const deviceTool =
    toolName === "write"
      ? parseToolDeviceName(piRecordString(args, "path") ?? "")
      : undefined;
  if (deviceTool !== undefined) {
    return {
      title: deviceTool,
      ...(intent === undefined ? {} : { intent }),
      type: "dynamic_tool",
      ...mcpToolPresentation({ toolName: deviceTool }),
      toolName: deviceTool,
      input: parseToolDeviceArguments(piRecordString(args, "content")),
      ...output,
      ...(input.details === undefined ? {} : { details: input.details }),
    };
  }
  if (toolName === "edit" || toolName === "write") {
    const fileName = piRecordString(args, "path") ?? piRecordString(args, "file_path");
    if (fileName !== undefined) {
      // edit reports a unified patch in its result details; write only
      // carries the new content in its args. A failed call keeps its error.
      const patch = input.isError ? undefined : piRecordString(input.details, "patch");
      // Until that patch exists (the model is still streaming the call, or the
      // tool ran), the arguments describe the change: patch mode sends hunks
      // per entry, replace mode sends the old and new text.
      const argEdits =
        typeof args === "object" && args !== null && "edits" in args && Array.isArray(args.edits)
          ? args.edits
          : [];
      const argPatch = argEdits
        .flatMap((entry) => {
          const diff = piRecordString(entry, "diff");
          return diff === undefined ? [] : [diff];
        })
        .join("\n");
      const diffStr =
        patch ??
        (input.isError
          ? outputText.trim().length > 0
            ? outputText
            : undefined
          : argPatch.length > 0
            ? argPatch
            : undefined);
      const writeContent = toolName === "write" ? piRecordString(args, "content") : undefined;
      const oldStr =
        toolName === "edit"
          ? (piRecordString(args, "old_string") ?? piRecordString(args, "oldText"))
          : undefined;
      const newStr =
        writeContent ??
        (toolName === "edit"
          ? (piRecordString(args, "new_string") ?? piRecordString(args, "newText"))
          : undefined);
      // The wire drops patch bodies, so clients size the edit from these counts.
      let additions = 0;
      let deletions = 0;
      if (patch !== undefined) {
        let inHunk = false;
        for (const line of patch.split("\n")) {
          if (line.startsWith("@@")) inHunk = true;
          else if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue;
          else if (line.startsWith("+")) additions += 1;
          else if (line.startsWith("-")) deletions += 1;
        }
      } else if (writeContent !== undefined && !input.isError) {
        additions =
          writeContent.length === 0 ? 0 : writeContent.replace(/\r?\n$/, "").split("\n").length;
      }
      const counted = patch !== undefined || (writeContent !== undefined && !input.isError);
      return {
        title: toolName,
        ...(intent === undefined ? {} : { intent }),
        type: "file_change",
        fileName,
        ...(diffStr === undefined ? {} : { diffStr }),
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(counted ? { additions, deletions } : {}),
      };
    }
  }
  // A read from xd:// is a tool-documentation lookup. Keep its `read` identity
  // and URI input so the presentation layer can distinguish it from a tool call.
  return {
    title: toolName,
    type: "dynamic_tool",
    ...(intent === undefined ? {} : { intent }),
    ...mcpToolPresentation({ toolName }),
    toolName,
    input: args ?? {},
    ...output,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

