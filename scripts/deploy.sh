#!/usr/bin/env bash
# Publishes the app to GitHub Pages, like carnet_vol: the gh-pages branch holds
# the content of public/. The data stays in the private gespo-data repository.
#
# Usage: scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git push -q origin master
git push -q -f origin "$(git subtree split --prefix public HEAD)":refs/heads/gh-pages
echo "Pushed; live in a minute or two: https://hugomeunier98-creator.github.io/gespo/"
