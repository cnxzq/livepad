FROM node:lts-alpine
WORKDIR /app
COPY package.json cli.js server.js index.html LICENSE ./
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
ENTRYPOINT ["node", "cli.js"]
CMD []
