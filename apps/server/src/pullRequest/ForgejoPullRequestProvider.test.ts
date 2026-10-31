import { assert, it } from "@effect/vitest";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ForgejoCli from "../sourceControl/ForgejoCli.ts";
import * as ForgejoPullRequestProvider from "./ForgejoPullRequestProvider.ts";

const processOutput = (stdout: string) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("lists each Forgejo assignee once as a reviewer candidate", () => {
  const paths: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const result = yield* provider.listReviewerCandidates({
      cwd: "/repo",
      repository: "acme/web",
      host: "forgejo.test",
      number: 7,
    });

    assert.deepStrictEqual(
      result.candidates.map((candidate) => [candidate.id, candidate.isRequested]),
      [
        ["ana", true],
        ["noor", false],
      ],
    );
    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(
      paths.filter((path) => path.includes("/assignees")),
      ["repos/acme/web/assignees"],
    );
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          paths.push(input.path);
          switch (input.path.split("?")[0]) {
            case "repos/acme/web/pulls/7":
              return Effect.succeed(
                processOutput(
                  JSON.stringify({
                    number: 7,
                    title: "Review target",
                    body: "",
                    html_url: "https://forgejo.test/acme/web/pulls/7",
                    user: { login: "maria" },
                    state: "open",
                    merged: false,
                    head: { ref: "feature", sha: "head", repo: null },
                    base: { ref: "main", sha: "base", repo: null },
                    created_at: "2026-09-13T00:00:00Z",
                    updated_at: "2026-09-13T00:00:00Z",
                    closed_at: null,
                    merged_at: null,
                    labels: [],
                    requested_reviewers: [{ login: "ana" }],
                  }),
                ),
              );
            case "repos/acme/web/assignees":
              // Forgejo ignores paging here and returns the complete list on every request.
              return Effect.succeed(
                processOutput(
                  JSON.stringify([{ login: "maria" }, { login: "ana" }, { login: "noor" }]),
                ),
              );
            default:
              return Effect.die(`Unexpected Forgejo request: ${input.path}`);
          }
        },
      }),
    ),
  );
});
