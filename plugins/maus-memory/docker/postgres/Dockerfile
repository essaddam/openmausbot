# Postgres 16 with pgvector (from the PGDG repository the official image ships) and Apache AGE built from a pinned commit.
ARG POSTGRES_IMAGE=postgres:16-bookworm
FROM ${POSTGRES_IMAGE}
ARG AGE_COMMIT=8c74fd24dd91bba54fdf4793fccd0fb7bd2bb9d8
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector ca-certificates git build-essential flex bison postgresql-server-dev-16 \
 && git clone https://github.com/apache/age.git /tmp/age \
 && git -C /tmp/age checkout "${AGE_COMMIT}" \
 && make -C /tmp/age PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config install \
 && apt-get purge -y git build-essential flex bison postgresql-server-dev-16 \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /tmp/age
CMD ["postgres", "-c", "shared_preload_libraries=age"]
