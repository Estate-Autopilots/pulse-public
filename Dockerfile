# syntax=docker/dockerfile:1
# Node and Python use Debian trixie in both stages so the Node runtime can be copied into the Python image.
FROM node:24.21.0-trixie-slim AS node-build
WORKDIR /app
ENV RAYON_NUM_THREADS=2 UV_CONCURRENT_BUILDS=2
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/api/package.json services/api/package.json
COPY packages/sdk-ts/package.json packages/sdk-ts/package.json
COPY infra/web/package.json infra/web/package.json
COPY tests/e2e/package.json tests/e2e/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/companion/package.json packages/companion/package.json
COPY packages/ui-shell/package.json packages/ui-shell/package.json
COPY packages/design-system/package.json packages/design-system/package.json
COPY packages/invoice-doc/package.json packages/invoice-doc/package.json
COPY packages/chat-export/package.json packages/chat-export/package.json
COPY packages/pulse-cli/package.json packages/pulse-cli/package.json
RUN --mount=type=cache,id=pulse-pnpm,target=/pnpm/store,sharing=locked pnpm install --store-dir=/pnpm/store --frozen-lockfile --filter @pulse/api... --filter @pulse/web...
COPY services/api/tsconfig.json services/api/tsconfig.json
COPY services/api/src services/api/src
COPY services/api/data services/api/data
COPY apps/web apps/web
COPY packages/companion packages/companion
COPY packages/ui-shell packages/ui-shell
COPY packages/design-system packages/design-system
COPY packages/invoice-doc packages/invoice-doc
COPY packages/chat-export packages/chat-export
COPY packages/pulse-cli packages/pulse-cli
RUN mkdir -p apps/web/public
RUN pnpm --filter @pulse/api build
RUN pnpm --filter @pulse/web build

FROM node:24.21.0-trixie-slim AS node-production-dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/api/package.json services/api/package.json
COPY packages/sdk-ts/package.json packages/sdk-ts/package.json
COPY infra/web/package.json infra/web/package.json
COPY tests/e2e/package.json tests/e2e/package.json
# ERP-INVOICE: the API renders invoices with this workspace package (source, fonts and its PDF/DOCX dependencies).
COPY packages/invoice-doc packages/invoice-doc
# R47: the API reads WhatsApp text exports with the same reader as the browser preview (no dependencies).
COPY packages/chat-export packages/chat-export
RUN --mount=type=cache,id=pulse-pnpm,target=/pnpm/store,sharing=locked pnpm install --store-dir=/pnpm/store --prod --frozen-lockfile --filter @pulse/api...

FROM node:24.21.0-trixie-slim AS node-runtime

FROM python:3.12-slim-trixie AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never \
    PULSE_REPO_ROOT=/app PATH=/opt/venv/bin:$PATH NODE_ENV=production PORT=8080
RUN pip install --no-cache-dir uv==0.12.23 && useradd --system --home-dir /app --shell /usr/sbin/nologin pulse
WORKDIR /app

COPY pyproject.toml uv.lock .python-version ./
COPY collectors/meta_ads collectors/meta_ads
COPY collectors/gdrive_snapshot collectors/gdrive_snapshot
COPY collectors/gdrive_changes collectors/gdrive_changes
COPY collectors/gdrive_extract collectors/gdrive_extract
COPY packages/sdk-py packages/sdk-py
COPY services/ingest services/ingest
COPY services/ml/pulse_identity services/ml/pulse_identity
COPY services/ml/pulse_rules services/ml/pulse_rules
COPY services/workers services/workers
RUN --mount=type=cache,id=pulse-uv,target=/root/.cache/uv,sharing=locked uv sync --locked --no-dev --all-packages --no-editable
# The operator CLI must ship in every image (docker exec <container> pulse-admin …).
RUN pulse-admin --help >/dev/null

COPY packages/schemas packages/schemas
COPY db db
COPY config config
COPY infra/docker/start.sh /usr/local/bin/pulse-start
COPY tools/google-bridge.py tools/google-bridge.py
COPY infra/web infra/web
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-production-dependencies /app/node_modules /app/node_modules
COPY --from=node-production-dependencies /app/services/api/node_modules /app/services/api/node_modules
COPY --from=node-production-dependencies /app/services/api/package.json /app/services/api/package.json
COPY --from=node-production-dependencies /app/packages/invoice-doc /app/packages/invoice-doc
COPY --from=node-production-dependencies /app/packages/chat-export /app/packages/chat-export
COPY --from=node-build /app/services/api/dist /app/services/api/dist
COPY services/api/data services/api/data
# EST-2290: the API reads service.yaml at startup to publish the v1 reference.
COPY services/api/openapi/service.yaml services/api/openapi/service.yaml
COPY --from=node-build /app/apps/web/.next/standalone /app
COPY --from=node-build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=node-build /app/apps/web/public /app/apps/web/public
RUN node --version

USER pulse
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
CMD ["pulse-start"]
