import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly subagentOf?: ThreadId;
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: overrides.subagentOf
      ? {
          parentThreadId: overrides.subagentOf,
          relationshipToParent: "subagent",
          rootThreadId: overrides.subagentOf,
        }
      : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: {
    readonly minute?: number;
    readonly streaming?: boolean;
    readonly createdBy?: "user" | "agent";
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    createdBy: options.createdBy ?? (role === "user" ? "user" : "agent"),
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [
          match.threadId,
          match.messageId,
          match.source,
          match.snippet,
        ]),
        [
          [both, MessageId.make("both-user-new"), "user", "newer needle question"],
          [assistantOnly, MessageId.make("assistant-only"), "assistant", "needle in an answer"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      // FTS operators in user text are treated as literal message content.
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );
  it.effect("ranks exact message matches and counts equally matching messages", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-quality");
      const whole = ThreadId.make("thread:whole-word");
      const substring = ThreadId.make("thread:substring");
      const shortQuery = ThreadId.make("thread:short-query");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(whole, project),
          message(whole, "whole-old", "user", "Rust added", { minute: 1 }),
          message(whole, "whole-new", "assistant", "Rust update", { minute: 2 }),
          thread(substring, project),
          message(substring, "substring", "user", "Trust this build", { minute: 3 }),
          thread(shortQuery, project),
          message(shortQuery, "short-query", "user", "Decision log"),
        ],
        projections.apply,
        { discard: true },
      );

      const matches = (yield* search.search({ query: "rust", limit: 10 })).matches;
      assert.deepEqual(
        matches.map(({ threadId, messageId, quality, hits }) => [
          threadId,
          messageId,
          quality,
          hits,
        ]),
        [
          [whole, MessageId.make("whole-old"), 1, 2],
          [substring, MessageId.make("substring"), 0.3, 1],
        ],
      );
      assert.deepEqual((yield* search.search({ query: "ci" })).matches, []);
    }),
  );
  it.effect("indexes settled edits and excludes subagent and short-only matches", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-index-updates");
      const parent = ThreadId.make("thread:search-index-parent");
      const subagent = ThreadId.make("thread:search-index-subagent");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          message(parent, "sync", "assistant", "streaming draft", { streaming: true }),
          message(parent, "short-token", "user", "saved two drafts"),
          thread(subagent, project, { subagentOf: parent }),
          message(subagent, "subagent", "assistant", "edited reply"),
        ],
        projections.apply,
        { discard: true },
      );

      const threadIds = (query: string) =>
        search
          .search({ query })
          .pipe(Effect.map(({ matches }) => matches.map((match) => match.threadId)));
      assert.deepEqual(yield* threadIds("streaming"), []);
      assert.deepEqual(yield* threadIds("ab"), []);
      assert.deepEqual(yield* threadIds("edited"), []);

      yield* projections.apply(message(parent, "sync", "assistant", "finished answer"));
      assert.deepEqual(yield* threadIds("streaming"), []);
      assert.deepEqual(yield* threadIds("finished"), [parent]);
      yield* projections.apply(message(parent, "sync", "assistant", "edited reply"));
      assert.deepEqual(yield* threadIds("finished"), []);
      assert.deepEqual(yield* threadIds("edited"), [parent]);
    }),
  );
  it.effect("does not index subagent messages or metadata-only updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("project:search-index-writes");
      const parent = ThreadId.make("thread:search-index-write-parent");
      const subagent = ThreadId.make("thread:search-index-write-subagent");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(parent, project),
          message(parent, "indexed-parent", "assistant", "parent answer"),
          thread(subagent, project, { subagentOf: parent }),
          message(subagent, "indexed-subagent", "assistant", "subagent answer"),
        ],
        projections.apply,
        { discard: true },
      );

      const indexedThreads = () =>
        sql<{ readonly threadId: string }>`
          SELECT messages.thread_id AS "threadId"
          FROM orchestration_v2_message_search AS search
          INNER JOIN orchestration_v2_projection_messages AS messages
            ON messages.rowid = search.rowid
          WHERE messages.thread_id IN (${parent}, ${subagent})
        `.pipe(Effect.map((rows) => rows.map((row) => row.threadId)));
      assert.deepEqual(yield* indexedThreads(), [parent]);

      const totalChanges = () =>
        sql<{ readonly count: number }>`SELECT total_changes() AS count`.pipe(
          Effect.map(([row]) => row?.count ?? 0),
        );
      const before = yield* totalChanges();
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.updatedAt', '2026-09-27T01:00:00.000Z')
        WHERE message_id = 'indexed-parent'
      `;
      assert.strictEqual((yield* totalChanges()) - before, 1);
      assert.deepEqual(yield* indexedThreads(), [parent]);
    }),
  );
  it.effect("ranks message matches by written time, quality, hit count, and saved picks", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-ranking");
      const recent = ThreadId.make("thread:search-recent");
      const imported = ThreadId.make("thread:search-imported");
      const about = ThreadId.make("thread:search-about");
      const mention = ThreadId.make("thread:search-mention");
      const larks = ThreadId.make("thread:search-larks");
      const clarks = ThreadId.make("thread:search-clarks");
      const busy = ThreadId.make("thread:search-busy");
      const picked = ThreadId.make("thread:search-picked");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(recent, project),
          message(recent, "search-recent", "user", "kestrel deploy notes", { minute: 30 }),
          thread(imported, project),
          message(imported, "search-imported", "user", "kestrel deploy notes", { minute: 1 }),
          thread(about, project),
          ...Array.from({ length: 12 }, (_, index) =>
            message(about, `osprey-${index}`, "assistant", `osprey step ${index}`, {
              minute: 2,
            }),
          ),
          thread(mention, project),
          message(mention, "osprey-mention", "user", "also check osprey", { minute: 5 }),
          thread(larks, project),
          ...Array.from({ length: 8 }, (_, index) =>
            message(larks, `lark-${index}`, "assistant", "Lark again", { minute: 2 }),
          ),
          thread(clarks, project),
          message(clarks, "clarks-lark", "user", "Lark once", { minute: 3 }),
          ...Array.from({ length: 31 }, (_, index) =>
            message(clarks, `clark-${index}`, "assistant", "Clark the plan", { minute: 3 }),
          ),
          thread(busy, project),
          message(busy, "plover-1", "user", "plover notes", { minute: 3 }),
          message(busy, "plover-2", "user", "more plover notes", { minute: 4 }),
          thread(picked, project),
          message(picked, "plover-picked", "user", "one plover mention", { minute: 1 }),
        ],
        projections.apply,
        { discard: true },
      );

      const writtenOrder = (yield* search.search({ query: "kestrel" })).matches.map(
        (match) => match.threadId,
      );
      assert.deepEqual(writtenOrder, [recent, imported]);
      assert.deepEqual(
        (yield* search.search({ query: "osprey" })).matches.map((match) => [
          match.threadId,
          match.hits,
        ]),
        [
          [about, 12],
          [mention, 1],
        ],
      );
      assert.deepEqual(
        (yield* search.search({ query: "lark" })).matches.map((match) => [
          match.threadId,
          match.hits,
        ]),
        [
          [larks, 8],
          [clarks, 1],
        ],
      );
      assert.deepEqual(
        (yield* search.search({ query: "plover", limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        [busy],
      );
      yield* TestClock.adjust("1 day");
      const pickedAt = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.opens', json(${JSON.stringify({
          openedAt: pickedAt,
          score: 1,
          picks: [{ query: "plover", at: pickedAt }],
        })}))
        WHERE thread_id = ${picked}
      `;
      assert.deepEqual(
        (yield* search.search({ query: "plover", limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        [picked],
      );
    }),
  );
  it.effect("searches messages as displayed and excludes asynchronous answers", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-displayed");
      const labeled = ThreadId.make("thread:search-link-label");
      const addressOnly = ThreadId.make("thread:search-link-address");
      const curly = ThreadId.make("thread:search-curly-apostrophe");
      const straight = ThreadId.make("thread:search-straight-apostrophe");
      const answer = ThreadId.make("thread:search-answer");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(labeled, project),
          message(labeled, "heron-label", "assistant", "See [the heron plan](https://x.dev/a) now"),
          thread(addressOnly, project),
          message(addressOnly, "heron-address", "user", "Read [this](https://heron.dev/b)"),
          thread(curly, project),
          message(curly, "gannet-curly", "user", "the gannet\u2019s nest"),
          thread(straight, project),
          message(straight, "kittiwake-straight", "user", "a kittiwake's nest"),
          thread(answer, project),
          message(answer, "async-answer:request-1", "user", "use the albatross drive"),
        ],
        projections.apply,
        { discard: true },
      );

      assert.deepEqual(
        (yield* search.search({ query: "heron" })).matches.map((match) => [
          match.threadId,
          match.snippet,
        ]),
        [[labeled, "See the heron plan now"]],
      );
      assert.deepEqual(
        (yield* search.search({ query: "gannet's" })).matches.map((match) => match.threadId),
        [curly],
      );
      assert.deepEqual(
        (yield* search.search({ query: "kittiwake\u2019s" })).matches.map(
          (match) => match.threadId,
        ),
        [straight],
      );
      assert.deepEqual((yield* search.search({ query: "albatross" })).matches, []);
    }),
  );
  it.effect("bounds FTS candidates before filtering narrower tokens", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-candidate-window");
      const older = ThreadId.make("thread:search-candidate-older");
      const busy = ThreadId.make("thread:search-candidate-busy");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(older, project),
          message(older, "candidate-older", "user", "kestrel ci is red"),
          thread(busy, project),
        ],
        projections.apply,
        { discard: true },
      );
      const insertBusy = (count: number) => sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        SELECT 'candidate-busy-' || i, ${busy}, 'assistant', 0,
          '2026-09-27T00:05:00.000Z', '2026-09-27T00:05:00.000Z',
          json_object('text', 'kestrel packages')
        FROM n
      `;
      const threadIds = () =>
        search
          .search({ query: "kestrel ci" })
          .pipe(Effect.map(({ matches }) => matches.map((match) => match.threadId)));

      yield* insertBusy(9_999);
      assert.deepEqual(yield* threadIds(), [older]);
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${busy}`;
      yield* insertBusy(10_000);
      assert.deepEqual(yield* threadIds(), []);
    }),
  );
  it.effect("excludes attachment-only bootstrap text from search results", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-attachments");
      const threadId = ThreadId.make("thread:search-attachments");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "ordinary", "user", "Review the attached files in context"),
          message(threadId, "attachment-only", "user", ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
          message(
            threadId,
            "effort-attachment-only",
            "user",
            `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
          ),
          message(
            threadId,
            "whitespace-effort-attachment-only",
            "user",
            `uLtRaThInK:\r\n\t\u00a0${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
          ),
        ],
        projections.apply,
        { discard: true },
      );

      assert.deepEqual((yield* search.search({ query: "conversation context" })).matches, []);
      assert.deepEqual((yield* search.search({ query: "ultrathink" })).matches, []);
      assert.deepEqual(
        (yield* search.search({ query: "attached files" })).matches.map((match) => match.snippet),
        ["Review the attached files in context"],
      );
    }),
  );
  it.effect("filters legacy attachment placeholders before the FTS candidate limit", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-legacy-attachments");
      const threadId = ThreadId.make("thread:search-legacy-attachments");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(
            threadId,
            "ordinary-legacy",
            "user",
            "Review the attached files in conversation context",
          ),
        ],
        projections.apply,
        { discard: true },
      );

      // Simulate pre-upgrade triggers that indexed attachment placeholders.
      yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
      yield* sql`
        CREATE TRIGGER orchestration_v2_message_search_insert
        AFTER INSERT ON orchestration_v2_projection_messages
        BEGIN
          INSERT INTO orchestration_v2_message_search (rowid, text)
          SELECT new.rowid, json_extract(new.payload_json, '$.text')
          WHERE json_extract(new.payload_json, '$.text') IS NOT NULL;
        END
      `;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
        SELECT 'legacy-placeholder:' || i, ${threadId}, 'user', 0,
          ${DateTime.formatIso(at(2))}, ${DateTime.formatIso(at(2))},
          json_object('text', ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT})
        FROM n
      `;

      assert.deepEqual(
        (yield* search.search({ query: "conversation" })).matches.map((match) => match.messageId),
        [MessageId.make("ordinary-legacy")],
      );
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.search({ query: "0260927" }));
      assert.equal(error.operation, "decode");
    }),
  );
  it.effect("searches CJK text with or without the trigram index", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-scripts");
      const threadId = ThreadId.make("thread:search-scripts");
      const curly = ThreadId.make("thread:search-curly-fallback");
      const straight = ThreadId.make("thread:search-straight-fallback");
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(threadId, project),
          message(threadId, "korean", "user", "검색 기능을 고쳐 주세요"),
          message(threadId, "japanese", "user", "がんばって検索します"),
          message(threadId, "chinese", "user", "明天部署到生产环境"),
          message(threadId, "fts", "assistant", "the FTS index is ready"),
          message(threadId, "camel-case", "assistant", "Configure enableFTS today"),
          thread(curly, project),
          message(curly, "tern-curly-fallback", "user", "the tern\u2019s nest"),
          thread(straight, project),
          message(straight, "skua-straight-fallback", "user", "a skua's nest"),
        ],
        projections.apply,
        { discard: true },
      );

      assert.deepEqual(
        (yield* search.search({ query: "검색 기능" })).matches.map((match) => match.threadId),
        [threadId],
      );
      assert.deepEqual(
        (yield* search.search({ query: "がんばって" })).matches.map((match) => match.threadId),
        [threadId],
      );
      assert.deepEqual(
        (yield* search.search({ query: "部署" })).matches.map((match) => match.threadId),
        [threadId],
      );
      assert.deepEqual(
        (yield* search.search({ query: "enable" })).matches.map((match) => match.threadId),
        [threadId],
      );

      yield* sql`DROP TABLE orchestration_v2_message_search`;
      const withoutIndex = yield* ThreadSearch.make;
      assert.deepEqual(
        (yield* withoutIndex.search({ query: "部署" })).matches.map((match) => match.threadId),
        [threadId],
      );
      assert.deepEqual(
        (yield* withoutIndex.search({ query: "fts" })).matches.map((match) => match.threadId),
        [threadId],
      );
      assert.deepEqual(
        (yield* withoutIndex.search({ query: "tern's" })).matches.map((match) => match.threadId),
        [curly],
      );
      assert.deepEqual(
        (yield* withoutIndex.search({ query: "skua\u2019s" })).matches.map(
          (match) => match.threadId,
        ),
        [straight],
      );
    }),
  );
});
