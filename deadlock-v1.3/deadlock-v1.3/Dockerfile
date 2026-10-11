FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts
RUN npm ci --omit=dev --no-audit --no-fund && chown -R node:node /app
COPY --chown=node:node . .
USER node
ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server/index.js"]
