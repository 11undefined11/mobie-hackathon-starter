FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 VOICE_SESSION_DIRECTORY=/app/.local/voice-sessions
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /app/.local/voice-sessions && chown -R node:node /app/.local
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
