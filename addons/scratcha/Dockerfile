# ScratcHA add-on image. No build.yaml: the base image is multi-arch.
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.24
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG BUILD_VERSION=0.1.0
# Optional TurboWarp editor build (see editor/ and .github/workflows/editor.yml).
# Leave EDITOR_URL empty to build without the editor. Players still work.
ARG EDITOR_URL=""
ARG EDITOR_SHA256=""

ENV NODE_ENV=production

RUN apk add --no-cache nodejs npm

WORKDIR /opt/scratcha
COPY rootfs/opt/scratcha/package.json rootfs/opt/scratcha/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY rootfs /

RUN set -eu; \
	if [ -n "${EDITOR_URL}" ]; then \
		if [ -z "${EDITOR_SHA256}" ]; then echo "EDITOR_SHA256 is required with EDITOR_URL" >&2; exit 1; fi; \
		curl -fsSL "${EDITOR_URL}" -o /tmp/editor.tar.gz; \
		echo "${EDITOR_SHA256}  /tmp/editor.tar.gz" | sha256sum -c -; \
		mkdir -p /opt/scratcha/editor; \
		tar -xzf /tmp/editor.tar.gz -C /opt/scratcha/editor; \
		rm /tmp/editor.tar.gz; \
	fi; \
	chmod a+x /etc/services.d/scratcha/run /etc/services.d/scratcha/finish

EXPOSE 8098 8099

LABEL \
	io.hass.version="${BUILD_VERSION}" \
	io.hass.type="addon" \
	io.hass.arch="${BUILD_ARCH}" \
	org.opencontainers.image.title="ScratcHA" \
	org.opencontainers.image.source="https://github.com/Vortitron/ScratcHA" \
	org.opencontainers.image.licenses="MIT"
