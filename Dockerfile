FROM oven/bun:canary-alpine

RUN apk update && apk upgrade
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY ./src ./src
COPY ./shaka-packager-bin ./shaka-packager-bin
COPY ./package.json ./
COPY ./tsconfig.json ./
COPY ./start.sh ./

ENV NODE_ENV=production

RUN bun install

EXPOSE 3000

RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

CMD ["/app/start.sh"]