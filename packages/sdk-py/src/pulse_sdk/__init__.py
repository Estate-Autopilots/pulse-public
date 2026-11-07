"""Pulse Event Core SDK (spec 02 §3, 05 §5-§9).

Modules: ``ids`` (deterministic projection ids), ``ulid`` (event ids), ``cid`` (creative ids), ``registry`` and
``validate`` (envelope + registry checks), ``envelope`` (CloudEvent <-> log row), ``store`` (idempotent inserts),
``identity`` (actor -> person), ``privacy`` (notice and consent coverage), ``signing`` (Ed25519 device batches),
``collector`` and ``runtime`` (collector contract and runtime), ``db`` (tenant transactions), ``migrate``.
"""

__version__ = "0.1.0"
