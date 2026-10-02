#!/bin/bash
# Runs the end-to-end tests in a separate VS Code instance (temporary profile; your own VS Code settings are untouched).
# Usage: e2e/run.sh <scenario>
#   ctex        Chinese ctex document, default settings (draft fonts only): prewarming, single-pass builds and settling,
#               error locations, preamble edits, byte-for-byte comparison with a from-scratch build
#   ctex-final  same, with finalBuild on: rebuild with the document fonts after idle
#   en          English article document, same checks
#   en-out      English document, output to build/
#   autosave    autosave on, typing without saving
#   idle        idle release of the prewarmed process, and recovery on typing
# Run npm run build first. The result is printed at the end and written to out.json in the work directory.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(dirname "$HERE"); K=${1:?scenario}
CODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
# VS Code fails to start when the user-data-dir path is too long (socket paths are limited to 103 characters), so a short path is used
W="${TMPDIR_E2E:-$HOME/.cache/tw-e2e}/$K"; rm -rf "$W"; mkdir -p "$W"
case $K in
  ctex)     FIX=ctex; TEST=test.js; export TW_REF_DRAFT=1 ;;
  ctex-final) FIX=ctex; TEST=test.js; SETTINGS='{ "tectonicWatch.finalBuild": true }' ;;
  en)       FIX=en;   TEST=test.js ;;
  en-out)   FIX=en;   TEST=test.js; export TW_OUTDIR=build; SETTINGS='{ "tectonicWatch.extraArgs": ["--outdir", "build"] }' ;;
  autosave) FIX=en;   TEST=auto.js; SETTINGS='{ "files.autoSave": "afterDelay", "files.autoSaveDelay": 100 }' ;;
  idle)     FIX=ctex; TEST=idle.js; SETTINGS='{ "tectonicWatch.prewarmIdleMinutes": 0.2, "tectonicWatch.finalBuild": true }' ;;
  *) echo "unknown scenario $K"; exit 2 ;;
esac
cp -R "$HERE/fixtures/$FIX" "$W/proj"
if [ -n "$SETTINGS" ]; then mkdir -p "$W/proj/.vscode"; echo "$SETTINGS" > "$W/proj/.vscode/settings.json"; fi
set +e
TW_KIND=$FIX TW_OUT="$W/out.json" "$CODE" \
  --extensionDevelopmentPath="$ROOT" --extensionTestsPath="$HERE/$TEST" \
  --user-data-dir="$W/p" --extensions-dir="$W/x" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
  "$W/proj" > "$W/vscode.log" 2>&1
echo "exit $?"; cat "$W/out.json"
