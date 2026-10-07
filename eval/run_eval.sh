#!/usr/bin/env bash
# Send the test questions in questions/ to an OpenShell sandbox and save the results.
#   ./run_eval.sh <sandbox> [question-id ...]      e.g. ./run_eval.sh k-culture-agent t02 t05
# With no question IDs, every questions/*.txt is sent.
# Results go to results/<sandbox>-<timestamp>/ (raw JSON, report per question, summary).
#
# Defaults per sandbox (override with AGENT= and WORKDIR=):
#   opencode-nemotron  -> default agent, /sandbox
#   anything else      -> agent k-culture, /workspace/app
set -uo pipefail
cd "$(dirname "$0")"

SANDBOX="${1:?usage: $0 <sandbox> [question-id ...]}"; shift
if [ "$SANDBOX" = opencode-nemotron ]; then
  AGENT="${AGENT-}"; WORKDIR="${WORKDIR:-/sandbox}"
else
  AGENT="${AGENT-k-culture}"; WORKDIR="${WORKDIR:-/workspace/app}"
fi
TIMEOUT="${TIMEOUT:-900}"

if [ $# -eq 0 ]; then
  FILES=(questions/*.txt)
else
  FILES=(); for id in "$@"; do FILES+=(questions/"$id"*.txt); done
fi

OUT="results/$SANDBOX-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
AGENT_FLAG=""; [ -n "$AGENT" ] && AGENT_FLAG="--agent $AGENT"
echo "sandbox=$SANDBOX agent=${AGENT:-default} workdir=$WORKDIR -> $OUT"

{
  echo "# 평가 결과: $SANDBOX"
  echo
  echo "- 시각: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 에이전트: ${AGENT:-default}, 작업 디렉터리: $WORKDIR"
  echo "- 판정 기준: QUESTIONS.md"
  echo
} > "$OUT/summary.md"

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "skip: $f not found"; continue; }
  id=$(basename "$f" .txt)
  prompt=$(base64 -w0 < "$f")
  start=$(date +%s)
  # The question is passed base64-encoded so quoting and Korean text survive the remote shell.
  timeout "$TIMEOUT" openshell sandbox exec -n "$SANDBOX" -- sh -c \
    "cd $WORKDIR && opencode run --format json $AGENT_FLAG \"\$(echo $prompt | base64 -d)\"" \
    </dev/null > "$OUT/$id.json" 2> "$OUT/$id.err"
  rc=$?
  secs=$(( $(date +%s) - start ))
  {
    echo "## $id"
    echo
    echo "> $(cat "$f")"
    echo
    echo "exit=$rc, ${secs}s"
    echo
    python3 parse.py "$OUT/$id.json"
    grep -h 'permission requested' "$OUT/$id.err" | sed 's/\x1b\[[0-9;]*m//g; s/^/- /' || true
    echo
  } > "$OUT/$id.md"
  cat "$OUT/$id.md" >> "$OUT/summary.md"
  echo "$id exit=$rc ${secs}s"
done

# Network attempts that OpenShell blocked during this run
{
  echo "## 차단된 네트워크 시도 (최근 1시간)"
  echo
  echo '```'
  timeout 60 openshell logs "$SANDBOX" --since 1h 2>/dev/null | grep -E 'DENIED' \
    | sed -E 's/.*(DENIED)/\1/' | cut -c1-160 | sort | uniq -c | sort -rn | head -20
  echo '```'
} >> "$OUT/summary.md"
echo "summary: $OUT/summary.md"
