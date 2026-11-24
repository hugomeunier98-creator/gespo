#!/usr/bin/env bash
# Publishes the app to GitHub Pages, like carnet_vol: the gh-pages branch holds
# the content of public/. The data stays in the private gespo-data repository.
#
# Usage: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git push -q origin master
# gh-pages = public/ at HEAD, with index.html loading the CSS and scripts as
# "app.js?v=<commit>": Pages lets browsers cache each file for 10 minutes, and
# a fresh index.html with a stale app.js (or the reverse) breaks the app.
version=$(git rev-parse --short HEAD)
index=$(mktemp -u)
trap 'rm -f "$index"' EXIT
page=$(git show HEAD:public/index.html \
  | sed -E "s/(href|src)=\"(styles\.css|core\.js|sync\.js|app\.js)\"/\1=\"\2?v=$version\"/" \
  | git hash-object -w --stdin)
GIT_INDEX_FILE=$index git read-tree HEAD:public
GIT_INDEX_FILE=$index git update-index --cacheinfo "100644,$page,index.html"
tree=$(GIT_INDEX_FILE=$index git write-tree)
git push -q -f origin "$(git commit-tree "$tree" -m "Deploy $version")":refs/heads/gh-pages
echo "Pushed; live in a minute or two: https://hugomeunier98-creator.github.io/gespo/"
