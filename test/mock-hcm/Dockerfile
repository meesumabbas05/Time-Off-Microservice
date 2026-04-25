FROM node:20-slim

WORKDIR /app

COPY package*.json ./
# Since we don't have a package.json in the subfolder yet, I'll create one or just use root if I have to.
# Better to create a minimal one.

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN echo '{"name": "mock-hcm", "version": "1.0.0", "dependencies": {"express": "^4.18.2"}}' > package.json
RUN npm install

COPY mock-hcm.js .

EXPOSE 4000

CMD ["node", "mock-hcm.js"]
