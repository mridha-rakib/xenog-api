FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG TYPESCRIPT_HEAP_MB=1024
RUN NODE_OPTIONS="--max-old-space-size=${TYPESCRIPT_HEAP_MB}" npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
COPY package*.json ./
RUN npm ci --no-audit --no-fund --omit=dev
COPY --from=builder --chown=node:node /app/dist ./dist
# ffmpeg is only invoked by src/video-worker.ts (never by src/server.ts), and
# that worker now exits immediately without starting while video is
# temporarily disabled (ENABLE_VIDEO_UPLOADS is not "true" — see
# src/config/env.ts / src/video-worker.ts). Commented out rather than
# removed: re-enabling video requires restoring this line and rebuilding the
# image, in addition to setting ENABLE_VIDEO_UPLOADS=true.
# RUN apk add --no-cache ffmpeg
RUN mkdir -p /app/tmp/transcoding && chown -R node:node /app/tmp
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "const port=process.env.PORT||5000; const prefix=process.env.API_PREFIX||'/api/v1'; const url='http://127.0.0.1:'+port+prefix+'/health'; fetch(url).then((res)=>{if(!res.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
