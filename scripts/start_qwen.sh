#!/usr/bin/env bash
# Serve Qwen3-Next 80B (FP8) with vLLM on the free GPUs 4-7, loopback port 8001.
# The OpenShell sandbox reaches it as host.openshell.internal:8001 (see openshell/policy.yaml),
# the same way it reaches the Nemotron container on port 8000.
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/data/models/Qwen3-Next-80B-A3B-Instruct-FP8}"
GPUS="${GPUS:-4,5,6,7}"
PORT="${PORT:-8001}"
NAME="${NAME:-qwen3-next}"
IMAGE="${IMAGE:-local/vllm-openai:v0.31.0-cu129-nocodec}"
TP="$(awk -F, '{print NF}' <<<"$GPUS")"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
  --runtime nvidia --gpus "\"device=$GPUS\"" --ipc private --shm-size 16g \
  -p "127.0.0.1:$PORT:8000" -v /data:/data -e HF_HOME=/data/hf-cache \
  "$IMAGE" "$MODEL_DIR" \
  --served-model-name qwen/qwen3-next-80b \
  --host 0.0.0.0 --port 8000 \
  --tensor-parallel-size "$TP" --max-model-len 131072 --gpu-memory-utilization 0.9 \
  --enable-auto-tool-choice --tool-call-parser hermes --trust-remote-code
echo "started $NAME; follow with: docker logs -f $NAME   (ready when /v1/models answers on :$PORT)"
