# InferenceMesh gateway.
#
# Packaged as a container because the audience for a free-inference router is
# not people who already have a Node toolchain. `docker compose up` is a
# smaller ask than "install Node 20, then npm install, then set these
# variables" — and it removes a whole class of "it works on my machine".
#
# It is also a containment boundary. This process holds every provider key you
# own, so it runs as a non-root user, ships no build tooling, and exposes only
# the gateway port.

FROM node:20-alpine AS build
WORKDIR /app

# Dependency install and source build are separate layers so that editing
# source does not re-download the toolchain.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY examples ./examples
# The suite validates the registry that ships with the package, so it has to be
# present at build time too. Leaving it out made the tests pass on a developer
# machine and fail inside the image — which is exactly what running them here
# is for.
#
# The same now goes for the README and the Worker example: the suite checks
# that every setting the server reads is documented, and that the snippet in
# the README is the file the build compiles. Those tests are about the package
# being coherent, so they belong in the build that produces it. This exact
# omission failed the image build the day the examples were added.
COPY providers.default.json providers.example.json README.md LICENSE ./
RUN npx tsc -p tsconfig.json

# The test suite needs no network, so it runs at build time. An image that
# cannot pass its own tests should never reach a registry.
RUN node --test dist/test/

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    INFERENCEMESH_HOST=0.0.0.0 \
    INFERENCEMESH_PORT=8910 \
    INFERENCEMESH_LEDGER=/data/ledger.json \
    INFERENCEMESH_DISCOVERY_STATE=/data/discovery.json \
    INFERENCEMESH_KEYS=/data/keys.env

# INFERENCEMESH_HOST is 0.0.0.0 *inside the container only*: the container's
# own network namespace is the boundary. Publish it as `127.0.0.1:8910:8910`
# on the host — see docker-compose.yml — so it is not exposed to the LAN or a
# tailnet. Binding 0.0.0.0 on the host would be the mistake this avoids.
ENV INFERENCEMESH_ALLOW_ANY_HOST=1

COPY --from=build /app/dist ./dist
# The licence travels with the image; it is MIT software being redistributed.
COPY package.json providers.default.json providers.example.json LICENSE README.md ./
COPY scripts ./scripts
# No `npm install` here on purpose: the package has zero runtime dependencies,
# so the runtime image contains the compiled output and nothing else. There is
# no dependency tree in the image to audit, patch, or be surprised by.

# Keys added through the setup page land in /data, which is the volume. They
# used to default to /app/.inferencemesh/keys.env — and the compose file mounts
# the image read-only, so the one onboarding path the README points at failed
# at the write, after verifying the key against the provider.

# Non-root. `node` (uid 1000) ships with the base image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8910

# A healthcheck that only proves the process is listening would go green while
# every provider was misconfigured. This one asks the gateway whether it has
# any usable candidate at all.
#
# It has to authenticate. /healthz is behind the bearer token unless
# INFERENCEMESH_PUBLIC_HEALTH=1, so without the header this asked an
# unauthorised question, read `candidates` off a 401 body, and reported the
# container unhealthy forever — measured: failing streak 3, status unhealthy,
# on a gateway that was answering perfectly well. Sending the token keeps
# /healthz closed to everything else. INFERENCEMESH_TOKENS may be a list; the
# first one is as good as any.
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.INFERENCEMESH_PORT||8910)+'/healthz',\
{headers:{authorization:'Bearer '+(process.env.INFERENCEMESH_TOKENS||'').split(',')[0].trim()}})\
.then(r=>r.json()).then(d=>process.exit(d.candidates>0?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server/node.js"]
