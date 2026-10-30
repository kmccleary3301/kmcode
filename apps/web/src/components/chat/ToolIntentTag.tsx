import { RollingText } from "./RollingText";

/**
 * The agent's own one-line description of a step ("Setting the auto-forward
 * limit"), trailing a row's summary after a quiet dot. It rolls like the rest
 * of the line: it rises in once the call's arguments name it, rolls over as a
 * live group moves to its next step, and leaves when the step has none.
 */
export function ToolIntentTag({ intent }: { readonly intent: string | undefined }) {
  return <RollingText text={intent ?? ""} data-tool-intent-tag className="tool-intent-tag" />;
}
