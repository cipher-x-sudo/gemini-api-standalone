# Standalone HTTP wrapper for gemini_webapi (Google Gemini web app session cookies).
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GEMINI_PROFILES_ROOT=/data/profiles \
    GEMINI_INTERNAL_PORT=9380

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY --from=frontend-builder /frontend/dist /app/frontend/dist

RUN mkdir -p /data/profiles && chmod 700 /data

# Container listen port (override with -e GEMINI_INTERNAL_PORT=...). Not 8080 by default.
EXPOSE 9380

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${GEMINI_INTERNAL_PORT:-9380}"]
