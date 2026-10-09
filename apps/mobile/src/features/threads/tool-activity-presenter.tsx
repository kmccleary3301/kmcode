import {
  formatActivityDetailValue,
  type ActivityDetailBlock,
  type ActivityDetailDiffRow,
  type ActivityDetailListingRow,
  type ActivityDetailSection,
  type ParsedActivityDetail,
} from "@t3tools/client-runtime/activity-details";
import { useEffect, useId, useState } from "react";
import { Image, Pressable, ScrollView, Text as NativeText, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { PresentationSource } from "../../components/NativePresentation";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { cn } from "../../lib/cn";
import { MOBILE_CODE_SURFACE } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  DiffTokenText,
  renderVisibleWhitespace,
  REVIEW_MONO_FONT_FAMILY,
} from "../review/reviewDiffRendering";
import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";
import { highlightCodeSnippet } from "../review/shikiReviewHighlighter";

function useHighlightedTokens(
  lines: ReadonlyArray<string>,
  language: string | null,
): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> | null {
  const { themeAppearance } = useAppearancePreferences();
  const [tokens, setTokens] = useState<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> | null>(
    null,
  );
  const joinedCode = lines.join("\n");

  useEffect(() => {
    let active = true;
    setTokens(null);
    void highlightCodeSnippet({
      code: joinedCode,
      language,
      theme: themeAppearance,
    }).then(
      (next) => {
        if (active) setTokens(next);
      },
      () => {
        if (active) setTokens([]);
      },
    );
    return () => {
      active = false;
    };
  }, [joinedCode, language, themeAppearance]);

  return tokens;
}

function HighlightedLines(props: {
  readonly lines: ReadonlyArray<string>;
  readonly language: string | null;
  readonly changes?: ReadonlyArray<"add" | "delete" | undefined>;
}) {
  const tokens = useHighlightedTokens(props.lines, props.language);
  return (
    <View>
      {props.lines.map((line, index) => (
        <DiffTokenText
          key={`${index}:${line}`}
          tokens={tokens?.[index] ?? null}
          fallback={line}
          change={props.changes?.[index]}
          lineHeight={MOBILE_CODE_SURFACE.rowHeight}
        />
      ))}
    </View>
  );
}

function WrappedHighlightedLine(props: {
  readonly code: string;
  readonly language: string | null;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const [tokens, setTokens] = useState<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setTokens(null);
    void highlightCodeSnippet({
      code: props.code,
      language: props.language,
      theme: themeAppearance,
    }).then(
      (next) => {
        if (active) setTokens(next);
      },
      () => {
        if (active) setTokens([]);
      },
    );
    return () => {
      active = false;
    };
  }, [props.code, props.language, themeAppearance]);

  const line = tokens?.[0];
  return (
    <NativeText
      selectable
      className="font-normal text-foreground"
      style={{
        flexShrink: 1,
        fontFamily: REVIEW_MONO_FONT_FAMILY,
        fontSize: MOBILE_CODE_SURFACE.fontSize,
        lineHeight: MOBILE_CODE_SURFACE.rowHeight,
      }}
    >
      {line && line.length > 0
        ? line.map((token, index) => (
            <NativeText
              key={`${index}:${token.content.length}:${token.color ?? ""}:${token.fontStyle ?? ""}`}
              selectable
              style={{
                color: token.color ?? undefined,
                fontFamily: REVIEW_MONO_FONT_FAMILY,
                fontWeight:
                  token.fontStyle !== null && (token.fontStyle & 2) === 2
                    ? ("700" as const)
                    : ("500" as const),
                fontStyle:
                  token.fontStyle !== null && (token.fontStyle & 1) === 1
                    ? ("italic" as const)
                    : ("normal" as const),
              }}
            >
              {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
            </NativeText>
          ))
        : renderVisibleWhitespace(props.code)}
    </NativeText>
  );
}

function CodeBlock(props: { readonly block: Extract<ActivityDetailBlock, { kind: "code" }> }) {
  const lines = props.block.code.replace(/\r\n?/g, "\n").split("\n");
  return (
    <View className="rounded-md bg-md-code-bg px-2 py-1">
      {props.block.title ? (
        <Text className="mb-1 text-3xs text-foreground-muted">{props.block.title}</Text>
      ) : null}
      {props.block.softWrap ? (
        <WrappedHighlightedLine code={props.block.code} language={props.block.language} />
      ) : (
        <ScrollView horizontal nestedScrollEnabled>
          <HighlightedLines lines={lines} language={props.block.language} />
        </ScrollView>
      )}
    </View>
  );
}

function ListingBlock(props: {
  readonly block: Extract<ActivityDetailBlock, { kind: "listing" }>;
}) {
  const codeRows = props.block.rows.filter((row) => row.kind !== "gap");
  const lines = codeRows.map((row) => row.text);
  const tokens = useHighlightedTokens(lines, props.block.language);
  let tokenIndex = 0;
  return (
    <View className="rounded-md bg-md-code-bg py-1">
      {props.block.path ? (
        <View className="flex-row gap-1 px-2 pb-1">
          <Text className="font-mono text-3xs text-foreground-muted">{props.block.path}</Text>
          {props.block.tag ? (
            <Text className="font-mono text-3xs text-foreground-muted">#{props.block.tag}</Text>
          ) : null}
        </View>
      ) : null}
      <View>
        {props.block.rows.map((row, index) => {
          const rowTokens = row.kind === "gap" ? null : (tokens?.[tokenIndex++] ?? null);
          return (
            <ListingRow
              key={`${index}:${row.gutter}:${row.text}`}
              row={row}
              tokens={rowTokens}
              change={row.kind === "match" ? "add" : undefined}
            />
          );
        })}
      </View>
      {props.block.notes.map((note, index) => (
        <Text key={`${index}:${note}`} className="px-2 pt-1 text-3xs text-foreground-muted">
          {note}
        </Text>
      ))}
    </View>
  );
}

function ListingRow(props: {
  readonly row: ActivityDetailListingRow;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly change?: "add" | "delete";
}) {
  if (props.row.kind === "gap") {
    return <Text className="px-2 font-mono text-2xs text-foreground-muted">…</Text>;
  }
  return (
    <View className={cn("flex-row", props.row.kind !== "context" && "bg-primary/10")}>
      <NativeText
        className="select-none pr-2 text-right text-foreground-tertiary"
        style={{
          width: 56,
          fontFamily: REVIEW_MONO_FONT_FAMILY,
          fontSize: 11,
          lineHeight: MOBILE_CODE_SURFACE.rowHeight,
        }}
      >
        {props.row.gutter}
      </NativeText>
      <View className="flex-1">
        <DiffTokenText
          tokens={props.tokens}
          fallback={props.row.text}
          change={props.change}
          lineHeight={MOBILE_CODE_SURFACE.rowHeight}
        />
      </View>
    </View>
  );
}

function DiffBlock(props: { readonly block: Extract<ActivityDetailBlock, { kind: "diff" }> }) {
  const codeRows = props.block.rows.filter(
    (row) => row.kind === "added" || row.kind === "removed" || row.kind === "context",
  );
  const lines = codeRows.map((row) => row.text);
  const tokens = useHighlightedTokens(lines, props.block.language);
  let tokenIndex = 0;
  return (
    <View className="rounded-md bg-md-code-bg py-1">
      {props.block.path ? (
        <Text className="px-2 pb-1 font-mono text-3xs text-foreground-muted">
          {props.block.path}
        </Text>
      ) : null}
      {props.block.rows.map((row, index) => {
        const hasCode = row.kind === "added" || row.kind === "removed" || row.kind === "context";
        const rowTokens = hasCode ? (tokens?.[tokenIndex++] ?? null) : null;
        const change = row.kind === "added" ? "add" : row.kind === "removed" ? "delete" : undefined;
        return (
          <DiffRow
            key={`${index}:${row.kind}:${row.text}`}
            row={row}
            tokens={rowTokens}
            change={change}
            hashLine={props.block.hashLine}
          />
        );
      })}
    </View>
  );
}

function DiffRow(props: {
  readonly row: ActivityDetailDiffRow;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly change?: "add" | "delete";
  readonly hashLine: boolean;
}) {
  if (props.row.kind === "hunk" || props.row.kind === "marker") {
    return (
      <Text className="px-2 font-mono text-2xs text-foreground-muted">{props.row.text || " "}</Text>
    );
  }
  return (
    <View
      className={cn(
        "flex-row",
        props.change === "add" && "bg-emerald-500/10",
        props.change === "delete" && "bg-rose-500/10",
      )}
    >
      {props.hashLine ? (
        <NativeText
          className="select-none pr-2 text-right text-foreground-tertiary"
          style={{
            width: 56,
            fontFamily: REVIEW_MONO_FONT_FAMILY,
            fontSize: 11,
            lineHeight: MOBILE_CODE_SURFACE.rowHeight,
          }}
        >
          {props.row.newLine ?? props.row.oldLine ?? ""}
        </NativeText>
      ) : (
        <>
          <NativeText
            className="select-none pr-1 text-right text-foreground-tertiary"
            style={{
              width: 36,
              fontFamily: REVIEW_MONO_FONT_FAMILY,
              fontSize: 11,
              lineHeight: MOBILE_CODE_SURFACE.rowHeight,
            }}
          >
            {props.row.oldLine ?? ""}
          </NativeText>
          <NativeText
            className="select-none pr-2 text-right text-foreground-tertiary"
            style={{
              width: 36,
              fontFamily: REVIEW_MONO_FONT_FAMILY,
              fontSize: 11,
              lineHeight: MOBILE_CODE_SURFACE.rowHeight,
            }}
          >
            {props.row.newLine ?? ""}
          </NativeText>
        </>
      )}
      <View className="flex-1">
        <DiffTokenText
          tokens={props.tokens}
          fallback={props.row.text}
          change={props.change}
          lineHeight={MOBILE_CODE_SURFACE.rowHeight}
        />
      </View>
    </View>
  );
}

function StructuredBlock(props: {
  readonly block: Extract<ActivityDetailBlock, { kind: "structured" }>;
}) {
  return (
    <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
      {formatActivityDetailValue(props.block)}
    </Text>
  );
}

function ImageBlock(props: {
  readonly block: Extract<ActivityDetailBlock, { kind: "image" }>;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
}) {
  const sourceIdentifier = useId();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.block.source]);
  return (
    <PresentationSource identifier={sourceIdentifier} style={{ alignSelf: "stretch" }}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={props.block.alt}
        onPress={() =>
          props.onPressPreview?.({
            kind: "image",
            uri: props.block.source,
            name: props.block.alt,
            sourceIdentifier,
          })
        }
        className="overflow-hidden rounded-[10px] bg-md-code-bg"
      >
        {failed ? (
          <View className="h-40 items-center justify-center">
            <Text className="text-xs text-foreground-muted">Image unavailable</Text>
          </View>
        ) : (
          <Image
            source={{ uri: props.block.source }}
            resizeMode="contain"
            onError={() => setFailed(true)}
            className="h-40 w-full"
            accessibilityLabel={props.block.alt}
          />
        )}
      </Pressable>
    </PresentationSource>
  );
}

function DetailBlock(props: {
  readonly block: ActivityDetailBlock;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
}) {
  switch (props.block.kind) {
    case "status":
      return (
        <View className="rounded-md bg-md-code-bg px-2 py-1">
          <View className="flex-row flex-wrap gap-x-2">
            <Text selectable className="font-t3-medium text-xs text-foreground">
              {props.block.label}
            </Text>
            <Text selectable className="text-xs text-foreground-muted">
              {props.block.status}
            </Text>
          </View>
          {props.block.description ? (
            <Text selectable className="text-3xs leading-snug text-foreground-muted">
              {props.block.description}
            </Text>
          ) : null}
        </View>
      );
    case "image":
      return <ImageBlock block={props.block} onPressPreview={props.onPressPreview} />;
    case "code":
      return <CodeBlock block={props.block} />;
    case "target":
      return (
        <Text selectable className="text-xs leading-snug text-foreground-muted">
          {props.block.text}
        </Text>
      );
    case "options":
      return (
        <View className="flex-row flex-wrap gap-x-2 gap-y-1">
          {props.block.entries.map((entry, index) => (
            <Text
              key={`${index}:${entry.key}:${entry.value}`}
              selectable
              className="font-mono text-3xs text-foreground-muted"
            >
              {entry.key} <NativeText className="text-foreground">{entry.value}</NativeText>
            </Text>
          ))}
        </View>
      );
    case "listing":
      return <ListingBlock block={props.block} />;
    case "diff":
      return <DiffBlock block={props.block} />;
    case "structured":
      return <StructuredBlock block={props.block} />;
    case "text":
      return (
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {props.block.text}
        </Text>
      );
  }
}

function DetailSection(props: {
  readonly section: ActivityDetailSection;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
}) {
  return (
    <View className="gap-1">
      {props.section.description ? (
        <Text className="font-t3-medium text-xs text-foreground">{props.section.description}</Text>
      ) : null}
      <Text className="font-t3-medium text-3xs uppercase text-foreground-muted">
        {props.section.title}
      </Text>
      {props.section.blocks.map((block, index) => (
        <DetailBlock
          key={`${index}:${block.kind}`}
          block={block}
          onPressPreview={props.onPressPreview}
        />
      ))}
    </View>
  );
}

export function ToolActivityPresenter(props: {
  readonly detail: ParsedActivityDetail;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
}) {
  return (
    <ScrollView
      nestedScrollEnabled
      directionalLockEnabled
      showsVerticalScrollIndicator
      className="max-h-60"
      contentContainerStyle={{ gap: 12, paddingRight: 8 }}
    >
      {props.detail.sections.map((section) => (
        <DetailSection
          key={section.title}
          section={section}
          onPressPreview={props.onPressPreview}
        />
      ))}
    </ScrollView>
  );
}
