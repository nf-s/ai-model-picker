#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "The local HN classifier requires an Apple Silicon Mac." >&2
  exit 1
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
state_dir="$repo_dir/.local/hn"
local_python="$state_dir/venv/bin/python"

if [[ ! -x "$local_python" ]]; then
  if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' >/dev/null 2>&1; then
    echo "Python 3.11 or newer is required for local HN setup." >&2
    exit 1
  fi

  mkdir -p "$state_dir"
  if ! python3 -m venv "$state_dir/venv" >/dev/null 2>&1; then
    echo "Could not create the local HN virtual environment." >&2
    exit 1
  fi
fi

if ! "$local_python" -I -m pip --version >/dev/null 2>&1; then
  if ! "$local_python" -I -m ensurepip --upgrade --default-pip >/dev/null 2>&1; then
    echo "Could not install pip in the local HN virtual environment." >&2
    exit 1
  fi
fi

echo "Installing the local HN runtime."
if ! PIP_CONFIG_FILE=/dev/null "$local_python" -m pip --isolated install \
  --disable-pip-version-check --no-input --no-cache-dir \
  --index-url https://pypi.org/simple \
  --requirement "$repo_dir/requirements-hn.txt" mlx-lm==0.32.2 >/dev/null 2>&1; then
  echo "Could not install the local HN dependencies from PyPI." >&2
  exit 1
fi

echo "Checking the local model weights."
mkdir -p "$state_dir/model-cache/hub"
export HF_HOME="$state_dir/model-cache"
export HF_ENDPOINT=https://huggingface.co
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_XET=1
export HF_HUB_DISABLE_PROGRESS_BARS=1
unset HF_HUB_OFFLINE HF_TOKEN HUGGING_FACE_HUB_TOKEN

if ! "$local_python" -I - "$state_dir/models/qwen3.8-27b-4bit" >/dev/null 2>&1 <<'PY'
import sys
from hashlib import file_digest
from pathlib import Path

from huggingface_hub import snapshot_download

model_dir = Path(sys.argv[1])
snapshot_download(
    repo_id="mlx-community/Qwen3.8-27B-4bit",
    revision="b935172e4bb5dcd0543774a34748fb92422e3027",
    local_dir=model_dir,
    token=False,
    allow_patterns=[
        "model-0000[1-3]-of-00003.safetensors",
        "model.safetensors.index.json",
        "config.json",
        "generation_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "chat_template.jinja",
        "vocab.json",
    ],
)

pinned = {
    "model-00001-of-00003.safetensors": "6cc1508e96fb5d0865dfd5753a79f4ec60651bf3e2a82844a7e8ae9c60528c0d",
    "model-00002-of-00003.safetensors": "83f2a20ca8058f486a3634a27faf99587f4cd3c156a83dee34fb99e6ac178670",
    "model-00003-of-00003.safetensors": "31b8c91ef899f79efaaa69e3d2c096f6e2ebeb2ff20e29222abbd9ebc79e560a",
}
for name, expected in pinned.items():
    with (model_dir / name).open("rb") as weights:
        if file_digest(weights, "sha256").hexdigest() != expected:
            raise SystemExit("Model weights do not match the pinned revision.")
PY
then
  echo "Could not download or verify the public model files." >&2
  exit 1
fi

echo "The local HN runtime is ready."
