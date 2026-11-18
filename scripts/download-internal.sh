#!/bin/sh
# Download a verified personal-fork binary without installing build tools or
# changing the running HAPI installation. The device's agent handles activation.
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    fail 'Usage: sh download-internal.sh internal-TAG [download-directory]'
fi
tag=$1
case "$tag" in internal-?*) ;; *) fail 'Expected an internal-* release tag.' ;; esac
case "$tag" in *[!a-zA-Z0-9._-]*) fail 'Invalid release tag.' ;; esac

case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) fail 'Use the matching release archive on this operating system.' ;;
esac
case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'This architecture has no internal release binary.' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
if command -v sha256sum >/dev/null 2>&1; then
    hash() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    hash() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    fail 'sha256sum or shasum is required.'
fi

umask 077
root=${2:-${HAPI_HOME:-$HOME/.hapi}/internal-releases}
mkdir -p "$root"
root=$(cd "$root" && pwd -P)
destination=$root/$tag
[ ! -e "$destination" ] || fail "Already downloaded: $destination (left unchanged)."
lock=$root/.download-$tag.lock
mkdir "$lock" 2>/dev/null || fail "Another download holds $lock."
stage=
cleanup() {
    if [ -n "$stage" ]; then rm -rf "$stage"; fi
    rmdir "$lock" 2>/dev/null || :
}
trap cleanup 0
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "$root/.download.XXXXXXXX")

base=https://github.com/reasonss1/hapi/releases/download/$tag
asset=hapi-$platform-$arch.tar.gz
download() {
    curl --http1.1 --fail --location --silent --show-error \
        --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 \
        --retry 3 --retry-delay 2 "$base/$1" -o "$stage/$1"
}
verify() {
    expected=$(awk -v name="$1" '$2 == name { print $1 }' "$stage/checksums.txt")
    [ "${#expected}" -eq 64 ] || fail "Missing or ambiguous checksum for $1."
    case "$expected" in *[!0-9a-f]*) fail "Invalid checksum for $1." ;; esac
    actual=$(hash "$stage/$1")
    [ "$actual" = "$expected" ] || fail "Checksum mismatch for $1; current HAPI was not changed."
}

printf 'Downloading %s for %s/%s…\n' "$tag" "$platform" "$arch"
download checksums.txt
download release-manifest.json
download "$asset"
verify release-manifest.json
verify "$asset"
[ "$(tar -tzf "$stage/$asset")" = hapi ] || fail 'Unexpected archive contents.'
tar -xzf "$stage/$asset" -C "$stage"
[ -f "$stage/hapi" ] && [ ! -L "$stage/hapi" ] || fail 'Expected a regular hapi executable.'
chmod 755 "$stage/hapi"
"$stage/hapi" --version
rm "$stage/$asset"
mv "$stage" "$destination"
stage=
printf '\nVerified binary: %s/hapi\nSource record: %s/release-manifest.json\n' "$destination" "$destination"
printf 'Download complete. The current installation and running sessions have not been changed.\n'
