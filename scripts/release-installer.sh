#!/bin/sh
# Secure POSIX installer for T3 Code releases.
# It downloads only HTTPS release assets, verifies RELEASE-MANIFEST.json and
# SHA256SUMS before touching the destination, then switches an owned prefix
# atomically. Release assets are never evaluated as shell or JavaScript; the
# installer itself must be verified before invocation when installer provenance matters.
set -eu

profile=${T3_INSTALL_PROFILE:-upstream}
channel=${T3_INSTALL_CHANNEL:-latest}
version=${T3_INSTALL_VERSION:-}
prefix=${T3_INSTALL_PREFIX:-}
repository=${T3_INSTALL_REPOSITORY:-}
release_base_url=${T3_INSTALL_RELEASE_BASE_URL:-}
registry=${T3_INSTALL_REGISTRY:-https://registry.npmjs.org}
do_desktop=0
install_runtimes=0
dry_run=0
uninstall=0
rollback=0
rollback_version=
repository_explicit=0
release_base_explicit=0
[ -z "$release_base_url" ] || release_base_explicit=1

fail() {
  printf '%s\n' "t3 installer: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

  --profile upstream|pi-omp       Product profile (default: upstream)
  --channel latest|nightly        Release channel (default: latest)
  --version VERSION               Install an exact release
  --prefix PATH                   Owned, isolated installation prefix
  --repository OWNER/REPO         GitHub release repository (HTTPS)
  --release-base-url URL          Exact HTTPS release asset base URL
  --registry URL                  HTTPS npm registry for package fallback
  --desktop                       Install the verified POSIX desktop artifact
  --install-runtimes              Install manifest-pinned isolated Pi/OMP runtimes
  --dry-run                       Print actions without network or filesystem mutation
  --uninstall                     Remove this install only when its ownership marker matches
  --rollback [VERSION]            Switch to a previous or named installed version
  --runtime-bundle PATH            Deprecated alias rejected; use --install-runtimes

The default prefixes are profile-specific and never the official global t3, pi, or
omp locations. Runtime bundles are never installed unless --install-runtimes is
explicit. The legacy SHASUMS256.txt Node bundle is intentionally not trusted;
release assets must be listed in RELEASE-MANIFEST.json and SHA256SUMS.
EOF
}

require_https() {
  url=$1
  case "$url" in
    https://*) ;;
    *) fail "$2 must use https://" ;;
  esac
  case "$url" in
    *[!A-Za-z0-9._~:/?#%+@=-]*) fail "$2 contains unsafe URL characters" ;;
  esac
}

valid_version() {
  value=$1
  printf '%s' "$value" | awk '
    /^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$/ { ok = 1 }
    END { exit ok ? 0 : 1 }
  '
}

valid_sha() {
  value=$1
  [ "$(printf '%s' "$value" | awk 'length($0) == 64 && $0 !~ /[^0-9a-fA-F]/ { print "yes"; exit }')" = yes ]
}

normalise_sha() {
  printf '%s' "$1" | tr 'A-F' 'a-f'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$#" -ge 2 ] || fail "--profile requires a value"
      profile=$2; shift 2 ;;
    --channel)
      [ "$#" -ge 2 ] || fail "--channel requires a value"
      channel=$2; shift 2 ;;
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a value"
      version=$2; shift 2 ;;
    --prefix)
      [ "$#" -ge 2 ] || fail "--prefix requires a value"
      prefix=$2; shift 2 ;;
    --repository)
      [ "$#" -ge 2 ] || fail "--repository requires a value"
      repository=$2; repository_explicit=1; shift 2 ;;
    --release-base-url)
      [ "$#" -ge 2 ] || fail "--release-base-url requires a value"
      release_base_url=$2; release_base_explicit=1; shift 2 ;;
    --registry)
      [ "$#" -ge 2 ] || fail "--registry requires a value"
      registry=$2; shift 2 ;;
    --desktop)
      do_desktop=1; shift ;;
    --install-runtimes)
      install_runtimes=1; shift ;;
    --dry-run)
      dry_run=1; shift ;;
    --uninstall)
      uninstall=1; shift ;;
    --rollback)
      rollback=1; shift
      case "${1:-}" in
        ""|--*) ;;
        *) rollback_version=$1; shift ;;
      esac
      ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      fail "unknown option '$1' (use --help)" ;;
  esac
done

case "$profile" in
  upstream)
    package_name=t3
    binary_name=t3
    release_repository=${T3_RELEASE_REPOSITORY:-pingdotgg/t3code}
    tag_prefix=v
    ;;
  pi-omp)
    package_name=t3-pi-omp
    binary_name=t3-pi-omp
    release_repository=${T3_PI_OMP_RELEASE_REPOSITORY:-}
    tag_prefix=fork-v
    [ "$uninstall" -eq 1 ] || [ "$rollback" -eq 1 ] || [ -n "$repository" ] || [ -n "$release_base_url" ] || [ -n "$release_repository" ] ||
      fail "pi-omp releases require --repository, --release-base-url, or T3_PI_OMP_RELEASE_REPOSITORY"
    ;;
  *) fail "unsupported profile '$profile'" ;;
esac

case "$channel" in
  latest|nightly) ;;
  *) fail "unsupported channel '$channel'" ;;
esac

if [ -n "$version" ]; then
  valid_version "$version" || fail "invalid version '$version'"
fi
if [ -n "$rollback_version" ]; then
  valid_version "$rollback_version" || fail "invalid rollback version '$rollback_version'"
fi
[ "$uninstall" -eq 0 ] || [ "$rollback" -eq 0 ] || fail "--uninstall and --rollback cannot be combined"
[ "$repository_explicit" -eq 0 ] || [ "$release_base_explicit" -eq 0 ] ||
  fail "--repository and --release-base-url cannot be combined"

if [ -z "$prefix" ]; then
  home=${HOME:-}
  [ -n "$home" ] || fail "HOME is required when --prefix is omitted"
  data_home=${XDG_DATA_HOME:-$home/.local/share}
  case "$profile" in
    upstream) prefix=$data_home/t3code/upstream ;;
    pi-omp) prefix=$data_home/t3code/pi-omp ;;
  esac
fi
case "$prefix" in
  /*) ;;
  *) fail "--prefix must be an absolute path" ;;
esac
case "$prefix" in
  /|/usr|/usr/|/usr/local|/usr/local/|/bin|/sbin|/opt|/opt/homebrew|/Applications|"${HOME:-__no_home__}")
    fail "refusing official or unsafe prefix '$prefix'" ;;
esac

if [ -L "$prefix" ]; then
  fail "refusing symlink prefix '$prefix'"
fi
if [ "$uninstall" -eq 0 ] && [ "$rollback" -eq 0 ]; then
  require_https "$registry" "--registry"

  if [ -n "$release_base_url" ]; then
    require_https "$release_base_url" "--release-base-url"
    case "$release_base_url" in */) release_base_url=${release_base_url%/} ;; esac
  else
    if [ -z "$repository" ]; then repository=$release_repository; fi
    case "$repository" in
      https://github.com/*)
        repository_slug=${repository#https://github.com/}
        repository_slug=${repository_slug%/}
        repository_slug=${repository_slug%.git}
        case "$repository_slug" in *[!A-Za-z0-9._/-]*|*..*|/*|*/|*//* ) fail "invalid repository '$repository'" ;; esac
        repository_url=https://github.com/$repository_slug
        ;;
      */*)
        case "$repository" in *[!A-Za-z0-9._/-]*|*..*|/*|*/|*//* ) fail "invalid repository '$repository'" ;; esac
        repository_slug=$repository
        repository_url=https://github.com/$repository_slug
        ;;
      *) fail "--repository must be OWNER/REPO or an HTTPS GitHub URL" ;;
    esac
    if [ -n "$version" ]; then
      release_base_url=$repository_url/releases/download/${tag_prefix}${version}
    elif [ "$channel" = latest ]; then
      release_base_url=$repository_url/releases/latest/download
    else
      release_base_url=$repository_url/releases/download/${tag_prefix}nightly
    fi
  fi
  require_https "$release_base_url" "release base URL"
fi

owner_marker=$prefix/.t3-install-owner
active_version_file=$prefix/.active-version
previous_version_file=$prefix/.previous-version

prefix_owned=0

check_owner() {
  if [ -f "$owner_marker" ]; then
    prefix_owned=1
    marker_profile=$(awk -F= '$1 == "profile" { print $2; exit }' "$owner_marker")
    marker_binary=$(awk -F= '$1 == "binary" { print $2; exit }' "$owner_marker")
    [ "$marker_profile" = "$profile" ] || fail "prefix is owned by profile '$marker_profile'"
    [ "$marker_binary" = "$binary_name" ] || fail "prefix ownership marker does not match $binary_name"
  elif [ -e "$prefix" ]; then
    if [ -d "$prefix" ]; then
      for existing in "$prefix"/* "$prefix"/.[!.]* "$prefix"/..?*; do
        [ -e "$existing" ] || continue
        fail "refusing non-owned non-empty prefix '$prefix'"
      done
    else
      fail "refusing non-directory prefix '$prefix'"
    fi
  fi
}
replace_symlink() {
  source=$1
  destination=$2
  command -v node >/dev/null 2>&1 || fail "node is required for atomic installation switching"
  node - "$source" "$destination" <<'NODE'
const fs = require("node:fs");
fs.renameSync(process.argv[2], process.argv[3]);
NODE
}


if [ "$uninstall" -eq 1 ] || [ "$rollback" -eq 1 ]; then
  check_owner
  if [ ! -f "$owner_marker" ]; then
    fail "no owned installation exists at '$prefix'"
  fi
  if [ "$dry_run" -eq 1 ]; then
    if [ "$uninstall" -eq 1 ]; then
      printf 'Would uninstall %s from %s\n' "$profile" "$prefix"
    else
      if [ -n "$rollback_version" ]; then
        target_version=$rollback_version
      elif [ -f "$previous_version_file" ]; then
        target_version=$(cat "$previous_version_file")
      else
        target_version=
      fi
      [ -n "$target_version" ] || fail "no previous version is recorded"
      printf 'Would rollback %s to %s in %s\n' "$profile" "$target_version" "$prefix"
    fi
    exit 0
  fi
  if [ "$uninstall" -eq 1 ]; then
    rm -rf "$prefix"
    printf 'Uninstalled %s from %s\n' "$profile" "$prefix"
    exit 0
  fi
  current_version=$(cat "$active_version_file" 2>/dev/null || true)
  if [ -n "$rollback_version" ]; then
    target_version=$rollback_version
  else
    target_version=$(cat "$previous_version_file" 2>/dev/null || true)
  fi
  [ -n "$target_version" ] || fail "no previous version is recorded"
  [ "$target_version" != "$current_version" ] || fail "version '$target_version' is already active"
  [ -d "$prefix/versions/$target_version" ] || fail "installed version '$target_version' was not found"
  old_previous=$current_version
  ln -s "versions/$target_version" "$prefix/.active.new.$$"
  replace_symlink "$prefix/.active.new.$$" "$prefix/active"
  printf '%s\n' "$target_version" > "$prefix/.active-version.new.$$"
  mv "$prefix/.active-version.new.$$" "$active_version_file"
  if [ -n "$old_previous" ]; then
    printf '%s\n' "$old_previous" > "$prefix/.previous-version.new.$$"
    mv "$prefix/.previous-version.new.$$" "$previous_version_file"
  fi
  printf 'Rolled back %s to %s\n' "$profile" "$target_version"
  exit 0
fi

check_owner

if [ "$dry_run" -eq 1 ]; then
  printf 'Would install %s (%s) into %s\n' "$package_name" "$profile" "$prefix"
  printf 'Release base: %s\n' "$release_base_url"
  printf 'Would download and verify RELEASE-MANIFEST.json and SHA256SUMS\n'
  [ "$do_desktop" -eq 0 ] || printf 'Would select the %s desktop artifact\n' "$(uname -s 2>/dev/null || printf unknown)"
  [ "$install_runtimes" -eq 0 ] || printf 'Would install pinned Pi/OMP runtimes into %s\n' "$prefix"
  printf 'Existing providers will be reported after installation.\n'
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v node >/dev/null 2>&1 || fail "node is required to parse the release manifest"

work_tmp=$(mktemp -d "${TMPDIR:-/tmp}/t3-installer.XXXXXX") || fail "could not create temporary directory"
cleanup() { rm -rf "$work_tmp"; }
trap cleanup 0 HUP INT TERM
mkdir -p "$work_tmp/downloads" "$work_tmp/stage"

fetch() {
  url=$1
  destination=$2
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --output "$destination" "$url"
  [ -s "$destination" ] || fail "downloaded empty asset from $url"
}

if [ "$channel" = nightly ] && [ -z "$version" ] && [ "$release_base_explicit" -eq 0 ]; then
  nightly_releases="$work_tmp/nightly-releases.json"
  fetch "https://api.github.com/repos/$repository_slug/releases?per_page=30" "$nightly_releases"
  nightly_tag=$(
    node - "$nightly_releases" "$tag_prefix" <<'NODE'
const fs = require("node:fs");
const releases = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const prefix = process.argv[3];
const release = Array.isArray(releases)
  ? releases.find((candidate) =>
      candidate &&
      candidate.prerelease === true &&
      candidate.draft !== true &&
      typeof candidate.tag_name === "string" &&
      candidate.tag_name.startsWith(prefix) &&
      candidate.tag_name.includes("-nightly."),
    )
  : undefined;
if (!release) process.exit(1);
process.stdout.write(release.tag_name);
NODE
  ) || fail "no ${profile} nightly release was found"
  release_base_url=$repository_url/releases/download/$nightly_tag
fi

sha256_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1; exit }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1; exit }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | sed 's/^.*= //'
  else
    fail "sha256sum, shasum, or openssl is required"
  fi
}

checksum_for() {
  target=$1
  sums=$2
  awk -v target="$target" '
    $2 == target || $2 == ("./" target) { print $1; exit }
  ' "$sums"
}

verify_asset() {
  file=$1
  asset_path=$2
  manifest_hash=$3
  sums_hash=$(checksum_for "$asset_path" "$work_tmp/SHA256SUMS")
  [ -n "$sums_hash" ] || fail "SHA256SUMS has no entry for $asset_path"
  valid_sha "$sums_hash" || fail "invalid checksum for $asset_path"
  valid_sha "$manifest_hash" || fail "manifest has no valid checksum for $asset_path"
  expected=$(normalise_sha "$manifest_hash")
  [ "$(normalise_sha "$sums_hash")" = "$expected" ] ||
    fail "manifest/checksum disagreement for $asset_path"
  actual=$(sha256_file "$file")
  [ "$(normalise_sha "$actual")" = "$expected" ] || fail "checksum mismatch for $asset_path"
}

manifest_field() {
  field=$2
  node - "$1" "$field" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const field = process.argv[3];
let value = "";
try {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (field === "version") value = m.clientVersion || m.version || m.appVersion || "";
  else if (field === "profile") value = m.profile || "";
  else if (field === "package") value = typeof m.package === "string" ? m.package : (m.packageName || "");
  else if (field === "bin") value = m.bin || m.binary || m.binaryName || "";
  else if (field === "sums") value = (m.checksums && (m.checksums.sha256 || m.checksums.sha256sums)) || m.sha256sums || "";
  if (typeof value !== "string") value = "";
  if (/[\u0000-\u001f\t\r\n]/.test(value)) process.exit(2);
  process.stdout.write(value);
} catch (_) { process.exit(2); }
NODE
}
manifest_asset() {
  node - "$1" "$2" "$3" "$4" "$5" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const wanted = process.argv[3];
const platform = process.argv[4].toLowerCase();
const arch = process.argv[5].toLowerCase();
const runtime = process.argv[6].toLowerCase();
const m = JSON.parse(fs.readFileSync(file, "utf8"));
const aliases = {
  cli: ["cli", "package", "npm", "cli-package"],
  desktop: ["desktop", "desktop-artifact", "app"],
  runtime: ["runtime", "provider", "runtime-archive"],
  native: ["native", "node-pty"]
};
const platformNames = platform === "darwin" ? ["darwin", "mac", "macos"] : ["linux"];
const archNames = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "x86_64", "amd64"];
const candidates = [];
function text(v) { return typeof v === "string" ? v.toLowerCase() : ""; }
function add(v, context) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return;
  const kind = text(v.kind || v.type || v.artifactKind || "");
  const provider = text(v.runtime || v.provider || v.name || "");
  const native = text(v.native || v.nativePackage || "");
  const name = v.path || v.file || v.filename || v.asset || v.archive || v.tarball || (typeof v.name === "string" && !v.kind ? v.name : "");
  const nameText = text(name);
  if (wanted === "desktop" && nameText.endsWith(".blockmap")) return;
  const desktopPlatform = nameText.endsWith(".appimage") ? "linux" :
    (nameText.endsWith(".dmg") || nameText.endsWith(".zip")) ? "darwin" :
    nameText.endsWith(".exe") ? "windows" : nameText;
  const p = text(v.platform || v.os || v.target || context.platform || (wanted === "cli" ? "" : wanted === "desktop" ? desktopPlatform : nameText));
  const a = text(v.arch || v.architecture || context.arch || (wanted === "cli" ? "" : nameText));
  const k = wanted === "native"
    ? (kind.includes("native") || native === "node-pty")
    : wanted === "runtime"
      ? (kind.includes("runtime") || kind.includes("provider") || provider === runtime || kind === runtime)
      : aliases[wanted].some((x) => kind.includes(x));
  if (!k && wanted !== "runtime") return;
  if (wanted === "runtime" && !(kind.includes("runtime") || kind.includes("provider") || provider === runtime || kind === runtime)) return;
  if (wanted === "native" && native && native !== "node-pty") return;
  if (p && !platformNames.some((x) => p.includes(x)) && !p.includes(platform + "-")) return;
  if (a && !archNames.some((x) => a.includes(x))) return;
  if (wanted === "runtime" && provider && provider !== runtime && !kind.includes(runtime)) return;
  const hash = v.sha256 || v.checksum || v.hash || "";
  const url = v.url || "";
  const pkg = v.package || v.packageName || "";
  if (name || pkg) candidates.push({ name, hash, url, pkg, score: (p ? 4 : 0) + (a ? 3 : 0) + (kind ? 4 : 0) });
}
function walk(v, context) {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) walk(x, context); return; }
  add(v, context);
  for (const [key, child] of Object.entries(v)) {
    if (child && typeof child === "object") {
      const low = key.toLowerCase();
      walk(child, { platform: platformNames.some((x) => low.includes(x)) ? key : context.platform,
        arch: archNames.some((x) => low.includes(x)) ? key : context.arch });
    }
  }
}
if (Array.isArray(m.artifacts)) walk(m.artifacts, {});
if (wanted === "cli") walk(m.cli || m.cliAsset || {}, {});
if (wanted === "desktop") walk(m.desktop || m.desktopAsset || {}, {});
if (wanted === "runtime") walk((m.runtimes && (m.runtimes[runtime] || m.runtimes)) || m.runtime || {}, {});
if (wanted === "native") walk(m.native || m.nativeAsset || {}, {});
candidates.sort((x, y) => y.score - x.score);
const out = candidates.find((x) => x.hash || x.name);
if (!out) process.exit(1);
for (const value of [out.name, out.hash, out.url, out.pkg]) {
  if (/[\u0000-\u001f\t\r\n]/.test(String(value))) process.exit(2);
}
process.stdout.write([out.name, out.hash, out.url, out.pkg].join("\t"));
NODE
}

fetch "$release_base_url/RELEASE-MANIFEST.json" "$work_tmp/RELEASE-MANIFEST.json"
fetch "$release_base_url/SHA256SUMS" "$work_tmp/SHA256SUMS"
manifest_hash=$(checksum_for RELEASE-MANIFEST.json "$work_tmp/SHA256SUMS")
[ -n "$manifest_hash" ] || fail "SHA256SUMS has no RELEASE-MANIFEST.json entry"
valid_sha "$manifest_hash" || fail "invalid RELEASE-MANIFEST.json checksum"
[ "$(normalise_sha "$(sha256_file "$work_tmp/RELEASE-MANIFEST.json")")" = "$(normalise_sha "$manifest_hash")" ] ||
  fail "RELEASE-MANIFEST.json checksum mismatch"
manifest_sums_hash=$(manifest_field "$work_tmp/RELEASE-MANIFEST.json" sums || true)
if [ -n "$manifest_sums_hash" ]; then
  valid_sha "$manifest_sums_hash" || fail "manifest has an invalid SHA256SUMS checksum"
  [ "$(normalise_sha "$manifest_sums_hash")" = "$(normalise_sha "$(sha256_file "$work_tmp/SHA256SUMS")")" ] ||
    fail "SHA256SUMS checksum mismatch"
fi

manifest_profile=$(manifest_field "$work_tmp/RELEASE-MANIFEST.json" profile || true)
[ -z "$manifest_profile" ] || [ "$manifest_profile" = "$profile" ] ||
  fail "release manifest profile '$manifest_profile' does not match '$profile'"
resolved_version=$(manifest_field "$work_tmp/RELEASE-MANIFEST.json" version || true)
[ -n "$resolved_version" ] || fail "release manifest has no version"
valid_version "$resolved_version" || fail "release manifest has invalid version '$resolved_version'"
[ -z "$version" ] || [ "$version" = "$resolved_version" ] ||
  fail "requested version '$version' does not match manifest version '$resolved_version'"
version=$resolved_version
manifest_package=$(manifest_field "$work_tmp/RELEASE-MANIFEST.json" package || true)
[ -z "$manifest_package" ] || [ "$manifest_package" = "$package_name" ] ||
  fail "release manifest package '$manifest_package' does not match '$package_name'"
manifest_bin=$(manifest_field "$work_tmp/RELEASE-MANIFEST.json" bin || true)
[ -z "$manifest_bin" ] || [ "$manifest_bin" = "$binary_name" ] ||
  fail "release manifest binary '$manifest_bin' does not match '$binary_name'"

os_name=$(uname -s)
case "$os_name" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail "unsupported operating system '$os_name'" ;; esac
arch_name=$(uname -m)
case "$arch_name" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail "unsupported architecture '$arch_name'" ;; esac

asset_info=$(manifest_asset "$work_tmp/RELEASE-MANIFEST.json" cli "$platform" "$arch" "" || true)
cli_name=$(printf '%s\n' "$asset_info" | awk -F '\t' '{ print $1 }')
cli_hash=$(printf '%s\n' "$asset_info" | awk -F '\t' '{ print $2 }')
cli_url=$(printf '%s\n' "$asset_info" | awk -F '\t' '{ print $3 }')
cli_package=$(printf '%s\n' "$asset_info" | awk -F '\t' '{ print $4 }')
if [ -z "$cli_name" ] && [ -z "$cli_package" ]; then cli_package=$package_name; fi
cli_file=$work_tmp/downloads/cli-${cli_name##*/}
if [ -n "$cli_name" ]; then
  case "$cli_name" in *..*|/*|*' '*|*'\t'*) fail "unsafe CLI asset path '$cli_name'" ;; esac
  if [ -n "$cli_url" ]; then
    require_https "$cli_url" "CLI asset URL"
    cli_download_url=$cli_url
  else
    cli_download_url=$release_base_url/$cli_name
  fi
  fetch "$cli_download_url" "$cli_file"
else
  [ -n "$cli_package" ] || fail "release manifest has no CLI asset or package"
  npm_command=$(command -v npm 2>/dev/null || true)
  [ -n "$npm_command" ] || fail "npm is required when the release manifest has no CLI archive"
  mkdir -p "$work_tmp/downloads/npm"
  "$npm_command" pack "$cli_package@$version" --ignore-scripts --no-audit --no-fund --registry "$registry" \
    --pack-destination "$work_tmp/downloads/npm" >"$work_tmp/npm-output"
  cli_name=$(awk 'NF { value=$NF } END { print value }' "$work_tmp/npm-output")
  case "$cli_name" in *.tgz) ;; *) cli_name= ;; esac
  [ -n "$cli_name" ] || fail "npm pack did not produce a package archive"
  cli_file=$work_tmp/downloads/npm/$cli_name
  [ -f "$cli_file" ] || fail "npm package archive is missing"
fi
[ -n "$cli_hash" ] || cli_hash=$(checksum_for "$cli_name" "$work_tmp/SHA256SUMS")
verify_asset "$cli_file" "$cli_name" "$cli_hash"

stage_version=$work_tmp/stage/versions/$version
mkdir -p "$stage_version/bin"

safe_tar_list() {
  archive=$1
  format=$2
  case "$format" in
    gz) tar -tzf "$archive" ;;
    xz) tar -tJf "$archive" ;;
    bz2) tar -tjf "$archive" ;;
    tar) tar -tf "$archive" ;;
    zip) command -v unzip >/dev/null 2>&1 || fail "unzip is required for ZIP assets"; unzip -Z1 "$archive" ;;
    *) return 1 ;;
  esac | awk '/^\// || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad }'
}

extract_archive() {
  archive=$1
  destination=$2
  case "$archive" in
    *.tgz|*.tar.gz) safe_tar_list "$archive" gz; tar -xzf "$archive" -C "$destination" ;;
    *.tar.xz) safe_tar_list "$archive" xz; tar -xJf "$archive" -C "$destination" ;;
    *.tar.bz2) safe_tar_list "$archive" bz2; tar -xjf "$archive" -C "$destination" ;;
    *.tar) safe_tar_list "$archive" tar; tar -xf "$archive" -C "$destination" ;;

    *.zip) safe_tar_list "$archive" zip; unzip -q "$archive" -d "$destination" ;;
    *) return 1 ;;
  esac
}
verify_extracted_tree() {
  destination=$1
  node - "$destination" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = fs.realpathSync(process.argv[2]);
function visit(current) {
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`archive contains a symbolic link: ${current}`);
  const resolved = fs.realpathSync(current);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`archive entry escapes its destination: ${current}`);
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(current)) visit(path.join(current, child));
  }
}
visit(root);
NODE
}

cli_source=
npm_command=$(command -v npm 2>/dev/null || true)
case "$cli_file" in
  *.tgz|*.tar.gz)
    if [ -n "$npm_command" ] &&
      tar -tzf "$cli_file" | awk '$0 == "package/package.json" { found = 1 } END { exit found ? 0 : 1 }'
    then
      "$npm_command" install --global --prefix "$stage_version" --ignore-scripts --no-audit --no-fund \
        --registry "$registry" "$cli_file" >/dev/null
      [ -f "$stage_version/bin/$binary_name" ] || fail "CLI package has no bin/$binary_name"
      cli_source=$stage_version/bin/$binary_name
    fi
    ;;
esac
if [ -z "$cli_source" ]; then
  cli_unpack=$work_tmp/stage/cli-unpack
  mkdir -p "$cli_unpack"
  if extract_archive "$cli_file" "$cli_unpack" 2>/dev/null; then
    for candidate in "$cli_unpack/package/bin/$binary_name" "$cli_unpack/bin/$binary_name"; do
      if [ -f "$candidate" ]; then cli_source=$candidate; break; fi
    done
    [ -n "$cli_source" ] || fail "CLI archive has no bin/$binary_name"
  else
    cli_source=$cli_file
  fi
  cp "$cli_source" "$stage_version/bin/$binary_name"
fi
chmod 755 "$stage_version/bin/$binary_name"
if [ "$platform" = linux ]; then
  native_info=$(manifest_asset "$work_tmp/RELEASE-MANIFEST.json" native "$platform" "$arch" "" || true)
  native_name=$(printf '%s\n' "$native_info" | awk -F '\t' '{ print $1 }')
  native_hash=$(printf '%s\n' "$native_info" | awk -F '\t' '{ print $2 }')
  native_url=$(printf '%s\n' "$native_info" | awk -F '\t' '{ print $3 }')
  if [ -n "$native_name" ]; then
    case "$native_name" in *..*|/*|*' '*|*'\t'*) fail "unsafe native asset path '$native_name'" ;; esac
    native_file=$work_tmp/downloads/native-$arch.tar.gz
    if [ -n "$native_url" ]; then require_https "$native_url" "native asset URL"; else native_url=$release_base_url/$native_name; fi
    fetch "$native_url" "$native_file"
    [ -n "$native_hash" ] || native_hash=$(checksum_for "$native_name" "$work_tmp/SHA256SUMS")
    verify_asset "$native_file" "$native_name" "$native_hash"
    native_unpack=$work_tmp/stage/native-pty
    mkdir -p "$native_unpack"
    extract_archive "$native_file" "$native_unpack" || fail "native node-pty asset is not a supported archive"
    verify_extracted_tree "$native_unpack" ||
      fail "native node-pty archive contains unsafe links"
    [ -f "$native_unpack/pty.node" ] || fail "native node-pty archive has no pty.node"
    node_pty_dir=$(
      node - "$stage_version" "$package_name" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [stage, packageName] = process.argv.slice(2);
const candidates = [
  path.join(stage, "lib", "node_modules", packageName, "node_modules", "node-pty"),
  path.join(stage, "lib", "node_modules", "node-pty"),
];
const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
if (!found) process.exit(1);
process.stdout.write(found);
NODE
    ) || fail "installed CLI has no node-pty package"
    mkdir -p "$node_pty_dir/prebuilds/linux-$arch"
    cp "$native_unpack/pty.node" "$node_pty_dir/prebuilds/linux-$arch/pty.node"
    if [ -f "$native_unpack/spawn-helper" ]; then
      cp "$native_unpack/spawn-helper" "$node_pty_dir/prebuilds/linux-$arch/spawn-helper"
      chmod 755 "$node_pty_dir/prebuilds/linux-$arch/spawn-helper"
    fi
  fi
fi

if [ "$do_desktop" -eq 1 ]; then
  desktop_info=$(manifest_asset "$work_tmp/RELEASE-MANIFEST.json" desktop "$platform" "$arch" "" || true)
  desktop_name=$(printf '%s\n' "$desktop_info" | awk -F '\t' '{ print $1 }')
  desktop_hash=$(printf '%s\n' "$desktop_info" | awk -F '\t' '{ print $2 }')
  desktop_url=$(printf '%s\n' "$desktop_info" | awk -F '\t' '{ print $3 }')
  [ -n "$desktop_name" ] || fail "release manifest has no $platform-$arch desktop asset"
  case "$desktop_name" in *..*|/*|*' '*|*'\t'*) fail "unsafe desktop asset path '$desktop_name'" ;; esac
  desktop_file=$work_tmp/downloads/desktop.asset
  if [ -n "$desktop_url" ]; then require_https "$desktop_url" "desktop asset URL"; else desktop_url=$release_base_url/$desktop_name; fi
  fetch "$desktop_url" "$desktop_file"
  [ -n "$desktop_hash" ] || desktop_hash=$(checksum_for "$desktop_name" "$work_tmp/SHA256SUMS")
  verify_asset "$desktop_file" "$desktop_name" "$desktop_hash"
  mkdir -p "$stage_version/desktop"
  cp "$desktop_file" "$stage_version/desktop/${desktop_name##*/}"
fi

runtime_path_report=
if [ "$install_runtimes" -eq 1 ]; then
  for runtime_name in pi omp; do
    runtime_info=$(manifest_asset "$work_tmp/RELEASE-MANIFEST.json" runtime "$platform" "$arch" "$runtime_name" || true)
    runtime_asset=$(printf '%s\n' "$runtime_info" | awk -F '\t' '{ print $1 }')
    runtime_hash=$(printf '%s\n' "$runtime_info" | awk -F '\t' '{ print $2 }')
    runtime_url=$(printf '%s\n' "$runtime_info" | awk -F '\t' '{ print $3 }')
    [ -n "$runtime_asset" ] || fail "release manifest has no pinned $runtime_name runtime for $platform-$arch"
    case "$runtime_asset" in *..*|/*|*' '*|*'\t'*) fail "unsafe runtime asset path '$runtime_asset'" ;; esac
    runtime_file=$work_tmp/downloads/$runtime_name-${runtime_asset##*/}
    if [ -n "$runtime_url" ]; then require_https "$runtime_url" "$runtime_name runtime URL"; else runtime_url=$release_base_url/$runtime_asset; fi
    fetch "$runtime_url" "$runtime_file"
    [ -n "$runtime_hash" ] || runtime_hash=$(checksum_for "$runtime_asset" "$work_tmp/SHA256SUMS")
    verify_asset "$runtime_file" "$runtime_asset" "$runtime_hash"
    runtime_destination=$stage_version/runtimes/$runtime_name
    mkdir -p "$runtime_destination"
    extract_archive "$runtime_file" "$runtime_destination" || fail "$runtime_name runtime is not a supported archive"
    verify_extracted_tree "$runtime_destination" ||
      fail "$runtime_name runtime archive contains unsafe links"
    runtime_binary=
    for candidate in "$runtime_destination/bin/$runtime_name" "$runtime_destination/package/bin/$runtime_name" "$runtime_destination"/*/bin/$runtime_name; do
      if [ -f "$candidate" ]; then runtime_binary=$candidate; break; fi
    done
    [ -n "$runtime_binary" ] || fail "$runtime_name runtime archive has no executable bin/$runtime_name"
    chmod 755 "$runtime_binary"
    runtime_path_report="$runtime_path_report$runtime_name=$prefix/active/${runtime_binary#"$stage_version/"}\n"
  done
fi

cat > "$stage_version/.t3-install-owner" <<EOF
installer=t3-posix-v1
profile=$profile
binary=$binary_name
EOF

# A failed smoke test never replaces the currently active version.
old_active=
if [ -f "$active_version_file" ]; then old_active=$(cat "$active_version_file"); fi
mkdir -p "$work_tmp/stage/versions"
if [ "$prefix_owned" -eq 1 ]; then
  mkdir -p "$prefix/versions"
  if [ -e "$prefix/versions/$version" ]; then fail "version '$version' is already installed"; fi
  mv "$stage_version" "$prefix/versions/$version"
  if [ -n "$old_active" ]; then printf '%s\n' "$old_active" > "$prefix/.previous-version.new.$$"; mv "$prefix/.previous-version.new.$$" "$previous_version_file"; fi
  ln -s "versions/$version" "$prefix/.active.new.$$"
  replace_symlink "$prefix/.active.new.$$" "$prefix/active"
  printf '%s\n' "$version" > "$prefix/.active-version.new.$$"
  mv "$prefix/.active-version.new.$$" "$active_version_file"
else
  mkdir -p "$work_tmp/stage/bin"
  ln -s "../active/bin/$binary_name" "$work_tmp/stage/bin/$binary_name"
  cp "$stage_version/.t3-install-owner" "$work_tmp/stage/.t3-install-owner"
  printf '%s\n' "$version" > "$work_tmp/stage/.active-version"
  if [ -e "$prefix" ]; then rmdir "$prefix"; fi
  mkdir -p "$(dirname "$prefix")"
  ln -s "versions/$version" "$work_tmp/stage/active"
  mv "$work_tmp/stage" "$prefix"
fi

installed_binary=$prefix/bin/$binary_name
[ -x "$installed_binary" ] || fail "installed binary is missing"
if ! "$installed_binary" --version >/dev/null 2>&1; then
  if [ -n "$old_active" ] && [ -d "$prefix/versions/$old_active" ]; then
    ln -s "versions/$old_active" "$prefix/.active.restore.$$"
    replace_symlink "$prefix/.active.restore.$$" "$prefix/active"
    printf '%s\n' "$old_active" > "$prefix/.active-version.restore.$$"
    mv "$prefix/.active-version.restore.$$" "$active_version_file"
  elif [ "$prefix_owned" -eq 1 ]; then
    rm -rf "$prefix/versions/$version"
  else
    rm -rf "$prefix"
  fi
  fail "post-install $binary_name --version smoke failed"
fi

report_provider() {
  provider=$1
  provider_path=$(command -v "$provider" 2>/dev/null || true)
  if [ -n "$provider_path" ] && [ -x "$provider_path" ]; then
    printf 'Existing %s: %s\n' "$provider" "$provider_path"
    provider_version=$("$provider_path" --version 2>&1 | sed -n '1p' || true)
    [ -n "$provider_version" ] || provider_version=unavailable
    printf '  version: %s\n' "$provider_version"
    printf '  provenance: PATH (not modified)\n'
  else
    printf 'Existing %s: not found\n' "$provider"
  fi
}

printf 'Installed %s %s at %s\n' "$profile" "$version" "$installed_binary"
report_provider pi
report_provider omp
if [ "$do_desktop" -eq 1 ]; then printf 'Desktop artifact: %s/active/desktop/%s\n' "$prefix" "${desktop_name##*/}"; fi
if [ "$install_runtimes" -eq 1 ]; then
  printf '%b' "$runtime_path_report" | while IFS='=' read -r runtime_name runtime_path; do
    [ -n "$runtime_name" ] || continue
    case "$runtime_name" in
      pi) printf 'PI_BINARY_PATH=%s\n' "$runtime_path" ;;
      omp) printf 'OMP_BINARY_PATH=%s\n' "$runtime_path" ;;
    esac
  done
  printf 'Provider configuration: set PI_BINARY_PATH and OMP_BINARY_PATH explicitly; user runtimes were not replaced.\n'
fi
printf 'Run: %s --help\n' "$installed_binary"
