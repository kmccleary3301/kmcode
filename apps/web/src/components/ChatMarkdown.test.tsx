// @vitest-environment jsdom

import { EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { GitHubIcon } from "./Icons";
import { Button } from "./ui/button";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { canUseMarkdownFileShellActions } from "./markdown/markdownContext";
import {
  hasMarkdownFilePrimaryAction,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./markdown/MarkdownLinks";

async function renderChatMarkdownMarkup(element: ReactNode, expectedText?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(element);
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      if (container.querySelector("[data-markdown-error]")) {
        throw new Error("ChatMarkdown compilation failed");
      }
      const markdown = container.querySelector('[data-t3-part="markdown"]');
      const textIsReady =
        expectedText === undefined || markdown?.textContent?.includes(expectedText) === true;
      if (!container.querySelector("[data-markdown-pending]") && textIsReady) break;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for compiled ChatMarkdown");
      }
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      });
    }
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

async function renderChatMarkdownDocument(element: ReactNode, expectedText?: string) {
  return new DOMParser().parseFromString(
    await renderChatMarkdownMarkup(element, expectedText),
    "text/html",
  );
}

function textContent(instance: ReactTestInstance): string {
  return instance.children
    .map((child) => (typeof child === "string" ? child : textContent(child)))
    .join("");
}

async function waitForMarkdownState(renderer: ReactTestRenderer, assertion: () => void) {
  await vi.waitFor(() => {
    expect(renderer.root.findAllByProps({ "data-markdown-pending": "" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ "data-markdown-error": "" })).toHaveLength(0);
    assertion();
  });
}
async function waitForMarkdownSnapshot(renderer: ReactTestRenderer, expectedText?: string) {
  await waitForMarkdownState(renderer, () => {
    if (expectedText !== undefined) {
      const markdown = renderer.root.findByProps({ "data-t3-part": "markdown" });
      expect(textContent(markdown)).toContain(expectedText);
    }
  });
}

function codeButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType(Button)
    .find((instance) => instance.props["aria-label"] === label);
  if (!button) throw new Error(`Missing code button: ${label}`);
  return button.props as ComponentProps<typeof Button>;
}

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      const text = `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`;
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={text} />,
      );

      expect(document.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
        "the link",
      ]);
      expect(document.querySelectorAll("li")).toHaveLength(2);
      expect(
        [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent),
      ).toContain("The deferred move continues on B.");
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={`See <a>label\n\n${closing}\n\nfinish`} />,
      );
      expect(document.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text="See <a>label<script><!-- </script> --></a>" />,
    );
    expect(document.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={`Before <A>.\n\n${html}\n\nAfter.`} />,
      );
      expect(document.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(document.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    const text =
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>';
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={text} />,
    );

    expect([...document.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "label",
      "",
      "docs",
    ]);
    expect(document.querySelector("code")?.textContent).toBe("<A>");
    expect(document.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});
describe("ChatMarkdown GitHub alerts", () => {
  it("recognizes a quote marker and removes it from the rendered content", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={"> [!NOTE]\n> The content of the note."} />,
    );
    const alert = document.querySelector('[role="note"]');

    expect(alert?.textContent).toContain("Note");
    expect(alert?.textContent).toContain("The content of the note.");
    expect(alert?.textContent).not.toContain("[!NOTE]");
  });

  it("keeps content after a marker-only paragraph", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph."}
      />,
    );
    const alert = document.querySelector('[role="note"]');

    expect(alert?.textContent).toContain("Warning");
    expect(alert?.textContent).toContain("A heading");
    expect(alert?.textContent).toContain("And a paragraph.");
    expect(alert?.textContent).not.toContain("[!WARNING]");
  });

  it("recognizes alert markers before inline-formatted content", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"> [!NOTE]\n> **Medium Risk** Changes live transcript routing."}
      />,
    );
    const alert = document.querySelector('[role="note"]');

    expect(alert?.querySelector("strong")?.textContent).toBe("Medium Risk");
    expect(alert?.textContent).toContain("Changes live transcript routing.");
    expect(alert?.textContent).not.toContain("[!NOTE]");
  });

  it("normalizes alert marker case", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={"> [!important]\n> Read this."} />,
    );
    const alert = document.querySelector('[role="note"]');

    expect(alert?.textContent).toContain("Important");
    expect(alert?.textContent).toContain("Read this.");
  });

  it("leaves a marker followed by same-line text as an ordinary quote", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text="> [!NOTE] an ordinary quote" />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector('[role="note"]')).toBeNull();
    expect(markdown?.textContent).toContain("[!NOTE] an ordinary quote");
  });

  it("leaves unknown alert markers as ordinary quote text", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={"> [!DANGER]\n> Not one of GitHub's."} />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector('[role="note"]')).toBeNull();
    expect(markdown?.textContent).toContain("[!DANGER]");
    expect(markdown?.textContent).toContain("Not one of GitHub's.");
  });
});

describe("ChatMarkdown over-indented list recovery", () => {
  it("recovers same-line excess indentation as list text", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`why did you do this?

-       for (const step of rest.steps) {
-           if (step.request.body) {
-               step.request.body = "<redacted>";
-           }
-       }`}
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');
    const itemText = [...(markdown?.querySelectorAll("li") ?? [])].map((item) => item.textContent);

    expect(markdown?.querySelector("pre")).toBeNull();
    expect(itemText).toContain("for (const step of rest.steps) {");
    expect(itemText).toContain("if (step.request.body) {");
    expect(itemText.join("\n")).toContain("step.request.body =");
    expect(itemText.join("\n")).toContain("<redacted>");
  });

  it("parses inline Markdown in recovered list content", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text="-       **important** [docs](https://example.com) use `inline code`, not ~~plain text~~"
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector("strong")?.textContent).toBe("important");
    expect(markdown?.querySelector('a[href="https://example.com"]')?.textContent).toBe("docs");
    expect(markdown?.querySelector("code")?.textContent).toBe("inline code");
    expect(markdown?.querySelector("del")?.textContent).toBe("plain text");
  });

  it("keeps inline Markdown in a paragraph that follows a list", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"- one\n- two\n\nwe should ***heavily*** use `inline code` here"}
      />,
    );
    const paragraph = document.querySelector('[data-t3-part="markdown"] ul + p');

    expect(paragraph?.querySelector("strong")?.textContent).toBe("heavily");
    expect(paragraph?.querySelector("code")?.textContent).toBe("inline code");
    expect(paragraph?.textContent).not.toContain("*");
  });

  it("preserves recovered blocks separated by blank lines", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`-       **first block**

        [second block](https://example.com)`}
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector("strong")?.textContent).toBe("first block");
    expect(markdown?.querySelector('a[href="https://example.com"]')?.textContent).toBe(
      "second block",
    );
  });

  it("recursively recovers nested lists in a list item's tail", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`-       first block

        -       nested block`}
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');
    const outerItem = markdown?.querySelector("li");

    expect(markdown?.querySelector("pre")).toBeNull();
    expect(outerItem?.querySelector("ul li")?.textContent).toContain("nested block");
  });

  it("preserves fenced code inside list items", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`- \`\`\`ts
  const value = 1;
  \`\`\``}
      />,
    );
    const code = document.querySelector("li pre code");

    expect(code?.textContent).toContain("const value = 1;");
  });

  it("preserves indented code that begins below the list marker", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`-
      const value = 1;`}
      />,
    );
    const code = document.querySelector("li pre code");

    expect(code?.textContent).toBe("const value = 1;");
  });

  it("preserves same-line code blocks without excess indentation", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text="-     const value = 1;" />,
    );
    const code = document.querySelector("li pre code");

    expect(code?.textContent).toBe("const value = 1;");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text={text}
            renderContextReference={({ kind, label }) => (
              <button>
                {kind}: {label}
              </button>
            )}
          />,
        );
      });
      await waitForMarkdownSnapshot(renderer!, "Terminal output");
      expect(
        renderer!.root.findAllByType("button").map((button) => button.children.join("")),
      ).toEqual(["terminal: Terminal output", "image: Error image"]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType("a")).toHaveLength(0);
      await act(async () => {
        renderer!.update(<ChatMarkdown cwd={undefined} text={text} />);
      });
      await waitForMarkdownSnapshot(renderer!, "Terminal output");
      expect(renderer!.root.findAllByType("span").map((span) => span.children.join(""))).toEqual([
        "Terminal output",
        "Error image",
      ]);
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const seen: Array<string> = [];
    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown
            cwd={undefined}
            text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
            renderContextReference={({ kind, label }) => {
              seen.push(`${kind}: ${label}`);
              return <button>{label}</button>;
            }}
          />,
        );
      });
      await waitForMarkdownSnapshot(renderer!);
      expect(seen).toEqual(["terminal: Bold code"]);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    try {
      await act(async () => {
        renderer = create(markdown("https://example.com"));
      });
      await waitForMarkdownState(renderer!, () => {
        expect(renderer!.root.findAllByType("img").map((image) => image.props.src)).toEqual([
          "https://www.google.com/s2/favicons?domain=example.com&sz=32",
        ]);
      });
      expect(renderer!.root.findAllByType("img").map((image) => image.props.src)).toEqual([
        "https://www.google.com/s2/favicons?domain=example.com&sz=32",
      ]);
      for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
        await act(async () => {
          renderer!.update(markdown(url));
        });
        await waitForMarkdownState(renderer!, () => {
          expect(renderer!.root.findAllByType("img")).toHaveLength(0);
        });
        expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      }
      await act(async () => {
        renderer!.update(markdown("https://example.com"));
      });
      await waitForMarkdownState(renderer!, () => {
        expect(renderer!.root.findAllByType("img")).toHaveLength(1);
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(1);
      // GitHub links draw the brand mark in currentColor instead of fetching a favicon.
      await act(async () => {
        renderer!.update(markdown("https://github.com/pingdotgg/t3code/pull/1"));
      });
      await waitForMarkdownState(renderer!, () => {
        expect(renderer!.root.findAllByType(GitHubIcon)).toHaveLength(1);
      });
      expect(renderer!.root.findAllByType("img")).toHaveLength(0);
      expect(renderer!.root.findAllByType(GitHubIcon)).toHaveLength(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown bare URLs", () => {
  it("links a bare URL through its port and query, nested URL included", async () => {
    const urls = [
      "http://127.0.0.1:3152/dev/run-curves?preset=dominated&theme=nature",
      "http://127.0.0.1:3152/dev/paper?base=http://127.0.0.1:59410&project=pufferlib/paper",
    ];
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`}
      />,
      "pufferlib/paper",
    );

    expect(
      [...document.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href")),
    ).toEqual(urls);
  });
});

describe("ChatMarkdown Mermaid controls", () => {
  it("uses KM diagram actions and toggles to source code without native copy", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const source = "```mermaid\nflowchart TD\n  A --> B\n```";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={source} />);
      });
      await waitForMarkdownState(renderer!, () => {
        expect(codeButton(renderer!, "Show code")).toBeDefined();
        expect(codeButton(renderer!, "Copy code")).toBeDefined();
        expect(codeButton(renderer!, "Expand diagram")).toBeDefined();
        expect(
          renderer!.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Copy diagram code"),
        ).toBe(false);
        expect(
          renderer!.root.findByProps({ className: "chat-markdown-mermaid" }).props[
            "data-markdown-copy"
          ],
        ).toBe(source);
      });

      await act(async () => {
        codeButton(renderer!, "Show code").onClick?.({} as never);
      });
      await waitForMarkdownState(renderer!, () => {
        expect(codeButton(renderer!, "Show diagram")).toBeDefined();
        expect(
          renderer!.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Expand diagram"),
        ).toBe(false);
        expect(
          renderer!.root
            .findAllByProps({ "data-t3-part": "code" })
            .some((code) => textContent(code).includes("flowchart TD")),
        ).toBe(true);
      });
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown streaming", () => {
  it("matches the static render after appending chunks across Markdown split points", async () => {
    const text = [
      "# Streaming parity",
      "",
      "A **formatted** paragraph with `inline code`.",
      "",
      "- first item",
      "- second item",
      "",
      "> a quoted line",
      "",
      "```ts",
      "const answer = 42;",
      "```",
      "",
      "Final line.",
    ].join("\n");
    const staticDocument = new DOMParser().parseFromString(
      await renderChatMarkdownMarkup(<ChatMarkdown cwd="/tmp/project" text={text} />),
      "text/html",
    );
    const expectedText = staticDocument.querySelector('[data-t3-part="markdown"]')?.textContent;
    if (expectedText === null || expectedText === undefined) {
      throw new Error("Static ChatMarkdown output was not rendered");
    }
    const splitPoints = [
      1,
      text.indexOf("**") + 1,
      text.indexOf("\n-") + 2,
      text.indexOf("```ts") + 4,
      Math.floor(text.length / 2),
      text.length - 1,
    ]
      .filter((point) => point > 0 && point < text.length)
      .filter((point, index, points) => points.indexOf(point) === index)
      .sort((left, right) => left - right);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    let streamedText = "";

    try {
      await act(async () => {
        root.render(<ChatMarkdown cwd="/tmp/project" text="" isStreaming />);
      });
      for (const end of [...splitPoints, text.length]) {
        streamedText = text.slice(0, end);
        await act(async () => {
          root.render(<ChatMarkdown cwd="/tmp/project" text={streamedText} isStreaming />);
        });
      }
      await act(async () => {
        root.render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming={false} />);
      });
      await act(async () => {
        await vi.waitFor(() => {
          expect(container.querySelector('[data-t3-part="markdown"]')?.textContent).toBe(
            expectedText,
          );
        });
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("renders every file link and codespan when history mounts beyond the compiler queue limit", async () => {
    const document = await renderChatMarkdownDocument(
      <>
        {Array.from({ length: 40 }, (_, index) => (
          <section key={index} data-history-message={index}>
            <ChatMarkdown
              cwd="/tmp/project"
              text={`History ${index}: [packet_${index}.md](/tmp/history/packet_${index}.md:12) and \`span_${index}\`.`}
            />
          </section>
        ))}
      </>,
    );
    for (let index = 0; index < 40; index += 1) {
      const message = document.querySelector(`[data-history-message="${index}"]`);
      expect(message?.querySelector("code")?.textContent).toBe(`span_${index}`);
      expect(
        message?.querySelector(".chat-markdown-file-link")?.getAttribute("data-markdown-copy"),
      ).toContain(`/tmp/history/packet_${index}.md:12`);
      expect(message?.textContent).not.toContain(`\`span_${index}\``);
    }
  });

  it("re-parses completed long nested items after streamed chunk boundaries", async () => {
    const path = "/tmp/agent-session-42/docs/a_b.md:18";
    const item = `The **finished emphasis** and \`inline_code\` link to [a_b.md:18](${path}); escaped \\*\\*stars\\*\\* and \`**code text**\` stay literal. ${"completed context ".repeat(36)}`;
    expect(item.length).toBeGreaterThan(512);
    const text = `- Section\n  - ${item}\n  - Follow-up **sibling** and \`tail_code\`.`;
    const assertSemantics = (root: ParentNode) => {
      const markdown = root.querySelector('[data-t3-part="markdown"]');
      expect(markdown).not.toBeNull();
      expect(
        Array.from(markdown?.querySelectorAll("strong") ?? [], (node) => node.textContent),
      ).toEqual(["finished emphasis", "sibling"]);
      expect(
        Array.from(markdown?.querySelectorAll("code") ?? [], (node) => node.textContent),
      ).toEqual(["inline_code", "**code text**", "tail_code"]);
      expect(
        markdown?.querySelector(".chat-markdown-file-link")?.getAttribute("data-markdown-copy"),
      ).toContain(path);
      expect(markdown?.textContent).toContain("completed context completed context");
      expect(markdown?.textContent).toContain("**stars**");
      expect(markdown?.textContent).not.toContain("**finished emphasis**");
      expect(markdown?.textContent).not.toContain("`inline_code`");
      expect(markdown?.textContent).not.toContain(`[a_b.md:18](${path})`);
    };
    const snapshot = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={text} />,
    );
    assertSemantics(snapshot);

    const itemStart = text.indexOf(item);
    const strongOpen = text.indexOf("**", itemStart);
    const strongClose = text.indexOf("**", strongOpen + 2);
    const codeOpen = text.indexOf("`", itemStart);
    const codeClose = text.indexOf("`", codeOpen + 1);
    const linkStart = text.indexOf("[a_b.md:18]", itemStart);
    const linkEnd = text.indexOf("](", linkStart);
    const lineSelector = text.indexOf(":18", linkStart);
    const delimiterSplitPoints = [
      strongOpen + 1,
      strongOpen + 2,
      strongClose + 1,
      strongClose + 2,
      codeOpen,
      codeOpen + 1,
      codeClose,
      codeClose + 1,
      linkStart + 1,
      linkEnd + 1,
      linkEnd + 2,
      text.indexOf("_", linkStart) + 1,
      lineSelector + 2,
      itemStart + 511,
      itemStart + 512,
      itemStart + 513,
      text.length - 1,
    ]
      .filter((point) => point > 0 && point < text.length)
      .filter((point, index, points) => points.indexOf(point) === index)
      .sort((left, right) => left - right);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    for (const chunkEnds of [[text.length], delimiterSplitPoints]) {
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<ChatMarkdown cwd="/tmp/project" text="" isStreaming />);
        });
        for (const end of [...chunkEnds, text.length]) {
          await act(async () => {
            root.render(<ChatMarkdown cwd="/tmp/project" text={text.slice(0, end)} isStreaming />);
          });
        }
        await act(async () => {
          root.render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming={false} />);
        });
        await act(async () => {
          await vi.waitFor(() => assertSemantics(container));
        });
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  });

  it("runs only a complete single-line shell block after a click", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onRunShellCommand = vi.fn();
    let renderer: ReactTestRenderer | undefined;
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    try {
      await act(async () => {
        renderer = create(message("```bash\necho hello\n```", true));
      });
      await waitForMarkdownSnapshot(renderer!, "echo hello");
      const mounted = renderer!;
      expect(
        mounted.root
          .findAllByType(Button)
          .some((button) => button.props["aria-label"] === "Run in terminal"),
      ).toBe(false);

      await act(async () => {
        mounted.update(message("```bash\necho hello\n```"));
      });
      await waitForMarkdownState(mounted, () => {
        expect(
          mounted.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Run in terminal"),
        ).toBe(true);
      });
      await act(async () => {
        codeButton(mounted, "Run in terminal").onClick?.({} as never);
      });
      expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

      for (const text of [
        "~~~bash\necho tilde\n~~~",
        "> ```bash\n> echo quote\n> ```",
        "````bash\necho four\n````",
      ]) {
        await act(async () => {
          mounted.update(message(text));
        });
        await waitForMarkdownState(mounted, () => {
          const visibleText = textContent(mounted.root.findByProps({ "data-t3-part": "markdown" }));
          expect(visibleText).toContain(
            text.includes("tilde")
              ? "echo tilde"
              : text.includes("quote")
                ? "echo quote"
                : "echo four",
          );
          expect(
            mounted.root
              .findAllByType(Button)
              .some((button) => button.props["aria-label"] === "Run in terminal"),
          ).toBe(true);
        });
        expect(codeButton(mounted, "Run in terminal")).toBeDefined();
      }

      for (const text of [
        "```bash\necho one\necho two\n```",
        "```typescript\necho hello\n```",
        "```bash\n\n```",
        "```bash\necho hello\n\n```",
        "```bash\necho hello\\\n```",
        "```bash\necho safe \u202e#\n```",
        "```bash\necho incomplete",
        "~~~bash\necho incomplete",
        "````bash\necho incomplete\n```",
        '<pre><code class="language-bash">echo html</code></pre>',
      ]) {
        await act(async () => {
          mounted.update(message(text));
        });
        await waitForMarkdownState(mounted, () => {
          const visibleText = textContent(mounted.root.findByProps({ "data-t3-part": "markdown" }));
          const expectedText = text.includes("echo one")
            ? "echo one"
            : text.includes("typescript")
              ? "echo hello"
              : text.includes("echo safe")
                ? "echo safe"
                : text.includes("incomplete")
                  ? "echo incomplete"
                  : text.includes("echo html")
                    ? "echo html"
                    : null;
          if (expectedText !== null) expect(visibleText).toContain(expectedText);
          expect(
            mounted.root
              .findAllByType(Button)
              .some((button) => button.props["aria-label"] === "Run in terminal"),
          ).toBe(false);
        });
        expect(
          mounted.root
            .findAllByType(Button)
            .some((button) => button.props["aria-label"] === "Run in terminal"),
        ).toBe(false);
      }
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps code controls and wrapping available when streamed code changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;

    try {
      await act(async () => {
        renderer = create(
          <ChatMarkdown cwd="/tmp/project" text={"```text\ninitial\n```"} isStreaming />,
        );
      });
      await waitForMarkdownSnapshot(renderer!, "initial");
      const mounted = renderer!;
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
      });

      await act(async () => {
        mounted.update(
          <ChatMarkdown cwd="/tmp/project" text={"```text\nrecovered\n```"} isStreaming />,
        );
      });
      await waitForMarkdownSnapshot(mounted, "recovered");
      const updatedCodeBlock = mounted.root.findByProps({ "data-language": "text" });

      expect(textContent(updatedCodeBlock)).toContain("recovered");
      expect(updatedCodeBlock.props["data-wrap"]).toBe(String(!initialWrap));
      expect(codeButton(mounted, initialWrap ? "Wrap lines" : "Disable line wrap")).toBeDefined();
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("preserves code controls and details while streaming text grows", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let renderer: ReactTestRenderer | undefined;
    const text = [
      "```text",
      "First code block",
      "```",
      "",
      "<details><summary>More</summary>",
      "",
      "Details content",
      "",
      "</details>",
      "",
      "Streaming reply",
    ].join("\n");

    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
      });
      const mounted = renderer!;
      await waitForMarkdownSnapshot(mounted, "Streaming reply");
      const codeBlock = mounted.root.findByProps({ "data-language": "text" });
      const initialWrap = codeBlock.props["data-wrap"] === "true";
      const wrap = codeButton(mounted, initialWrap ? "Disable line wrap" : "Wrap lines");
      const copy = codeButton(mounted, "Copy code");
      await act(async () => {
        wrap.onClick?.({} as Parameters<NonNullable<typeof wrap.onClick>>[0]);
        copy.onClick?.({} as Parameters<NonNullable<typeof copy.onClick>>[0]);
      });

      const detailsButton = mounted.root.find(
        (instance) =>
          instance.type === "button" && instance.props["data-markdown-details-summary"] === "",
      );
      await act(async () => {
        detailsButton.props.onClick({ nativeEvent: new Event("click") });
      });
      expect(
        mounted.root.findByProps({ "data-markdown-details": "" }).props[
          "data-markdown-details-open"
        ],
      ).toBe("true");
      expect(writeText).toHaveBeenCalledWith("First code block\n");

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          mounted.update(<ChatMarkdown cwd="/tmp/project" text={`${text} ${index}`} isStreaming />);
        });
        await waitForMarkdownSnapshot(mounted, "Streaming reply");
      }

      const currentCodeBlock = mounted.root.findByProps({ "data-language": "text" });
      expect(textContent(currentCodeBlock)).toContain("First code block");
      expect(currentCodeBlock.props["data-wrap"]).toBe(String(!initialWrap));
      expect(
        mounted.root.findByProps({ "data-markdown-details": "" }).props[
          "data-markdown-details-open"
        ],
      ).toBe("true");
      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text.replace("First code block", "Updated code block")}
            isStreaming
          />,
        );
      });
      await waitForMarkdownSnapshot(mounted, "Updated code block");
      const copyUpdated = codeButton(mounted, "Copied");
      await act(async () => {
        copyUpdated.onClick?.({} as Parameters<NonNullable<typeof copyUpdated.onClick>>[0]);
      });
      expect(writeText).toHaveBeenLastCalledWith("Updated code block\n");
    } finally {
      await act(async () => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    let editedText: string | undefined;
    const message = (text: string) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          renderer!.update(message(editedText));
        }}
      />
    );

    try {
      await act(async () => {
        renderer = create(message("- [ ] First\n- [ ] Second"));
      });
      await waitForMarkdownSnapshot(renderer!, "Second");
      const mounted = renderer!;
      await act(async () => {
        mounted.update(message("- [ ] A longer first task\n- [ ] Second"));
      });
      await waitForMarkdownSnapshot(mounted, "A longer first task");

      const input = mounted.root.findAllByType("input")[1]!;
      const listItem = mounted.root.findAllByType("li")[1]!;
      const { onChange } = input.props as ComponentProps<"input">;
      if (!onChange) throw new Error("Task checkbox has no edit handler");
      await act(async () => {
        onChange({
          currentTarget: {
            checked: true,
            closest: () => ({
              dataset: { taskMarkerOffset: String(listItem.props["data-task-marker-offset"]) },
            }),
          },
        } as unknown as Parameters<typeof onChange>[0]);
      });
      await waitForMarkdownSnapshot(mounted, "A longer first task");
      await waitForMarkdownState(mounted, () => {
        expect(mounted.root.findAllByType("input")[1]?.props.checked).toBe(true);
      });

      expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
      expect(mounted.root.findAllByType("input")[1]!.props.checked).toBe(true);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("canUseMarkdownFileShellActions", () => {
  const environmentId = EnvironmentId.make("environment-1");

  it("allows editor and file manager actions for local environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", true)).toBe(true);
  });

  it("hides shell actions until the environment mode is resolved", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "local-exec", false)).toBe(false);
  });

  it("hides editor and file manager actions for remote environments", () => {
    expect(canUseMarkdownFileShellActions(environmentId, "remote-links", true)).toBe(false);
    expect(canUseMarkdownFileShellActions(environmentId, "remote-unavailable", true)).toBe(false);
  });

  it("hides shell actions when no environment owns the markdown", () => {
    expect(canUseMarkdownFileShellActions(null, "local-exec", true)).toBe(false);
  });
});

describe("hasMarkdownFilePrimaryAction", () => {
  it("keeps the chip interactive when an editor, browser, or panel can open it", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: true,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });

  it("removes the link affordance when no primary action can open the file", () => {
    expect(
      hasMarkdownFilePrimaryAction({
        canOpenInEditor: false,
        canOpenInBrowser: false,
        canOpenInPanel: false,
      }),
    ).toBe(false);
  });
});

describe("ChatMarkdown skill chips", () => {
  it("updates digit-leading skill labels when discovered skills change", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    const text = "Use $2spec with a $20k budget.";
    try {
      await act(async () => {
        renderer = create(<ChatMarkdown cwd="/tmp/project" text={text} />);
      });
      await waitForMarkdownSnapshot(renderer!);
      const mounted = renderer!;
      const labels = (label: string) =>
        mounted.root.findAllByType("span").filter((node) => node.children.includes(label));
      expect(labels("2Spec")).toHaveLength(0);

      await act(async () => {
        mounted.update(
          <ChatMarkdown
            cwd="/tmp/project"
            text={text}
            skills={[
              { name: "2spec", displayName: "2Spec" },
              { name: "20k", displayName: "MoneySkill" },
            ]}
          />,
        );
      });
      await waitForMarkdownState(mounted, () => {
        expect(labels("2Spec")).toHaveLength(1);
      });
      expect(labels("2Spec")).toHaveLength(1);
      expect(labels("MoneySkill")).toHaveLength(0);

      await act(async () => {
        mounted.update(<ChatMarkdown cwd="/tmp/project" text={text} skills={[]} />);
      });
      await waitForMarkdownState(mounted, () => {
        expect(labels("2Spec")).toHaveLength(0);
      });
      expect(labels("2Spec")).toHaveLength(0);
    } finally {
      await act(async () => renderer?.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("ChatMarkdown file option chips", () => {
  it("keeps the fallback button text selectable", async () => {
    const html = await renderChatMarkdownMarkup(
      <ChatMarkdown cwd="/tmp/project" text="[Source](/tmp/project/src/main.ts)" />,
    );

    expect(html).toContain("<button");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain("select-text");
  });

  it.each([true, false])(
    "renders Codex file citations as file chips with parseRawHtml=%s",
    async (parseRawHtml) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="/tmp/project"
          text={
            'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx" purpose="output"}.'
          }
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');
      const chip = markdown?.querySelector(".chat-markdown-file-link");

      expect(markdown?.textContent).not.toContain("codex-file-citation");
      expect(chip).not.toBeNull();
      expect([
        "[report.xlsx](/tmp/project/outputs/report.xlsx)",
        "[report.xlsx](</tmp/project/outputs/report.xlsx>)",
      ]).toContain(chip?.getAttribute("data-markdown-copy"));
      expect(markdown?.textContent).toContain("report.xlsx");
    },
  );

  it("leaves an unfinished streaming citation visible until it is complete", async () => {
    const html = await renderChatMarkdownMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"'}
        isStreaming
      />,
      ":codex-file-citation",
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("leaves malformed and similarly named file directives literal", async () => {
    for (const text of [
      ':codex-file-citation{purpose="output"}',
      ':codex-file-citation-extra{path="/tmp/project/outputs/report.xlsx"}',
    ]) {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={text} />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');

      expect(markdown?.textContent).toContain(text);
      expect(markdown?.querySelector(".chat-markdown-file-link")).toBeNull();
    }
  });

  it("preserves Codex file citation examples inside code", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const html = await renderChatMarkdownMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`Example: \`${directive}\`\n\n\`\`\`text\n${directive}\n\`\`\``}
      />,
    );

    expect(html.match(/:codex-file-citation/g)).toHaveLength(2);
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("preserves escaped Codex file citations as literal text", async () => {
    const html = await renderChatMarkdownMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Example: \\:codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );

    expect(html).toContain(":codex-file-citation");
    expect(html).not.toContain("chat-markdown-file-link");
  });

  it("does not create a nested link for citations inside link text", async () => {
    const directive = ':codex-file-citation{path="/tmp/project/outputs/report.xlsx"}';
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={`[See ${directive}](https://example.com)`} />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.textContent).toContain("codex-file-citation");
    expect(markdown?.querySelector(".chat-markdown-file-link")).toBeNull();
  });

  it("renders file citations created by over-indented list recovery", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'-       Created :codex-file-citation{path="/tmp/project/outputs/report.xlsx"}'}
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector("pre")).toBeNull();
    expect(markdown?.textContent).toContain("Created ");
    expect(markdown?.querySelector(".chat-markdown-file-link")).not.toBeNull();
    expect(markdown?.textContent).toContain("report.xlsx");
  });

  it("disambiguates Codex citations with the same basename", async () => {
    const html = await renderChatMarkdownMarkup(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Changed :codex-file-citation{path="/tmp/project/src/index.ts"} and :codex-file-citation{path="/tmp/project/test/index.ts"}.'
        }
      />,
    );

    expect(html).toContain("index.ts · project/src");
    expect(html).toContain("index.ts · project/test");
  });

  it("preserves rejected citations created by over-indented list recovery", async () => {
    const malformed = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={'Leading text before list.\n\n-       Bad :codex-file-citation{purpose="output"}'}
      />,
    );
    const nestedLink = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          'Leading text before list.\n\n-       [Bad :codex-file-citation{path="/tmp/project/report.xlsx"}](https://example.com)'
        }
      />,
    );
    const malformedMarkdown = malformed.querySelector('[data-t3-part="markdown"]');
    const nestedLinkMarkdown = nestedLink.querySelector('[data-t3-part="markdown"]');

    expect(malformedMarkdown?.querySelector("li")?.textContent).toContain(
      'Bad :codex-file-citation{purpose="output"}',
    );
    expect(nestedLinkMarkdown?.textContent).toContain(
      'Bad :codex-file-citation{path="/tmp/project/report.xlsx"}',
    );
  });
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown artifact-template cards", () => {
  it.each([true, false])(
    "renders the Codex result card with parseRawHtml=%s",
    async (parseRawHtml) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="/tmp/project"
          text={ARTIFACT_TEMPLATE_DIRECTIVE}
          parseRawHtml={parseRawHtml}
          onUseArtifactTemplate={() => undefined}
        />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');
      const card = markdown?.querySelector("[data-chat-markdown-artifact-template]");

      expect(markdown?.textContent).not.toContain("::artifact-template");
      expect(card).not.toBeNull();
      expect(card?.getAttribute("data-artifact-kind")).toBe("document");
      expect(card?.getAttribute("data-markdown-copy")).toBe("Hello World (Document template)\n\n");
      expect(card?.getAttribute("data-skill-name")).toBe("artifact-template-hello-world");
      expect(markdown?.textContent).toContain("Hello World");
      expect(markdown?.textContent).toContain("Document template");
      expect(markdown?.textContent).toContain("Use template");
      expect(markdown?.querySelector("p > div")).toBeNull();
    },
  );

  it("renders a passive card outside a composer-backed timeline", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text={ARTIFACT_TEMPLATE_DIRECTIVE} />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelector("[data-chat-markdown-artifact-template]")).not.toBeNull();
    expect(markdown?.textContent).not.toContain("Use template");
  });

  it("leaves malformed and unfinished artifact-template directives literal", async () => {
    const malformed =
      '::artifact-template{skill_name="artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';
    const unfinished = ARTIFACT_TEMPLATE_DIRECTIVE.slice(0, -1);

    for (const text of [malformed, unfinished]) {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={text} />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');
      expect(markdown?.textContent).toContain("::artifact-template");
      expect(markdown?.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
    }
  });

  it("leaves escaped and similarly named artifact-template directives literal", async () => {
    for (const text of [
      `\\${ARTIFACT_TEMPLATE_DIRECTIVE}`,
      ARTIFACT_TEMPLATE_DIRECTIVE.replace("::artifact-template", "::artifact-template-extra"),
    ]) {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown cwd="/tmp/project" text={text} />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');

      expect(markdown?.textContent).toContain("::artifact-template");
      expect(markdown?.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
    }
  });

  it("preserves artifact-template examples inside code", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={`\`${ARTIFACT_TEMPLATE_DIRECTIVE}\`\n\n\`\`\`text\n${ARTIFACT_TEMPLATE_DIRECTIVE}\n\`\`\``}
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.textContent.match(/::artifact-template/g)).toHaveLength(2);
    expect(markdown?.querySelector("[data-chat-markdown-artifact-template]")).toBeNull();
  });
});

describe("ChatMarkdown heading levels", () => {
  it("exposes headings below the host heading without changing their tags", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={"# Top\n\n## Section\n\n###### Fine print"}
        headingLevelOffset={3}
      />,
    );

    expect(document.querySelector("h1")?.textContent).toBe("Top");
    expect(document.querySelector("h1")?.getAttribute("data-t3-part")).toBe("heading");
    expect(document.querySelector("h1")?.getAttribute("aria-level")).toBe("4");
    expect(document.querySelector("h2")?.textContent).toBe("Section");
    expect(document.querySelector("h2")?.getAttribute("aria-level")).toBe("5");
    expect(document.querySelector("h6")?.textContent).toBe("Fine print");
    expect(document.querySelector("h6")?.getAttribute("aria-level")).toBe("6");
  });

  it("leaves heading levels alone when the markdown is not nested", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown cwd="/tmp/project" text="# Top" />,
    );
    const heading = document.querySelector("h1");

    expect(heading?.getAttribute("data-t3-part")).toBe("heading");
    expect(heading?.hasAttribute("aria-level")).toBe(false);
    expect(heading?.textContent).toBe("Top");
  });
});

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("uses the browser when it is the only available primary action", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(true);
  });

  it("preserves the normal editor and panel defaults for HTML files", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: false,
      }),
    ).toBe(false);
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.html",
        canOpenInEditor: false,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(false);
  });

  it("continues to open PDF files in the browser by default", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        iconPath: "/tmp/report.pdf",
        canOpenInEditor: true,
        canOpenInBrowser: true,
        canOpenInPanel: true,
      }),
    ).toBe(true);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");

  it.each([true, false])("preserves drive paths with parseRawHtml=%s", async (parseRawHtml) => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text="[Open](C:/Users/shawn/project/src/main.ts)"
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    const link = document.querySelector('a[href="C:/Users/shawn/project/src/main.ts"]');

    expect(link).not.toBeNull();
    expect(link?.closest(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])("normalizes backslashes with parseRawHtml=%s", async (parseRawHtml) => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={String.raw`[Open](C:\Users\shawn\project\src\main.ts)`}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    const link = document.querySelector('a[href="C:/Users/shawn/project/src/main.ts"]');

    expect(link).not.toBeNull();
    expect(link?.closest(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])(
    "keeps backslashes CommonMark would read as escapes with parseRawHtml=%s",
    async (parseRawHtml) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[settings](C:\Users\shawn\.claude\settings.json)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );

      expect(
        document.querySelector('a[href="C:/Users/shawn/.claude/settings.json"]'),
      ).not.toBeNull();
    },
  );

  it.each([true, false])(
    "distinguishes same-named backslash paths with parseRawHtml=%s",
    async (parseRawHtml) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={String.raw`[Source](C:\Users\shawn\project\src\index.ts) and [Test](C:\Users\shawn\project\test\index.ts)`}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');

      expect(markdown?.textContent).toContain("index.ts · project/src");
      expect(markdown?.textContent).toContain("index.ts · project/test");
    },
  );

  it.each([true, false])(
    "does not disambiguate the same file in links and inline code with parseRawHtml=%s",
    async (parseRawHtml) => {
      const path = String.raw`C:\Users\shawn\project\src\main.ts`;
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text={`[Source](${path}) and \`${path}\``}
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');

      expect(markdown?.querySelectorAll(".chat-markdown-file-link")).toHaveLength(2);
      expect(markdown?.textContent).not.toContain("main.ts ·");
    },
  );

  it.each([true, false])("preserves reference links with parseRawHtml=%s", async (parseRawHtml) => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="C:/Users/shawn/project"
        environmentId={environmentId}
        text={"[Open][source]\n\n[source]: C:/Users/shawn/project/src/main.ts"}
        lineBreaks={!parseRawHtml}
        parseRawHtml={parseRawHtml}
      />,
    );
    const link = document.querySelector('a[href="C:/Users/shawn/project/src/main.ts"]');

    expect(link).not.toBeNull();
    expect(link?.closest(".chat-markdown-file-link")).not.toBeNull();
  });

  it.each([true, false])(
    "still rejects unsafe schemes with parseRawHtml=%s",
    async (parseRawHtml) => {
      const document = await renderChatMarkdownDocument(
        <ChatMarkdown
          cwd="C:/Users/shawn/project"
          environmentId={environmentId}
          text="[unsafe](javascript:alert(1)) and [unknown](d:alert(1)) and [handler](vscode://file/x)"
          lineBreaks={!parseRawHtml}
          parseRawHtml={parseRawHtml}
        />,
      );
      const markdown = document.querySelector('[data-t3-part="markdown"]');

      expect(markdown?.querySelector('a[href^="javascript:"]')).toBeNull();
      expect(markdown?.querySelector('a[href^="vscode:"]')).toBeNull();
      expect(markdown?.textContent).not.toContain("d:alert");
      expect(markdown?.querySelector(".chat-markdown-file-link")).toBeNull();
    },
  );
});

describe("ChatMarkdown math and graphics safety", () => {
  it("typesets accessible inline and display math without trusting TeX links", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          "Inline $x^2$ and legacy $$y^2$$ costs $20 and $30.\n\n$$\n\\frac{1}{2}\n$$\n\n$$\\href{javascript:alert(1)}{unsafe}$$"
        }
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.querySelectorAll("math msup")).toHaveLength(2);
    expect(markdown?.textContent).toContain("costs $20 and $30.");
    expect(markdown?.querySelector("math mfrac")).not.toBeNull();
    expect(markdown?.querySelector('math[display="block"]')).not.toBeNull();
    expect(markdown?.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("keeps emphasis that spans two currency amounts on one line", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          "- **The recorded total is about $0.02.** The earlier turn cost $0.084.\n- Between $5 and $x^2$ we pay $20 for *one $30 item*."
        }
      />,
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(
      Array.from(markdown?.querySelectorAll("strong, em") ?? [], (node) => node.textContent),
    ).toEqual(["The recorded total is about $0.02.", "one $30 item"]);
    expect(markdown?.querySelectorAll("math msup")).toHaveLength(1);
    expect(markdown?.textContent).toContain("The earlier turn cost $0.084.");
    expect(markdown?.textContent).toContain("Between $5 and");
  });

  it("keeps authored SVG as escaped source while the response streams", async () => {
    const document = await renderChatMarkdownDocument(
      <ChatMarkdown
        cwd="/tmp/project"
        isStreaming
        text={
          '<svg id="hostile-model-svg" xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><text>Label</text></svg>'
        }
      />,
      "hostile-model-svg",
    );
    const markdown = document.querySelector('[data-t3-part="markdown"]');

    expect(markdown?.textContent).toContain("<svg");
    expect(markdown?.querySelector("#hostile-model-svg")).toBeNull();
    expect(markdown?.querySelector("script")).toBeNull();
  });
});
