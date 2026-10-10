#!/bin/sh
# 容器内逐用例运行 safe-read 套件（定位挂起用例）。
set -u
cd /work
for name in S1 S2 S3 S4 S5 S6 S7a S7b S7c S7d S8 S9 S10; do
  echo "=== $name"
  timeout 20 node --test --test-name-pattern="${name}:" tests/runtime/badcase-capture-safe-read.test.js 2>&1 | grep -E '^ℹ (pass|fail|skipped)' | tr '\n' ' '
  echo
done
echo ALL-DONE
