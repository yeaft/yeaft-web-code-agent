FROM node:24-bookworm-slim

ARG BUILD_VERSION=dev
ENV NODE_ENV=production \
    HOME=/home/yeaft \
    YEAFT_DIR=/home/yeaft/.yeaft \
    WORK_DIR=/workspace \
    YEAFT_AGENT_RUNTIME=container_agent \
    VIRTUAL_ENV=/opt/yeaft-python \
    PATH=/opt/yeaft-python/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 python3-venv tini wget \
  && python3 -m venv "$VIRTUAL_ENV" \
  && "$VIRTUAL_ENV/bin/pip" install --no-cache-dir "akshare==1.18.91" \
  && "$VIRTUAL_ENV/bin/python" -c "import akshare; assert akshare.__version__ == '1.18.91'; assert all(hasattr(akshare, name) for name in ('stock_info_global_em', 'futures_display_main_sina', 'futures_zh_spot'))" \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin yeaft \
  && mkdir -p /app /workspace /home/yeaft/.yeaft \
  && chown -R yeaft:yeaft /app /workspace /home/yeaft

WORKDIR /app
COPY package.json package-lock.json ./
COPY agent/package.json ./agent/
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm_config_cache=/tmp/yeaft-npm-cache npm ci --workspace=agent --omit=dev \
  && rm -rf /tmp/yeaft-npm-cache \
  && install -d -m 0700 -o yeaft -g yeaft /home/yeaft/.npm
COPY --chown=yeaft:yeaft agent ./agent
RUN node -e "const fs=require('fs'); const p='agent/package.json'; const j=JSON.parse(fs.readFileSync(p)); j.version=process.argv[1].replace(/^v/, ''); fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\\n')" "$BUILD_VERSION" \
  && chmod 0755 agent/container-entrypoint.sh

VOLUME ["/home/yeaft/.yeaft", "/workspace"]
ENTRYPOINT ["/app/agent/container-entrypoint.sh"]
CMD []
