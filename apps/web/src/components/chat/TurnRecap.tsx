import type { MouseEvent } from "react";
import { useId, useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ActivityDisclosurePanel, useActivityDisclosure } from "./ActivityDisclosure";
import { CursorTodoRows } from "./CursorTodoPanel";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import type { TurnRecap as TurnRecapModel } from "./MessagesTimeline.logic";
import { PierreEntryIcon } from "./PierreEntryIcon";

/**
 * A settled turn's to-dos and edited files, folded to one line under its
 * answer: `6 of 6 to-dos · 5 files changed +41 −7 ›`. Opening it lists both;
 * a file opens in the turn's diff when a checkpoint has one.
 */
export function TurnRecap(props: {
  readonly recap: TurnRecapModel;
  /** The turn settled while on screen, so the line rises in. */
  readonly entering: boolean;
  readonly disclosureCache: Set<string>;
  readonly resolvedTheme: "light" | "dark";
  readonly onOpenFile: (path: string) => void;
  readonly onFileContextMenu: (path: string, event: MouseEvent) => void;
}) {
  const { recap } = props;
  const disclosure = useActivityDisclosure({
    cache: props.disclosureCache,
    disclosureKey: `turn-recap:${recap.runId}`,
    defaultOpen: false,
  });
  const bodyId = useId();
  const [mountedTaskCount] = useState(recap.todos.length);
  let completed = 0;
  for (const task of recap.todos) if (task.status === "completed") completed += 1;
  let additions = 0;
  let deletions = 0;
  for (const file of recap.files) {
    additions += file.additions;
    deletions += file.deletions;
  }

  return (
    <div className={cn("turn-recap", props.entering && "motion-enter")} data-turn-recap>
      <button
        type="button"
        className="turn-recap-header"
        aria-expanded={disclosure.open}
        aria-controls={bodyId}
        data-scroll-anchor-ignore
        onClick={disclosure.toggle}
      >
        {recap.todos.length > 0 ? (
          <span>
            {completed} of {recap.todos.length} to-dos
          </span>
        ) : null}
        {recap.todos.length > 0 && recap.files.length > 0 ? <span aria-hidden>·</span> : null}
        {recap.files.length > 0 ? (
          <span>
            {recap.files.length} {recap.files.length === 1 ? "file" : "files"} changed
          </span>
        ) : null}
        {hasNonZeroStat({ additions, deletions }) ? (
          <DiffStatLabel additions={additions} deletions={deletions} layout="inline" />
        ) : null}
        <ChevronRightIcon aria-hidden className="turn-recap-chevron size-3.5" />
      </button>
      <ActivityDisclosurePanel open={disclosure.open} instant={disclosure.instant} id={bodyId}>
        <div className="turn-recap-body">
          {recap.todos.length > 0 ? (
            <CursorTodoRows
              ariaLabel="To-dos"
              tasks={recap.todos}
              live={false}
              mountedTaskCount={mountedTaskCount}
            />
          ) : null}
          {recap.files.length > 0 ? (
            <ul className="turn-recap-files" aria-label="Changed files">
              {recap.files.map((file) => {
                const slash = file.path.lastIndexOf("/");
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="turn-recap-file"
                      onClick={() => props.onOpenFile(file.path)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        props.onFileContextMenu(file.path, event);
                      }}
                    >
                      <PierreEntryIcon
                        pathValue={file.path}
                        kind="file"
                        theme={props.resolvedTheme}
                        className="size-3.5 shrink-0"
                      />
                      <span className="turn-recap-file-name">{file.path.slice(slash + 1)}</span>
                      {slash > 0 ? (
                        <span className="turn-recap-file-dir">{file.path.slice(0, slash)}</span>
                      ) : null}
                      {hasNonZeroStat(file) ? (
                        <DiffStatLabel
                          additions={file.additions}
                          deletions={file.deletions}
                          layout="inline"
                          className="ms-auto shrink-0"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </ActivityDisclosurePanel>
    </div>
  );
}
