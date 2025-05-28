# Etapa 1: Imagem base leve
FROM node:24-slim

# Etapa 2: Diretório de trabalho
WORKDIR /app

# Etapa 3: Copia os arquivos de dependência
COPY package*.json ./

# Etapa 4: Instala dependências
RUN npm install --production

# Etapa 5: Copia o restante do projeto
COPY . .

# Etapa 6: Define variáveis de ambiente (caso queira testar sem .env)
# ENV DB_HOST=host DB_USER=user DB_PASS=pass DB_BASE=base DB_PORT=3306 MP_ACCESS_TOKEN=seutoken

# Etapa 7: Expõe a porta
EXPOSE 3221

# Etapa 8: Comando de inicialização
CMD ["node", "bdf.js"]
