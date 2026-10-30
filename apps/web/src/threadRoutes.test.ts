import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { DraftId } from "./composerDraftStore";

import * as Option from "effect/Option";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  isThreadRouteBootstrapComplete,
  resolveActiveThreadRouteRef,
  resolveThreadRouteRenderState,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "./threadRoutes";

describe("threadRoutes", () => {
  it("builds canonical thread route params from a scoped ref", () => {
    const ref = scopeThreadRef("env-1" as never, ThreadId.make("thread-1"));

    expect(buildThreadRouteParams(ref)).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
  });

  it("resolves a scoped ref only when both params are present", () => {
    expect(
      resolveThreadRouteRef({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });

    expect(resolveThreadRouteRef({ environmentId: "env-1" })).toBeNull();
    expect(resolveThreadRouteRef({ threadId: "thread-1" })).toBeNull();
  });

  it("builds canonical draft route params from a draft id", () => {
    expect(buildDraftThreadRouteParams(DraftId.make("draft-1"))).toEqual({
      draftId: "draft-1",
    });
  });

  it("resolves draft and server route targets", () => {
    expect(
      resolveThreadRouteTarget({
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "server",
      threadRef: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
    });

    expect(
      resolveThreadRouteTarget({
        draftId: "draft-1",
      }),
    ).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
  });

  it("resolves the backing thread while a draft route is being promoted", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: scopeThreadRef("env-2" as never, ThreadId.make("server-thread")),
      }),
    ).toEqual({
      environmentId: "env-2",
      threadId: "server-thread",
    });
  });

  it("does not treat a draft's reserved thread ref as an active sidebar thread", () => {
    const target = resolveThreadRouteTarget({ draftId: "draft-1" });

    expect(
      resolveActiveThreadRouteRef(target, {
        environmentId: "env-1" as never,
        threadId: ThreadId.make("draft-thread"),
        promotedTo: null,
      }),
    ).toBeNull();
  });

  it("renders authoritative server-thread shells when bootstrap is complete", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
  });

  it("renders server threads and local drafts when they are ready", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("ready");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: true,
      }),
    ).toBe("ready");
  });

  it("distinguishes bootstrap loading from a missing thread", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: false,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("loading");
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("redirects deleted server threads", () => {
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: true,
        draftThreadExists: false,
      }),
    ).toBe("missing");
  });

  it("only treats live authoritative shell snapshots as complete bootstrap", () => {
    expect(isThreadRouteBootstrapComplete(null)).toBe(false);
    expect(isThreadRouteBootstrapComplete({ isPending: true, data: null })).toBe(false);

    // Empty shell (no snapshot yet)
    expect(
      isThreadRouteBootstrapComplete({
        isPending: false,
        data: { status: "empty", snapshot: Option.none() },
      }),
    ).toBe(false);

    // Cached shell from previous session must NOT be treated as complete bootstrap;
    // otherwise newly created/imported server threads missing from cache cause a premature redirect.
    expect(
      isThreadRouteBootstrapComplete({
        isPending: false,
        data: { status: "cached", snapshot: Option.some({ threads: [] }) },
      }),
    ).toBe(false);

    // Synchronizing shell in flight must NOT be treated as complete bootstrap
    expect(
      isThreadRouteBootstrapComplete({
        isPending: false,
        data: { status: "synchronizing", snapshot: Option.some({ threads: [] }) },
      }),
    ).toBe(false);

    // Pending query must NOT be treated as complete bootstrap
    expect(
      isThreadRouteBootstrapComplete({
        isPending: true,
        data: { status: "live", snapshot: Option.some({ threads: [] }) },
      }),
    ).toBe(false);

    // Live shell with snapshot IS complete bootstrap
    expect(
      isThreadRouteBootstrapComplete({
        isPending: false,
        data: { status: "live", snapshot: Option.some({ threads: [] }) },
      }),
    ).toBe(true);
  });

  it("holds in loading state during canonical presence and entity lag, and only marks missing on canonical absence", () => {
    // Canonical presence + entity lag: live snapshot contains thread but entity atom hasn't propagated
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
        canonicalThreadPresent: true,
      }),
    ).toBe("loading");

    // Canonical absence: live snapshot confirms thread is truly absent
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: false,
        serverThreadDeleted: false,
        draftThreadExists: false,
        canonicalThreadPresent: false,
      }),
    ).toBe("missing");

    // Once entity atom catches up and server thread exists, it becomes ready
    expect(
      resolveThreadRouteRenderState({
        bootstrapComplete: true,
        serverThreadExists: true,
        serverThreadDeleted: false,
        draftThreadExists: false,
        canonicalThreadPresent: true,
      }),
    ).toBe("ready");
  });
});
