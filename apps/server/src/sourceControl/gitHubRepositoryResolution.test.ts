import { assert, describe, it } from "@effect/vitest";

import {
  gitHubApiHostForRemote,
  parseGitHubRepositorySelector,
  resolveGitHubRepository,
  selectGitHubBaseRepository,
} from "./gitHubRepositoryResolution.ts";

describe("selectGitHubBaseRepository", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join("\n");
  const select = (input: { remotes: string; resolved?: string }) =>
    selectGitHubBaseRepository({ resolved: "", host: "github.com", ...input });

  it("picks the repository gh reads without a prompt", () => {
    assert.deepStrictEqual(select({ remotes: remotes(["fork", "git@github.com:me/web.git"]) }), {
      owner: "me",
      name: "web",
    });
    const fork = remotes(
      ["origin", "git@github.com:me/web.git"],
      ["upstream", "https://github.com/Acme/Web.git"],
    );
    assert.deepStrictEqual(select({ remotes: fork }), { owner: "acme", name: "web" });
    assert.deepStrictEqual(select({ remotes: fork, resolved: "remote.origin.gh-resolved base" }), {
      owner: "me",
      name: "web",
    });
    assert.deepStrictEqual(
      select({ remotes: fork, resolved: "remote.origin.gh-resolved acme/other" }),
      { owner: "acme", name: "other" },
    );
    // gh ranks remote names in any case.
    assert.deepStrictEqual(
      select({
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Upstream", "git@github.com:acme/web.git"],
        ),
      }),
      { owner: "acme", name: "web" },
    );
  });

  it("resolves GitHub SSH account aliases through github.com", () => {
    for (const url of [
      "git@github.com-scale:acme/web.git",
      "ssh://git@github.com-scale:22/acme/web.git",
      "git@GitHub.com-Work:acme/web.git",
      "git@github-work:acme/web.git",
    ]) {
      assert.deepStrictEqual(select({ remotes: remotes(["origin", url]) }), {
        owner: "acme",
        name: "web",
      });
    }
  });

  it("leaves gh to choose when it might weigh the remotes differently", () => {
    for (const input of [
      { remotes: "" },
      {
        remotes: remotes(["a", "git@github.com:me/web.git"], ["b", "git@github.com:acme/web.git"]),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["mirror", "git@gitlab.com:me/web.git"],
        ),
      },
      { remotes: remotes(["origin", "git@work:me/web.git"]) },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Origin", "git@github.com:acme/web.git"],
        ),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["upstream", "git@github.com:acme/web.git"],
        ),
        resolved: "remote.origin.gh-resolved base\nremote.upstream.gh-resolved base",
      },
    ]) {
      assert.strictEqual(select(input), null);
    }
  });
});

describe("resolveGitHubRepository", () => {
  it("uses github.com for a hinted matching SSH account alias", () => {
    const remote = "git@github.com-scale:me/web.git";
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes: `origin\t${remote} (fetch)`,
        resolved: "",
        hostHint: "GitHub.com-Scale",
        defaultHost: "github.com",
      }),
      {
        host: "github.com",
        locator: { host: "github.com", owner: "me", name: "web" },
      },
    );
  });

  it("preserves dotted hosts when matching remotes are not SSH aliases", () => {
    const remote = "https://github.com-scale/me/web.git";
    assert.deepStrictEqual(
      resolveGitHubRepository({
        remotes: `origin\t${remote} (fetch)`,
        resolved: "",
        hostHint: "github.com-scale",
        defaultHost: "github.com",
      }),
      {
        host: "github.com-scale",
        locator: { host: "github.com-scale", owner: "me", name: "web" },
      },
    );
  });
});

describe("gitHubApiHostForRemote", () => {
  it("reads an SSH alias through github.com and a real host as itself", () => {
    assert.strictEqual(gitHubApiHostForRemote("git@github:acme/web.git"), "github.com");
    assert.strictEqual(
      gitHubApiHostForRemote("git@github.example.com:a/b.git"),
      "github.example.com",
    );
    assert.strictEqual(gitHubApiHostForRemote("git@gitlab.com:a/b.git"), null);
  });
  it("reads github.com-account SSH aliases through github.com without redirecting lookalike hosts", () => {
    for (const remote of [
      "git@github.com-scale:acme/web.git",
      "ssh://git@github.com-scale:22/acme/web.git",
      "git@GitHub.com-Work:acme/web.git",
      "git@github-work:acme/web.git",
    ]) {
      assert.strictEqual(gitHubApiHostForRemote(remote), "github.com");
    }
    assert.strictEqual(
      gitHubApiHostForRemote("git@github.com-evil.example:acme/web.git"),
      "github.com-evil.example",
    );
    assert.strictEqual(
      gitHubApiHostForRemote("https://github.com-scale/acme/web.git"),
      "github.com-scale",
    );
  });
});

describe("parseGitHubRepositorySelector", () => {
  it("drops a clone URL's `.git` suffix before a trailing slash or query", () => {
    for (const [selector, host, name] of [
      ["https://github.com/acme/web.git", "github.com", "web"],
      ["https://github.com/acme/web.git/", "github.com", "web"],
      ["https://github.com/acme/web.git?tab=readme", "github.com", "web"],
      ["https://github.com/acme/web.git.git", "github.com", "web.git"],
      ["https://github.com/acme/web.git.git/", "github.com", "web.git"],
      ["acme/web.git/", "github.com", "web"],
      ["ghe.example.com/acme/web.git/", "ghe.example.com", "web"],
    ] as const) {
      assert.deepStrictEqual(parseGitHubRepositorySelector(selector, "github.com"), {
        host,
        owner: "acme",
        name,
      });
    }
  });
  it("reads host/owner/name only when the host is a plain hostname", () => {
    assert.deepStrictEqual(parseGitHubRepositorySelector("GHE.corp:8443/acme/web", "github.com"), {
      host: "ghe.corp:8443",
      owner: "acme",
      name: "web",
    });
    for (const selector of [
      "evil.com#.ghe.com/acme/web",
      "evil.com?.ghe.com/acme/web",
      "token@evil.com/acme/web",
      "evil.com\\.ghe.com/acme/web",
      "-evil.com/acme/web",
    ]) {
      assert.strictEqual(parseGitHubRepositorySelector(selector, "github.com"), null, selector);
    }
  });
});
