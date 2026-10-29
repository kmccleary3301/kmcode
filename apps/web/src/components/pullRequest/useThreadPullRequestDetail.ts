import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestRef,
  PullRequestState,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { useServerConfigs } from "~/state/entities";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

/**
 * What the host says about a thread's pull request, checks included, kept fresh while it is open.
 * The thread details row and the composer's checks dock both read through here, so they share one
 * answer and one refresh schedule: the same atoms, and the same live-refresh keys, which is what
 * stops two surfaces on one pull request from reading the host twice.
 *
 * `reference` is the thread link's host-level identity; without one, the project's own repository
 * and `number` stand in. `fallbackState` is what the thread already knows before the host answers.
 */
export function useThreadPullRequestDetail({
  environmentId,
  project,
  reference: linkedReference,
  number,
  fallbackState,
}: {
  environmentId: EnvironmentId;
  project: EnvironmentProject | null;
  reference: Pick<PullRequestRef, "host" | "repository" | "number"> | null | undefined;
  number: number;
  fallbackState: PullRequestState | undefined;
}) {
  const serverConfigs = useServerConfigs();
  const supportsPullRequests =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequests === true;
  const repository = sourceControlRepositorySelector(project?.repositoryIdentity);
  const reference: PullRequestRef | null =
    supportsPullRequests && project !== null
      ? linkedReference
        ? { ...linkedReference, projectId: project.id as ProjectId }
        : repository !== null
          ? { projectId: project.id as ProjectId, repository, number }
          : null
      : null;
  const detailQuery = useEnvironmentQuery(
    reference === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId,
          input: { ...reference, allowStale: false },
        }),
  );
  const supportsChecks =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequestChecks === true;
  const checksQuery = useEnvironmentQuery(
    supportsChecks && reference !== null && detailQuery.data !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null,
  );
  const detail =
    detailQuery.data === null
      ? null
      : checksQuery.data !== null && checksQuery.dataUpdatedAt >= detailQuery.dataUpdatedAt
        ? { ...detailQuery.data, ...checksQuery.data }
        : detailQuery.data;
  const open = reference !== null && (detail?.state ?? fallbackState) === "open";
  const refreshKey = `${environmentId}:${project?.id}:${reference?.host}:${reference?.repository}:${number}`;
  useLiveRefresh(detailQuery.isPending ? null : detailQuery.refresh, {
    enabled: open,
    key: `workspace-pr:${refreshKey}`,
    intervalMs: 10 * 60_000,
  });
  usePullRequestChecksRefresh({
    refresh: checksQuery.isPending || detailQuery.isPending ? null : checksQuery.refresh,
    enabled: open && supportsChecks && !(checksQuery.isSuccess && checksQuery.data === null),
    key: `workspace-pr-checks:${refreshKey}`,
    checks: detail?.checks ?? [],
  });

  return {
    reference,
    detail,
    refresh: () => {
      detailQuery.refresh();
      checksQuery.refresh();
    },
  };
}
