import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

// Older pins recorded non-semver versions such as `agy_acp_server_1.1.1`; any
// other release is an update from those.
/**
 * Picks the release a managed installation's `start` downloads. A fresh install
 * gets T3 Code's pinned release; an existing one moves to the newest known
 * release above it. Null means nothing newer is known, so `start` re-checks the
 * installed runtime instead of downgrading it.
 */
export function selectManagedRelease<Release extends { readonly version: string }>(
  installedVersion: string | null,
  pinned: Release | null,
  upstream: Release | null,
): Release | null {
  if (installedVersion === null) return pinned;
  let selected: Release | null = null;
  for (const candidate of [pinned, upstream]) {
    if (candidate) {
      const currentVersion = selected?.version ?? installedVersion;
      const candidateIsSemver = parseSemver(candidate.version);
      const currentIsSemver = parseSemver(currentVersion);
      const isNewer =
        candidateIsSemver && currentIsSemver
          ? compareSemverVersions(candidate.version, currentVersion) > 0
          : candidate.version !== currentVersion;
      if (isNewer) selected = candidate;
    }
  }
  return selected;
}
