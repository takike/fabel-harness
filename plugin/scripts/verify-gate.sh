#!/bin/sh
# Opt-in commit gate (FABEL_STRICT=1): warn — never block — when `git commit` runs
# while the working tree differs from the state recorded by the last /fabel:verify
# PASS (.fabel/verified holds `git diff HEAD | git hash-object --stdin`).
[ "$FABEL_STRICT" = "1" ] || exit 0

input=$(cat)
case "$input" in
  *'"command"'*) ;;
  *) exit 0 ;;
esac
case "$input" in
  *'git commit'*) ;;
  *) exit 0 ;;
esac

if [ ! -f .fabel/verified ]; then
  printf '{"systemMessage":"fabel: FABEL_STRICT is on and no .fabel/verified marker exists - run /fabel:verify before committing."}\n'
  exit 0
fi

current=$(git diff HEAD 2>/dev/null | git hash-object --stdin 2>/dev/null)
recorded=$(cat .fabel/verified 2>/dev/null)
if [ -n "$current" ] && [ "$current" != "$recorded" ]; then
  printf '{"systemMessage":"fabel: working tree changed since the last /fabel:verify PASS - consider re-verifying before commit."}\n'
fi
exit 0
