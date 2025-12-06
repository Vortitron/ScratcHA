ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.19
FROM ${BUILD_FROM}

ENV NODE_ENV=production

RUN apk add --no-cache nodejs npm

WORKDIR /opt/scratcha
COPY rootfs/opt/scratcha/package.json /opt/scratcha/package.json
RUN npm install --omit=dev
COPY rootfs/opt/scratcha /opt/scratcha
COPY rootfs/etc /etc

EXPOSE 8099

CMD ["/init"]

