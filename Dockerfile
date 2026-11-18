# Hugging Face Space (тип Docker). Слухає порт 7860.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "start"]
