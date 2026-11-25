FROM node:26-alpine
WORKDIR /app
COPY *.mjs ./
ENV PORT=8095 NODE_ENV=production
EXPOSE 8095
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server.mjs"]
