# Optional local QA renderer; never used by the application or default build.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      libreoffice-impress poppler-utils fonts-liberation python3 python3-pil \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=C.UTF-8 HOME=/tmp/showcase-home
ENTRYPOINT ["python3", "/renderer/render-showcase.py"]
