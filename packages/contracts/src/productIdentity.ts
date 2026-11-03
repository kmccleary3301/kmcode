import * as Schema from "effect/Schema";

/**
 * Build-time product profiles. Both profiles use the KM Code display brand;
 * `upstream` and `pi-omp` retain their compatibility identifiers so existing
 * installs, pairing, and provider selection continue to work.
 */
export const ProductProfile = Schema.Literals(["upstream", "pi-omp"]);
export type ProductProfile = typeof ProductProfile.Type;

export type ProductBuildStage = "Dev" | "Nightly" | "Local" | "Preview";

export interface ProductIdentity {
  readonly profile: ProductProfile;
  readonly baseName: string;
  readonly packageName: string;
  readonly cliBinaryName: string;
  readonly bundleIdentifier: string;
  readonly productionScheme: string;
  readonly developmentScheme: string;
  readonly stateDirectoryName: string;
  readonly legacyStableDisplayName: string;
  readonly legacyDevelopmentDisplayName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly linuxUrlHandlerDesktopEntryName: string;
  readonly releaseTagPrefix: string;
  readonly artifactNamePrefix: string;
}

/** The owner-controlled repository used for private desktop update metadata. */
export const PRODUCT_UPDATE_REPOSITORY_ENV = "T3CODE_DESKTOP_UPDATE_REPOSITORY";

export type ProductEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveProductUpdateRepository(
  profile: ProductProfile,
  environment: ProductEnvironment = {},
): string | undefined {
  const configured = environment[PRODUCT_UPDATE_REPOSITORY_ENV]?.trim();
  if (profile === "pi-omp" && configured === undefined) return undefined;
  return configured && configured.length > 0 ? configured : undefined;
}

const UPSTREAM_IDENTITY: ProductIdentity = {
  profile: "upstream",
  baseName: "KM Code",
  packageName: "t3",
  cliBinaryName: "t3",
  bundleIdentifier: "com.t3tools.t3code",
  productionScheme: "t3code",
  developmentScheme: "t3code-dev",
  stateDirectoryName: "t3code",
  legacyStableDisplayName: "T3 Code (Alpha)",
  legacyDevelopmentDisplayName: "T3 Code (Dev)",
  linuxDesktopEntryName: "com.t3tools.T3Code.desktop",
  linuxWmClass: "t3code",
  linuxUrlHandlerDesktopEntryName: "t3code-url-handler.desktop",
  releaseTagPrefix: "v",
  artifactNamePrefix: "KM-Code",
};

const PI_OMP_IDENTITY: ProductIdentity = {
  profile: "pi-omp",
  baseName: "KM Code",
  packageName: "t3-pi-omp",
  cliBinaryName: "t3-pi-omp",
  bundleIdentifier: "com.t3tools.t3code.piomp",
  productionScheme: "t3code-pi-omp",
  developmentScheme: "t3code-pi-omp-dev",
  stateDirectoryName: "t3code-pi-omp",
  legacyStableDisplayName: "T3 Code Pi + OMP (Alpha)",
  legacyDevelopmentDisplayName: "T3 Code Pi + OMP (Dev)",
  linuxDesktopEntryName: "com.t3tools.T3Code.PiOmp.desktop",
  linuxWmClass: "t3code-pi-omp",
  linuxUrlHandlerDesktopEntryName: "t3code-pi-omp-url-handler.desktop",
  releaseTagPrefix: "fork-v",
  artifactNamePrefix: "KM-Code-Pi-OMP",
};

export function resolveProductIdentity(profile: ProductProfile = "upstream"): ProductIdentity {
  return profile === "pi-omp" ? PI_OMP_IDENTITY : UPSTREAM_IDENTITY;
}

export function parseProductProfile(value: string | undefined): ProductProfile {
  return value?.trim() === "pi-omp" ? "pi-omp" : "upstream";
}

export function resolveProductDisplayName(
  profile: ProductProfile,
  stage: ProductBuildStage,
): string {
  const identity = resolveProductIdentity(profile);
  return stage === "Local" ? identity.baseName : `${identity.baseName} (${stage})`;
}
