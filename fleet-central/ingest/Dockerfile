FROM oven/bun:1.3
WORKDIR /app
COPY package.json ./
RUN bun install
COPY . .
EXPOSE 9400
CMD ["bun", "src/index.ts"]
