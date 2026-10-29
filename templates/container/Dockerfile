# The Proteus container worker image (#80): node proteus-container.js build builds it from this file and
# proteus-container-entry.js, copied beside it. Node, git, CA certificates and Claude Code, run as the node user.
# A project needing a toolchain builds its own image FROM this one and passes it with --image.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm i -g @anthropic-ai/claude-code && npm cache clean --force

# the root filesystem is read-only at run time: no self-update
ENV DISABLE_AUTOUPDATER=1
COPY proteus-container-entry.js /usr/local/lib/proteus/proteus-container-entry.js
USER node
WORKDIR /work
ENTRYPOINT ["node", "/usr/local/lib/proteus/proteus-container-entry.js"]
