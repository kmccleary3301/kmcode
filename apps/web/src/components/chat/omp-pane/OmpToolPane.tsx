import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import { BottomStickScrollArea } from "../../ui/bottom-stick";
import ChatMarkdown from "../../ChatMarkdown";
import { OmpPaneCode } from "./OmpPaneCode";
import type { OmpCodeBlock } from "./OmpPaneCode";
import type { OmpListingSection, OmpPaneInput, OmpPaneModel } from "./ompPaneModel";

/**
 * React port of OMP's TUI tool pane: one box, the call's input on top (it
 * grows while the model streams the arguments), then an `Output` divider and
 * the tool's output once it runs. No metadata rows: a step headline above, or
 * the `legend` set into the top border, carries the verb, target and status.
 */
export function OmpToolPane(props: {
  readonly model: OmpPaneModel;
  /** The model is still writing the call's arguments. */
  readonly streamingArgs: boolean;
  /** The tool is executing; output follows its tail. */
  readonly running: boolean;
  readonly inputActions?: ReactNode;
  readonly outputActions?: ReactNode;
  /** Replaces the output text (detail loading, load errors, rich results). */
  readonly outputOverride?: ReactNode;
  /** OMP's collapsed output line budget; omitted outside terminal style. */
  readonly previewLines?: number | undefined;
  /** OMP's collapsed input line budget; omitted outside terminal style. */
  readonly inputPreviewLines?: number | undefined;
  /** Title set into the top border, the way OMP's TUI labels a pane. */
  readonly legend?: ReactNode;
}) {
  const { model } = props;
  const [outputExpanded, setOutputExpanded] = useState(false);
  const showOutput =
    !props.streamingArgs && (props.outputOverride != null || model.output !== null);
  const listing = useMemo(
    () => (model.outputListing === null ? null : listingBlocks(model.outputListing)),
    [model.outputListing],
  );
  const codeOutput = useMemo(
    (): OmpCodeBlock | null =>
      model.outputLanguage !== null && model.output !== null
        ? {
            language: model.outputLanguage,
            gutters: 0,
            rows: model.output
              .replace(/\n$/, "")
              .split("\n")
              .map((text) => ({ text, gutter: [] })),
          }
        : null,
    [model.output, model.outputLanguage],
  );
  const previewLimit = props.previewLines;
  const terminalOutputLines =
    previewLimit !== undefined &&
    model.output !== null &&
    model.outputListing === null &&
    codeOutput === null &&
    props.outputOverride == null
      ? model.output.replace(/\r/g, "").split("\n")
      : null;
  const hiddenOutputLineCount =
    terminalOutputLines === null
      ? 0
      : Math.max(0, terminalOutputLines.length - (previewLimit ?? 0));
  const outputText =
    terminalOutputLines !== null && !outputExpanded
      ? terminalOutputLines.slice(0, previewLimit ?? 0).join("\n")
      : model.output;
  if (model.input === null && !showOutput) return null;
  // A fieldset sets its legend into the border, rounded corners and state tint included.
  const Frame = props.legend === undefined ? "div" : "fieldset";
  return (
    <Frame className="omp-pane" data-tool-pane data-failed={model.outputIsError || undefined}>
      {props.legend === undefined ? null : (
        <legend className="omp-pane-legend">{props.legend}</legend>
      )}
      {model.input !== null ? (
        <section className="omp-pane-input" aria-label="Input">
          {props.inputActions ? <div className="omp-pane-actions">{props.inputActions}</div> : null}
          <BottomStickScrollArea live={props.streamingArgs}>
            <OmpPaneInputBody
              input={model.input}
              streaming={props.streamingArgs}
              previewLines={props.inputPreviewLines}
            />
          </BottomStickScrollArea>
        </section>
      ) : null}
      {showOutput ? (
        <section className="omp-pane-output" aria-label="Output">
          {model.input !== null ? (
            <div className="omp-pane-divider">
              <span>Output</span>
            </div>
          ) : null}
          {props.outputActions ? (
            <div className="omp-pane-actions">{props.outputActions}</div>
          ) : null}
          <BottomStickScrollArea live={props.running}>
            {props.outputOverride ??
              (listing !== null ? (
                <>
                  <OmpPaneCode
                    blocks={listing.blocks}
                    complete={!props.running}
                    previewLines={props.previewLines}
                  />
                  {listing.notes.length > 0 ? (
                    <p className="omp-pane-note">{listing.notes.join("\n")}</p>
                  ) : null}
                </>
              ) : codeOutput !== null ? (
                <OmpPaneCode
                  blocks={[codeOutput]}
                  complete={!props.running}
                  previewLines={props.previewLines}
                />
              ) : (
                <>
                  <pre className="omp-pane-output-text" data-error={model.outputIsError || undefined}>
                    {outputText}
                  </pre>
                  {hiddenOutputLineCount > 0 ? (
                    <button
                      type="button"
                      className="terminal-preview-more"
                      aria-label={`Expand ${hiddenOutputLineCount} more lines`}
                      onClick={() => setOutputExpanded(true)}
                    >
                      … {hiddenOutputLineCount} more lines
                    </button>
                  ) : null}
                </>
              ))}
          </BottomStickScrollArea>
        </section>
      ) : null}
    </Frame>
  );
}

/** Line listings: one block per file, its path as the title once there are several. */
function listingBlocks(sections: ReadonlyArray<OmpListingSection>) {
  return {
    blocks: sections
      .filter((section) => section.rows.length > 0)
      .map((section): OmpCodeBlock => ({
        language: section.language,
        gutters: 1,
        ...(sections.length > 1 && section.path !== null ? { title: section.path } : {}),
        rows: section.rows.map((row) => ({ text: row.text, kind: row.kind, gutter: [row.gutter] })),
      })),
    notes: sections.flatMap((section) => section.notes),
  };
}

/** The input's code as pane blocks; null for prose and field inputs. */
function inputBlocks(input: OmpPaneInput): ReadonlyArray<OmpCodeBlock> | null {
  switch (input.kind) {
    case "command":
      return [
        {
          language: "bash",
          gutters: 1,
          rows: input.command
            .split("\n")
            .map((text, index) => ({ text, gutter: [index === 0 ? "$" : ""] })),
        },
      ];
    case "cells":
      return input.cells.map((cell) => ({
        language: cell.language,
        gutters: 0,
        ...(cell.title ? { title: cell.title } : {}),
        rows: cell.code.split("\n").map((text) => ({ text, gutter: [] })),
      }));
    case "file":
      return [
        {
          language: input.language,
          gutters: 1,
          rows: input.content
            .replace(/\n$/, "")
            .split("\n")
            .map((text, index) => ({ text, gutter: [String(index + 1)] })),
        },
      ];
    case "diff":
      return [
        {
          language: input.language,
          gutters: input.gutters,
          rows: input.lines.map((line) => ({
            text: line.text,
            kind: line.kind,
            // A removed row shows its old number; everything else its new one.
            gutter:
              input.gutters === 0
                ? []
                : [
                    String(
                      (line.kind === "remove" ? line.oldLine : (line.newLine ?? line.oldLine)) ??
                        "",
                    ),
                  ],
          })),
        },
      ];
    case "prose":
    case "markdown":
    case "fields":
      return null;
  }
}

function OmpPaneInputBody(props: {
  readonly input: OmpPaneInput;
  readonly streaming: boolean;
  readonly previewLines?: number | undefined;
}) {
  const { input, streaming, previewLines } = props;
  const blocks = useMemo(() => inputBlocks(input), [input]);
  if (blocks !== null) {
    return (
      <>
        <OmpPaneCode blocks={blocks} complete={!streaming} previewLines={previewLines} />
        {streaming && input.kind === "file" ? (
          <div className="omp-pane-streaming">Writing…</div>
        ) : null}
      </>
    );
  }

  return input.kind === "prose" ? (
    <p className="omp-pane-prose">{input.text}</p>
  ) : input.kind === "markdown" ? (
    <ChatMarkdown
      text={input.text}
      cwd={undefined}
      parseRawHtml={false}
      isStreaming={streaming}
      className="omp-pane-markdown"
    />
  ) : input.kind === "fields" ? (
    <dl className="omp-pane-fields">
      {input.rows.map(([key, value]) => (
        <div key={key} className="omp-pane-field">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}
