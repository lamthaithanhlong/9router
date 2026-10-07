#!/usr/bin/env bash
# Build dist/david-plugin-<version>.zip from this package: the plugin AND the david-force skill, no git history.
#
#   dev/build.sh [--skip-tests] [--e2e]
#
# Refuses to build when the version is not SemVer, when CHANGELOG.md has no entry for it, or when the
# tests fail. --e2e also runs dev/e2e/run.sh (needs the DeepSeek Harness app). OUT_DIR overrides dist/.
set -euo pipefail

SKIP_TESTS=0; E2E=0
for a in "$@"; do
  case $a in
    --skip-tests) SKIP_TESTS=1 ;;
    --e2e) E2E=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

PKG=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PKG/plugin/david-plugin/package.json" | head -1)
die() { echo "build refused: $*" >&2; exit 1; }

echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || die "version '$VERSION' is not SemVer"
grep -q "^## \[$VERSION\] - [0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}$" "$PKG/CHANGELOG.md" || die "CHANGELOG.md has no '## [$VERSION] - YYYY-MM-DD' entry"

if [ "$SKIP_TESTS" = 0 ]; then
  ( cd "$PKG" && node --test dev/test/*.test.mjs >/dev/null ) || die "tests failed (run: node --test dev/test/*.test.mjs)"
fi
if [ "$E2E" = 1 ]; then "$PKG/dev/e2e/run.sh" || die "end-to-end check failed"; fi

OUT_DIR=${OUT_DIR:-$PKG/dist}
mkdir -p "$OUT_DIR"
OUT=$(cd "$OUT_DIR" && pwd)/david-plugin-$VERSION.zip
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp -R "$PKG" "$STAGE/david-plugin"
rm -rf "$STAGE/david-plugin/dist"
# The repository's own history is never part of a release: it holds every earlier zip, so including it made each build
# about twice the size of the one before (0.7.7 was 71 MB for 200 KB of files).
rm -rf "$STAGE/david-plugin/.git"
find "$STAGE" -name __pycache__ -prune -exec rm -rf {} +
find "$STAGE" -name .DS_Store -delete
# One zip carries both halves: the plugin and the skill that makes it mandatory (install.sh installs both).
for need in plugin/david-plugin/package.json skill/david-force/SKILL.md skill/david-force/scripts/force.py skill/david-force/scripts/david install.sh; do
  [ -e "$STAGE/david-plugin/$need" ] || die "the zip would be missing $need"
done
rm -f "$OUT"
( cd "$STAGE" && zip -rq -X "$OUT" david-plugin )
echo "built $OUT"
shasum -a 256 "$OUT" | awk '{print "sha256 " $1}'
