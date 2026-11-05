import * as Schema from "effect/Schema";

export const APERTURE_EMBED_PROTOCOL = 1;

export type ApertureEmbedMode =
  | { readonly kind: "pinned"; readonly asOf: string }
  | { readonly kind: "live" };

export const APERTURE_EMBED_THEME_COLOR_ROLES = [
  "page",
  "card",
  "inset",
  "raised",
  "border",
  "borderStrong",
  "text",
  "textSecondary",
  "textMuted",
  "textFaint",
  "accent",
  "warning",
  "danger",
] as const;
export type ApertureEmbedThemeColorRole = (typeof APERTURE_EMBED_THEME_COLOR_ROLES)[number];

export type ApertureEmbedTheme = {
  readonly appearance: "light" | "dark";
  /** A registered Aperture theme id; empty when the host sends `colors` instead. */
  readonly vizTheme: string;
  /** The host palette, laid over Aperture's appearance default when `vizTheme` does not resolve. */
  readonly colors?: Readonly<Partial<Record<ApertureEmbedThemeColorRole, string>>>;
  readonly tokens: Readonly<Record<string, string>>;
};

export type ApertureEmbedKind = "figure" | "widget";

export const APERTURE_FETCH_ERROR_CODES: readonly [
  "unreachable",
  "unauthorized",
  "forbidden",
  "policy_denied",
  "pinned_live_denied",
  "too_large",
  "too_many_streams",
  "aborted",
  "bad_response",
  "invalid_ref",
] = [
  "unreachable",
  "unauthorized",
  "forbidden",
  "policy_denied",
  "pinned_live_denied",
  "too_large",
  "too_many_streams",
  "aborted",
  "bad_response",
  "invalid_ref",
];
export const ApertureFetchErrorCode = Schema.Literals(APERTURE_FETCH_ERROR_CODES);
export type ApertureFetchErrorCode = typeof ApertureFetchErrorCode.Type;

export const ApertureEmbedInit = Schema.Struct({
  v: Schema.Literal(APERTURE_EMBED_PROTOCOL),
  type: Schema.Literal("embed/init"),
  kind: Schema.Literals(["figure", "widget"]),
  spec: Schema.optionalKey(Schema.Unknown),
  widget: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      version: Schema.String,
      code: Schema.String,
    }),
  ),
  entity: Schema.String,
  project: Schema.String,
  theme: Schema.Struct({
    appearance: Schema.Literals(["light", "dark"]),
    vizTheme: Schema.String,
    colors: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    tokens: Schema.Record(Schema.String, Schema.String),
  }),
  mode: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("pinned"), asOf: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("live") }),
  ]),
  size: Schema.Struct({ width: Schema.Number, maxHeight: Schema.Number }),
});
export type ApertureEmbedInit = typeof ApertureEmbedInit.Type;

export type ApertureEmbedThemeMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/theme";
  readonly theme: ApertureEmbedTheme;
};

export type ApertureEmbedModeMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/mode";
  readonly mode: ApertureEmbedMode;
};

export type ApertureEmbedVisibilityMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/visibility";
  readonly visible: boolean;
};

export type ApertureEmbedFetchHeadMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch-head";
  readonly id: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
};

export type ApertureEmbedFetchChunkMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch-chunk";
  readonly id: string;
  readonly bytes: ArrayBuffer;
};

export type ApertureEmbedFetchEndMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch-end";
  readonly id: string;
};

export type ApertureEmbedFetchErrorMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch-error";
  readonly id: string;
  readonly code: ApertureFetchErrorCode;
  readonly message: string;
};

export type ApertureEmbedHostMessage =
  | ApertureEmbedInit
  | ApertureEmbedThemeMessage
  | ApertureEmbedModeMessage
  | ApertureEmbedVisibilityMessage
  | ApertureEmbedFetchHeadMessage
  | ApertureEmbedFetchChunkMessage
  | ApertureEmbedFetchEndMessage
  | ApertureEmbedFetchErrorMessage;

export type ApertureEmbedReadyMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/ready";
  readonly protocol: typeof APERTURE_EMBED_PROTOCOL;
  readonly runtimeVersion: string;
};

export type ApertureEmbedFetchMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch";
  readonly id: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body: string | null;
  readonly accept: string | null;
};

export type ApertureEmbedFetchAbortMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/fetch-abort";
  readonly id: string;
};

export type ApertureEmbedSizeMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/size";
  readonly height: number;
};

export type ApertureEmbedErrorMessage = {
  readonly v: typeof APERTURE_EMBED_PROTOCOL;
  readonly type: "embed/error";
  readonly code: "spec_invalid" | "widget_compile" | "widget_runtime" | "data" | "protocol";
  readonly message: string;
  readonly detail?: string;
};

export type ApertureEmbedFrameMessage =
  | ApertureEmbedReadyMessage
  | ApertureEmbedFetchMessage
  | ApertureEmbedFetchAbortMessage
  | ApertureEmbedSizeMessage
  | ApertureEmbedErrorMessage;

export type ApertureEmbedMessage = ApertureEmbedHostMessage | ApertureEmbedFrameMessage;

export const ApertureEmbedReferenceSchema = Schema.Struct({
  refId: Schema.String.check(Schema.isNonEmpty()),
  kind: Schema.Literals(["figure", "widget"]),
  spec: Schema.optionalKey(Schema.Unknown),
  widget: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String.check(Schema.isNonEmpty()),
      version: Schema.String.check(Schema.isNonEmpty()),
    }),
  ),
  entity: Schema.String.check(Schema.isNonEmpty()),
  project: Schema.String.check(Schema.isNonEmpty()),
  title: Schema.String.check(Schema.isNonEmpty()),
  height: Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
  mode: Schema.Literals(["pinned", "live"]),
  asOf: Schema.String.check(Schema.isNonEmpty()),
  /** The Aperture theme the agent chose for this render; absent means follow the active KM Code theme. */
  vizTheme: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  runtime: Schema.Struct({ version: Schema.String.check(Schema.isNonEmpty()) }),
  webUrl: Schema.optionalKey(Schema.String),
  embedToken: Schema.String.check(Schema.isNonEmpty()),
});
export type ApertureEmbedReference = typeof ApertureEmbedReferenceSchema.Type;
export const isApertureEmbedReference = Schema.is(ApertureEmbedReferenceSchema);

/** Canonical JSON fields signed by `aperture-embed-signing-key`. */
export const ApertureEmbedTokenPayloadSchema = Schema.Struct({
  refId: Schema.String.check(Schema.isNonEmpty()),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  entity: Schema.String.check(Schema.isNonEmpty()),
  project: Schema.String.check(Schema.isNonEmpty()),
  asOf: Schema.String.check(Schema.isNonEmpty()),
});
export type ApertureEmbedTokenPayload = typeof ApertureEmbedTokenPayloadSchema.Type;

export type ApertureEmbedTokenIssueInput = ApertureEmbedTokenPayload;

export type ApertureEmbedTokenVerificationInput = {
  readonly token: string;
  readonly threadId: string;
};

export type ApertureEmbedTokenVerificationResult = ApertureEmbedTokenPayload;
export function isApertureEmbedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isApertureEmbedRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isHeaderPairs(value: unknown): value is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

export function isApertureEmbedMode(value: unknown): value is ApertureEmbedMode {
  return (
    isApertureEmbedRecord(value) &&
    (value.kind === "live" || (value.kind === "pinned" && isNonEmptyString(value.asOf)))
  );
}

export function isApertureEmbedTheme(value: unknown): value is ApertureEmbedTheme {
  const roles: readonly string[] = APERTURE_EMBED_THEME_COLOR_ROLES;
  return (
    isApertureEmbedRecord(value) &&
    (value.appearance === "light" || value.appearance === "dark") &&
    typeof value.vizTheme === "string" &&
    (value.colors === undefined ||
      (isApertureEmbedRecord(value.colors) &&
        Object.entries(value.colors).every(
          ([role, color]) => roles.includes(role) && typeof color === "string",
        ))) &&
    isStringRecord(value.tokens)
  );
}

export function isApertureFetchErrorCode(value: unknown): value is ApertureFetchErrorCode {
  return Schema.is(ApertureFetchErrorCode)(value);
}

export function isApertureEmbedHostMessage(value: unknown): value is ApertureEmbedHostMessage {
  if (
    !isApertureEmbedRecord(value) ||
    value.v !== APERTURE_EMBED_PROTOCOL ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "embed/init":
      return (
        (value.kind === "figure" || value.kind === "widget") &&
        isNonEmptyString(value.entity) &&
        isNonEmptyString(value.project) &&
        isApertureEmbedTheme(value.theme) &&
        isApertureEmbedMode(value.mode) &&
        isApertureEmbedRecord(value.size) &&
        typeof value.size.width === "number" &&
        typeof value.size.maxHeight === "number" &&
        (value.widget === undefined ||
          (isApertureEmbedRecord(value.widget) &&
            isNonEmptyString(value.widget.id) &&
            isNonEmptyString(value.widget.version) &&
            typeof value.widget.code === "string"))
      );
    case "embed/theme":
      return isApertureEmbedTheme(value.theme);
    case "embed/mode":
      return isApertureEmbedMode(value.mode);
    case "embed/visibility":
      return typeof value.visible === "boolean";
    case "embed/fetch-head":
      return (
        isNonEmptyString(value.id) &&
        typeof value.status === "number" &&
        typeof value.statusText === "string" &&
        isHeaderPairs(value.headers)
      );
    case "embed/fetch-chunk":
      return (
        isNonEmptyString(value.id) &&
        typeof ArrayBuffer !== "undefined" &&
        value.bytes instanceof ArrayBuffer
      );
    case "embed/fetch-end":
      return isNonEmptyString(value.id);
    case "embed/fetch-error":
      return (
        isNonEmptyString(value.id) &&
        isApertureFetchErrorCode(value.code) &&
        typeof value.message === "string"
      );
    default:
      return false;
  }
}

export function isApertureEmbedFrameMessage(value: unknown): value is ApertureEmbedFrameMessage {
  if (
    !isApertureEmbedRecord(value) ||
    value.v !== APERTURE_EMBED_PROTOCOL ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "embed/ready":
      return value.protocol === APERTURE_EMBED_PROTOCOL && isNonEmptyString(value.runtimeVersion);
    case "embed/fetch":
      return (
        isNonEmptyString(value.id) &&
        (value.method === "GET" || value.method === "POST") &&
        typeof value.path === "string" &&
        (value.body === null || typeof value.body === "string") &&
        (value.accept === null || typeof value.accept === "string")
      );
    case "embed/fetch-abort":
      return isNonEmptyString(value.id);
    case "embed/size":
      return typeof value.height === "number";
    case "embed/error":
      return (
        (value.code === "spec_invalid" ||
          value.code === "widget_compile" ||
          value.code === "widget_runtime" ||
          value.code === "data" ||
          value.code === "protocol") &&
        typeof value.message === "string" &&
        (value.detail === undefined || typeof value.detail === "string")
      );
    default:
      return false;
  }
}
