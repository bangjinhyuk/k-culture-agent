#!/usr/bin/env bash

set -u

SANDBOX="${1:-k-culture-agent}"

PASS=0
FAIL=0

if ! openshell sandbox get "$SANDBOX" >/dev/null 2>&1; then
  echo "❌ Cannot reach running sandbox: $SANDBOX" >&2
  echo "   Start and select an OpenShell gateway, then create the sandbox before testing." >&2
  exit 2
fi

pass() {
  echo "✅ PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "❌ FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo
echo "=========================================="
echo " K-Culture OpenShell Security Test"
echo "=========================================="
echo

echo "[1/6] input must be readable"
if openshell sandbox exec -n "$SANDBOX" -- \
  cat /workspace/hackathon/input/culture/food_glossary.md \
  >/dev/null 2>&1
then
  pass "/input is readable"
else
  fail "/input is NOT readable"
fi

echo
echo "[2/6] output must be writable"
if openshell sandbox exec -n "$SANDBOX" -- \
  sh -c 'echo security-test > /workspace/hackathon/output/security-test.txt' \
  >/dev/null 2>&1
then
  pass "/output is writable"
else
  fail "/output is NOT writable"
fi

echo
echo "[3/6] restricted must be blocked"
if openshell sandbox exec -n "$SANDBOX" -- \
  cat /workspace/hackathon/restricted/latest_verified_history.md \
  >/dev/null 2>&1
then
  fail "/restricted is readable"
else
  pass "/restricted is blocked"
fi

echo
echo "[4/6] secrets must be blocked"
if openshell sandbox exec -n "$SANDBOX" -- \
  cat /workspace/hackathon/secrets/service_key.env \
  >/dev/null 2>&1
then
  fail "/secrets is readable"
else
  pass "/secrets is blocked"
fi

echo
echo "[5/6] outbound internet must be blocked"
if openshell sandbox exec -n "$SANDBOX" -- \
  curl -fsS --max-time 5 https://example.com \
  >/dev/null 2>&1
then
  fail "outbound internet is allowed"
else
  pass "outbound internet is blocked"
fi

echo
echo "[6/6] app directory must be read-only"
if openshell sandbox exec -n "$SANDBOX" -- \
  touch /workspace/app/SHOULD_NOT_EXIST \
  >/dev/null 2>&1
then
  fail "/workspace/app is writable"
else
  pass "/workspace/app is read-only"
fi

echo
echo "=========================================="
echo " Result: PASS=$PASS FAIL=$FAIL"
echo "=========================================="

if [ "$FAIL" -eq 0 ]; then
  echo "🎉 OpenShell minimum-permission policy OK"
  exit 0
else
  echo "⚠️ OpenShell policy needs attention"
  exit 1
fi
