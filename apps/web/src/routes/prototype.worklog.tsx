// PROTOTYPE: throwaway work-log tree demo. Not production code.
import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  DESIGN_OPTIONS,
  PrototypeWorklogPage,
  type Design,
} from "../prototypes/worklog/PrototypeWorklogPage";
import { isTraceId, type TraceId } from "../prototypes/worklog/trace";

export interface PrototypeWorklogSearch {
  readonly trace?: TraceId;
  readonly design?: Design;
}

function isDesign(value: unknown): value is Design {
  return DESIGN_OPTIONS.some((option) => option.id === value);
}

export const Route = createFileRoute("/prototype/worklog")({
  validateSearch: (search: Record<string, unknown>): PrototypeWorklogSearch => ({
    ...(isTraceId(search.trace) ? { trace: search.trace } : {}),
    ...(isDesign(search.design) ? { design: search.design } : {}),
  }),
  beforeLoad: () => {
    // Dev builds only; production never serves the prototype.
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PrototypeWorklogRoute,
});

function PrototypeWorklogRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PrototypeWorklogPage
      traceId={search.trace ?? "php-advisory"}
      design={search.design ?? "tree"}
      onChange={(next) => {
        void navigate({ search: { trace: next.traceId, design: next.design }, replace: true });
      }}
    />
  );
}
