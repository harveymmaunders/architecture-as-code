FROM node:26-alpine
WORKDIR /app
COPY server.mjs tracing.mjs flows.mjs page.mjs control.mjs flow-driver.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
# Checks /metrics, not /health, so a service toggled DOWN keeps a healthy container.
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/metrics || exit 1
CMD ["node", "server.mjs"]
