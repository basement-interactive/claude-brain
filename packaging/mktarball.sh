#!/bin/sh
# Produce the AUR source tarball for a tagged release and stamp its checksum into the
# PKGBUILD. Always from the tag, never from the working tree: the tree carries 300+ MB of
# gitignored node_modules and a locally built public/bundle.js, none of which belongs in
# a source tarball.
#
# The untracked check exists because `git archive` silently omits untracked files. A new
# src/*.ts that was never `git add`ed would produce a tarball that builds on the author's
# machine and fails for everyone else.
set -eu

pkgver="${1:?usage: mktarball.sh <version>   e.g. mktarball.sh 0.3.0}"
cd "$(dirname "$0")/.."

git diff-index --quiet HEAD -- || {
	echo "working tree is dirty — commit before releasing" >&2
	exit 1
}

untracked=$(git ls-files --others --exclude-standard -- src bin frontend packaging test server.ts)
[ -z "$untracked" ] || {
	echo "untracked sources would be silently omitted from the tarball:" >&2
	echo "$untracked" >&2
	exit 1
}

git rev-parse -q --verify "v$pkgver" >/dev/null || {
	echo "no tag v$pkgver — tag the release first" >&2
	exit 1
}

out="claude-brain-$pkgver.tar.gz"
git archive --format=tar.gz --prefix="claude-brain-$pkgver/" "v$pkgver" -o "$out"
sum=$(sha256sum "$out" | cut -d' ' -f1)
sed -i "s/^sha256sums=.*/sha256sums=('$sum')/" packaging/PKGBUILD

echo "$out"
echo "sha256 $sum  (written into packaging/PKGBUILD)"
echo
echo "next: copy $out and packaging/PKGBUILD into the AUR checkout,"
echo "      regenerate .SRCINFO with 'makepkg --printsrcinfo > .SRCINFO', commit, push."
