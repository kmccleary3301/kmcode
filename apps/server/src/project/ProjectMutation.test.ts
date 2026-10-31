import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";

import { mutateProjectWithClone, projectMutationOperation } from "./ProjectMutation.ts";
import { ProjectNotEmptyError, type ProjectService } from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/updated",
      defaultModelSelection: null,
      autoPull: false,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);
it.effect("keeps clone tracking when a project deletion is rejected", () =>
  Effect.gen(function* () {
    const rejected = new ProjectNotEmptyError({ projectId });
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.fail(rejected),
    };
    const result = yield* mutateProjectWithClone(
      projects,
      { discard: () => Effect.die("must not discard a project that still exists") },
      { type: "project.delete", commandId: CommandId.make("rejected-delete"), projectId },
    ).pipe(Effect.flip);

    assert.strictEqual(result, rejected);
  }),
);

it.effect("discards the clone after a committed deletion despite request interruption", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const finishDelete = yield* Deferred.make<void>();
    const discarded: Array<ProjectId> = [];
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () =>
        Deferred.succeed(committed, undefined).pipe(
          Effect.andThen(Deferred.await(finishDelete)),
          Effect.as(project),
        ),
    };
    const clones = {
      discard: (id: ProjectId) => Effect.sync(() => void discarded.push(id)),
    };

    const request = yield* mutateProjectWithClone(projects, clones, {
      type: "project.delete",
      commandId: CommandId.make("command:delete-interrupted"),
      projectId,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(committed);
    request.interruptUnsafe();
    yield* Deferred.succeed(finishDelete, undefined);
    yield* Fiber.await(request);

    assert.deepEqual(discarded, [projectId]);
  }),
);
