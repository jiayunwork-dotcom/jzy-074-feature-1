# syntax=docker/dockerfile:1

# ---- 构建阶段：完整 node:20-slim 上安装（含原生模块 better-sqlite3 的预编译/回退构建）----
FROM node:20-slim AS build
WORKDIR /app

# 先装依赖，利用层缓存。better-sqlite3 为原生模块：
# 优先下载对应平台的预编译二进制；万一没有预编译包，回退从源码构建。
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# 构建期跑一遍测试，保证“一次构建就能跑通”——物理关系/并发隔离不过则镜像失败。
COPY src ./src
COPY test ./test
RUN node --test

# ---- 运行阶段：node:20-slim，仅拷贝产物与原生插件 ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/shield.sqlite

# node:20-slim 已含加载预编译原生插件所需的最小运行库（glibc/libstdc++）。
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY src ./src

# SQLite 落盘目录（也可用 -v 挂载卷覆盖）。
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
