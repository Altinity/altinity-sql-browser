FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY build ./build
COPY schemas ./schemas
COPY src ./src
COPY THIRD-PARTY-NOTICES.md ./

RUN npm ci --no-audit --no-fund
RUN npm run build

FROM python:3.12-slim AS runtime

ENV HOME=/home/asb \
    HOST=0.0.0.0 \
    PORT=8900 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --home-dir /home/asb --shell /usr/sbin/nologin asb \
    && mkdir -p /app \
    && chown -R asb:asb /app /home/asb

WORKDIR /app

COPY --from=build /app/dist/sql.html /app/sql.html
COPY build/local.py /app/local.py
COPY deploy/sql-browser.xml /app/sql-browser.xml

USER asb

EXPOSE 8900

CMD ["python3", "/app/local.py"]
