# Single-image build for Dokploy.
#
# IMPORTANT: build context must be the REPO ROOT, not app/.
# In Dokploy:  Build Context = .   Dockerfile = app/Dockerfile
#
# Stage 1 — build the Vite SPA. `VITE_BASE` is baked into asset URLs.
# Stage 2 — Python + Node + `claude` CLI + uv. Bakes:
#             /app    backend source + built SPA under /app/static
#             /shared system_prompt.md, docs/, scripts/, root pyproject
#                     (the workspace claude runs from)

FROM node:22-slim AS frontend-build
WORKDIR /build
COPY app/frontend/package.json app/frontend/package-lock.json* ./
RUN npm ci
COPY app/frontend/ ./
ARG VITE_BASE=/
ENV VITE_BASE=${VITE_BASE}
RUN npm run build


FROM python:3.13-slim AS prod

RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# --- /shared: cwd claude runs from, holds prompt + docs + scripts ---
WORKDIR /shared
COPY system_prompt.md ./
# Only the warehouse schema — the agent should not see internal dev docs, the
# 0.5MB dataset dumps, or images. Keeps its working context focused and lean.
COPY docs/warehouse_schema_ce.md ./docs/warehouse_schema_ce.md
COPY scripts/ ./scripts/
COPY pyproject.toml uv.lock .python-version ./
# Pre-install the warehouse-query deps (psycopg2-binary, python-dotenv) into
# /shared/.venv so `uv run scripts/run_query.py` starts instantly.
RUN uv sync --frozen

# --- /app: the FastAPI backend ---
WORKDIR /app

COPY app/backend/pyproject.toml app/backend/uv.lock ./
RUN uv sync --frozen --no-install-project

COPY app/backend/ ./

COPY --from=frontend-build /build/dist ./static

ENV APP_PREFIX=
ENV SHARED_ROOT=/shared

EXPOSE 4003
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "4003"]
