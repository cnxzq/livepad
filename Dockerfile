FROM node:lts-alpine
WORKDIR /app
COPY packages/cli/package.json packages/cli/cli.js packages/cli/server.js packages/cli/index.html packages/cli/LICENSE ./
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENTRYPOINT ["node", "cli.js"]
CMD []
