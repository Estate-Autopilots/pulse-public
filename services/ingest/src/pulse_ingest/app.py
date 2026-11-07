"""The ingest HTTP service (FastAPI): /healthz, POST /v1/events (devices) and POST /v1/connectors/batches (company
plugins, R52; off unless PULSE_CONNECTORS=1). Port 8080 (ea-deploy contract)."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from pulse_sdk import __version__
from pulse_sdk import registry as reg
from pulse_sdk.db import url_for
from pulse_sdk.validate import EventValidator

from .connectors import ingest_connector_batch
from .core import MAX_BODY, ingest_device_batch


def create_app(dsn: str | None = None) -> FastAPI:
    pool = ConnectionPool(dsn or url_for("ingest"), min_size=1, max_size=int(os.environ.get("PULSE_INGEST_POOL", 5)),
                          kwargs={"row_factory": dict_row, "autocommit": True, "application_name": "pulse-ingest"},
                          open=False)
    registry = reg.default()
    validator = EventValidator(registry)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        pool.open(wait=False)
        yield
        pool.close()

    # No /docs, /redoc or /openapi.json on an internet-facing service.
    app = FastAPI(title="Pulse ingest", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url=None)

    @app.get("/")
    def index():
        return {"service": "pulse-ingest", "version": __version__, "registry": registry.version}

    @app.get("/healthz")
    def healthz():
        try:
            with pool.connection(timeout=3) as conn:
                conn.execute("select 1")
            return {"ok": True, "db": "ok"}
        except Exception:  # health must answer, never raise
            return JSONResponse({"ok": False, "db": "unreachable"}, status_code=503)

    async def signed(request: Request, ingest):
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY:
            return JSONResponse({"error": f"body larger than {MAX_BODY} bytes"}, status_code=413)
        chunks, size = [], 0
        async for chunk in request.stream():          # never buffer more than the cap
            size += len(chunk)
            if size > MAX_BODY:
                return JSONResponse({"error": f"body larger than {MAX_BODY} bytes"}, status_code=413)
            chunks.append(chunk)
        body = b"".join(chunks)

        def handle():
            with pool.connection() as conn:
                return ingest(conn, request.headers, body, validator=validator, registry=registry)

        result = await run_in_threadpool(handle)
        return JSONResponse(result.body, status_code=result.status)

    @app.post("/v1/events")
    async def events(request: Request):
        return await signed(request, ingest_device_batch)

    @app.post("/v1/connectors/batches")
    async def connector_batches(request: Request):
        return await signed(request, ingest_connector_batch)

    app.state.pool = pool
    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(), host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8080")),
                proxy_headers=True)


if __name__ == "__main__":
    main()
