FROM node:lts-alpine
WORKDIR /app
COPY server.js index.html ./
EXPOSE 3000
ENV PORT=3000
ENTRYPOINT ["node", "server.js"]
CMD []
