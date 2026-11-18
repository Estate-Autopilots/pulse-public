"""TASK-MERGE decision model (DECISION-MODELS.md): sentence embeddings of open task titles for the merge suggester.

A static multilingual model (sentence-transformers/static-similarity-mrl-multilingual-v1, Apache-2.0) cut to 256
dimensions: a title's vector is the mean of its tokens' rows, normalised. No GPU, no torch: numpy and tokenizers
only, about 110 MB of RAM and a fraction of a millisecond per title on this server's CPU. It runs only where the
server turned it on (PULSE_TASK_MERGE_MODEL=static256, off by default) and its files are present
(PULSE_TASK_MERGE_MODEL_DIR, made once by tools/admin/task-merge-model.py); otherwise it does nothing and the
suggester uses words and structure only.

Titles never leave the server and are never logged; counts only.
"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

MODEL = "static-similarity-mrl-multilingual-v1@b68f412:256"
DIMS = 256
BATCH = 500
DEFAULT_DIR = Path.home() / ".cache/pulse-models/static-sim-mrl-ml-v1-256"


def model_on(env=os.environ) -> bool:
    """The feature flag: the decision model runs only where the server switched it on."""
    return env.get("PULSE_TASK_MERGE_MODEL", "off") == "static256"


def text_hash(title: str) -> str:
    return hashlib.md5(" ".join(title.split()).lower().encode("utf-8")).hexdigest()


class StaticEmbedder:
    """Mean of the tokens' rows of a static embedding table, normalised (cosine = dot product)."""

    def __init__(self, path: Path):
        import numpy as np  # noqa: PLC0415 - optional: only where the model is switched on
        from tokenizers import Tokenizer  # noqa: PLC0415

        self.np = np
        self.table = np.load(path / "embeddings.f16.npy", mmap_mode="r")
        if self.table.shape[1] != DIMS:
            raise ValueError("the model table must have 256 columns")
        self.tok = Tokenizer.from_file(str(path / "tokenizer.json"))
        self.tok.no_padding()
        self.tok.no_truncation()

    def embed(self, texts: list[str]):
        np = self.np
        out = np.zeros((len(texts), DIMS), np.float32)
        for i, enc in enumerate(self.tok.encode_batch(texts, add_special_tokens=False)):
            if enc.ids:
                out[i] = np.asarray(self.table[enc.ids], dtype=np.float32).mean(0)
        return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-9)


_embedder: StaticEmbedder | None = None


def embedder(env=os.environ) -> StaticEmbedder | None:
    """The loaded model, or None when it is off, its files are missing or its libraries are not installed."""
    global _embedder
    if not model_on(env):
        return None
    if _embedder is None:
        path = Path(env.get("PULSE_TASK_MERGE_MODEL_DIR", str(DEFAULT_DIR)))
        try:
            _embedder = StaticEmbedder(path)
        except (OSError, ImportError, ValueError) as exc:
            log.warning("task merge model unavailable (%s); the suggester uses words only", type(exc).__name__)
            return None
    return _embedder


def vector_literal(v) -> str:
    return "[" + ",".join(f"{float(x):.5g}" for x in v) + "]"


def refresh(conn, model: StaticEmbedder, limit: int = 5000) -> dict:
    """Embed this tenant's open tasks whose title is new or changed (inside a tenant transaction); drop vectors of
    closed tasks. Returns counts."""
    rows = conn.execute(
        """select t.id, t.title, e.text_hash from pulse.task t
           left join pulse.task_embedding e on e.task_id = t.id and e.model = %s
           where t.status in ('open','in_progress','blocked','unknown') and t.deleted_at is null
           order by t.updated_at desc nulls last limit %s""", (MODEL, limit)).fetchall()
    todo = [(r["id"], r["title"], text_hash(r["title"])) for r in rows]
    todo = [(i, t, h) for (i, t, h), r in zip(todo, rows, strict=True) if h != r["text_hash"]]
    made = 0
    for k in range(0, len(todo), BATCH):
        part = todo[k:k + BATCH]
        vecs = model.embed([t for _, t, _ in part])
        with conn.cursor() as cur:
            cur.executemany(
                """insert into pulse.task_embedding (org_id, task_id, model, text_hash, embedding)
                   values (pulse.current_org(), %s, %s, %s, %s::public.halfvec)
                   on conflict (task_id) do update set model = excluded.model, text_hash = excluded.text_hash,
                     embedding = excluded.embedding, at = now()""",
                [(i, MODEL, h, vector_literal(v)) for (i, _, h), v in zip(part, vecs, strict=True)])
        made += len(part)
    gone = conn.execute(
        """delete from pulse.task_embedding e using pulse.task t where t.id = e.task_id
           and (t.status not in ('open','in_progress','blocked','unknown') or t.deleted_at is not null)""").rowcount
    return {"open": len(rows), "embedded": made, "dropped": gone}
