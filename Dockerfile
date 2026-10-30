FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./server.mjs
COPY public ./public
ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.mjs"]
