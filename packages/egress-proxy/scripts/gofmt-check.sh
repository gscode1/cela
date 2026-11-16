#!/bin/sh
# Fails when any Go file is not gofmt-clean. Used by `pnpm typecheck`.
out=$(gofmt -l .)
if [ -n "$out" ]; then
  echo "gofmt needed on:" >&2
  echo "$out" >&2
  exit 1
fi
