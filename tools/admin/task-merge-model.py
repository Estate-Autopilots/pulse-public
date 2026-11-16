"""TASK-MERGE: make the merge suggester's decision model files once on a server (DECISION-MODELS.md).

Downloads sentence-transformers/static-similarity-mrl-multilingual-v1 (Apache-2.0) at a pinned revision, keeps the first
256 columns of its static embedding table as float16 (about 53 MB) and its tokenizer, in the directory the worker reads
(PULSE_TASK_MERGE_MODEL_DIR, default ~/.cache/pulse-models/static-sim-mrl-ml-v1-256). Then switch it on for the worker
with PULSE_TASK_MERGE_MODEL=static256 (the worker needs numpy and tokenizers: the pulse-workers "decide" extra).

  uv run --with huggingface_hub --with safetensors --with numpy python tools/admin/task-merge-model.py [--out DIR]
"""
import argparse
import shutil
from pathlib import Path

REPO = "sentence-transformers/static-similarity-mrl-multilingual-v1"
REVISION = "b68f4122911bcffcd6e1f695f2d99cd6788972d8"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", default=str(Path.home() / ".cache/pulse-models/static-sim-mrl-ml-v1-256"))
    out = Path(ap.parse_args().out)
    import numpy as np
    from huggingface_hub import snapshot_download
    from safetensors import safe_open

    d = Path(snapshot_download(REPO, revision=REVISION, allow_patterns=["0_StaticEmbedding/*"]))
    out.mkdir(parents=True, exist_ok=True)
    with safe_open(str(d / "0_StaticEmbedding/model.safetensors"), framework="np") as f:
        table = np.ascontiguousarray(f.get_slice(next(iter(f.keys())))[:, :256]).astype(np.float16)
    np.save(out / "embeddings.f16.npy", table)
    shutil.copy(d / "0_StaticEmbedding/tokenizer.json", out / "tokenizer.json")
    print(f"saved {table.shape[0]} tokens x {table.shape[1]} to {out}")


if __name__ == "__main__":
    main()
