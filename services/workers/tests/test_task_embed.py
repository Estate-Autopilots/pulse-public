"""TASK-MERGE decision model: off by default, on only with the flag and its files; titles are hashed the same way
however they are spaced or cased. Fake titles only; the model itself is measured in DECISION-MODELS.md."""
from pathlib import Path

from pulse_workers import task_embed


def test_the_model_is_off_unless_the_server_switches_it_on(tmp_path: Path):
    assert task_embed.model_on({}) is False
    assert task_embed.model_on({"PULSE_TASK_MERGE_MODEL": "off"}) is False
    assert task_embed.model_on({"PULSE_TASK_MERGE_MODEL": "static256"}) is True
    task_embed._embedder = None
    assert task_embed.embedder({}) is None
    # On, but its files are not there: nothing breaks, the suggester keeps to words.
    env = {"PULSE_TASK_MERGE_MODEL": "static256", "PULSE_TASK_MERGE_MODEL_DIR": str(tmp_path)}
    assert task_embed.embedder(env) is None


def test_a_title_hash_ignores_spacing_and_case():
    assert task_embed.text_hash("EXAMPLE  Reel edit") == task_embed.text_hash("example reel edit")
    assert task_embed.text_hash("EXAMPLE Reel edit") != task_embed.text_hash("EXAMPLE Reel cut")
    assert task_embed.vector_literal([0.5, -0.25]) == "[0.5,-0.25]"
