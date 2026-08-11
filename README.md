# CopiarLink - Extrator próprio (automação de navegador)

Extrai o link de vídeos da Shopee abrindo a página real num Chrome
sem tela (headless) e escutando as respostas de rede — a mesma coisa
que você fez manualmente no F12, só que automática.

## Rodando localmente (pra testar no seu computador)

```bash
npm install
npm start
```

Depois teste no navegador:
```
http://localhost:3000/api/extract?url=https://shopee.com.br/SEU-LINK-DE-PRODUTO-AQUI
```

## Onde hospedar (precisa de VPS, não roda em hospedagem PHP simples)

Puppeteer precisa rodar um Chrome de verdade, então a hospedagem
precisa suportar Node.js + Chromium. Opções fáceis:

### Opção 1 — Railway (mais simples, tem plano gratuito pra testar)
1. Crie conta em https://railway.app
2. "New Project" → "Deploy from GitHub repo" (suba esses arquivos pro
   GitHub primeiro) ou "Empty Project" e arraste os arquivos
3. Railway detecta automaticamente que é um projeto Node.js
4. Nas variáveis de ambiente, adicione: `PORT=3000`
5. Espera o deploy terminar e copia a URL pública gerada

### Opção 2 — Render.com
1. Crie conta em https://render.com
2. "New" → "Web Service" → conecta seu repositório
3. Build command: `npm install`
4. Start command: `npm start`
5. Copia a URL pública gerada (algo como `https://seu-app.onrender.com`)

### Opção 3 — VPS própria (DigitalOcean, Contabo, Hetzner)
Mais barato a longo prazo, mas exige mais configuração manual
(instalar Node.js, dependências do Chromium no Linux, PM2 pra manter
o processo rodando). Se quiser esse caminho, me avisa que te ajudo
com os comandos específicos.

## Conectando no seu site

Depois de hospedar, no `index.html` do seu site, troque:

```js
var EXTRACTOR_URL = 'https://hwdahtwlpjlwrmkgimvq.supabase.co/functions/v1/shopee-extractor';
```

por:

```js
var EXTRACTOR_URL = 'https://SEU-SERVIDOR-AQUI/api/extract';
```

E ajuste a forma de chamar (esse extrator usa GET com `?url=`, não
POST com JSON no corpo — vou te ajudar a adaptar o `index.html`
quando você tiver a URL final em mãos).

## Limitações importantes

- Cada busca demora de 5 a 15 segundos (abre uma página de verdade)
- Se a Shopee mudar como a página é estruturada, pode ser necessário
  ajustar o código
- Recomenda-se um servidor com pelo menos 1GB de RAM (o Chrome
  headless consome memória)
