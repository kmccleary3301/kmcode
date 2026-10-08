import type { ToolActivityIcon, ToolActivitySource } from "@t3tools/contracts";

import { mcpToolPresentation } from "../../provider/McpToolPresentation.ts";
import { piRecordNumber, piRecordString } from "./PiRpc.ts";

export type PiToolTurnItemFields =
  | {
      readonly type: "command_execution";
      readonly title: string;
      readonly input: string;
      readonly output?: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: "file_change";
      readonly title: string;
      readonly fileName: string;
      readonly diffStr?: string;
      readonly newStr?: string;
    }
  | {
      readonly type: "dynamic_tool";
      readonly title: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly output?: string;
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
}): PiToolTurnItemFields {
  const { toolName, args, outputText } = input;
  const output = outputText.length > 0 ? { output: outputText } : {};
  if (toolName === "bash") {
    const exitCode = piRecordNumber(input.details, "exitCode");
    return {
      title: toolName,
      type: "command_execution",
      input: piRecordString(args, "command") ?? "",
      ...output,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
  if (toolName === "edit" || toolName === "write") {
    const fileName = piRecordString(args, "path") ?? piRecordString(args, "file_path");
    if (fileName !== undefined) {
      // edit reports a unified patch in its result details; write only
      // carries the new content in its args. A failed call keeps its error.
      const diffStr =
        piRecordString(input.details, "patch") ??
        (input.isError && outputText.trim().length > 0 ? outputText : undefined);
      const newStr = toolName === "write" ? piRecordString(args, "content") : undefined;
      return {
        title: toolName,
        type: "file_change",
        fileName,
        ...(diffStr === undefined ? {} : { diffStr }),
        ...(newStr === undefined ? {} : { newStr }),
      };
    }
  }
  return {
    title: toolName,
    type: "dynamic_tool",
    ...mcpToolPresentation({ toolName }),
    toolName,
    input: args ?? {},
    ...output,
  };
}
