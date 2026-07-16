# Snagarr container image
# Pinned to the Debian bookworm variant for a reproducible, patched base.
FROM python:3.12-slim-bookworm

# Do not write .pyc files (keeps a non-root /app clean) and stream logs unbuffered.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install Python dependencies first so this layer caches across code changes.
COPY requirements.txt /app/
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Copy the application source.
COPY . /app/

# Create a non-root user (uid/gid 1000) and the /config data tree it must own.
# /config is a bind mount at runtime; the host directory must be owned by
# 1000:1000 (e.g. `chown -R 1000:1000 ./config`) so the app can write to it.
RUN groupadd --gid 1000 snagarr \
    && useradd --uid 1000 --gid 1000 --home-dir /app --no-create-home --shell /usr/sbin/nologin snagarr \
    && mkdir -p /config/settings /config/stateful /config/user /config/logs \
    && chown -R 1000:1000 /app /config

USER 1000:1000

EXPOSE 9705

# Python-based health check against the /ping endpoint (no curl or net-tools needed).
# urlopen follows the auth redirect, so this stays healthy with or without login enabled.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python3", "-c", "import sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:9705/ping', timeout=4); sys.exit(0 if r.status < 400 else 1)"]

CMD ["python3", "main.py"]
