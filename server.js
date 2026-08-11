/**
 * ============================================================
 * CopiarLink - Extrator próprio (automação de navegador)
 * ============================================================
 * O QUE ISSO FAZ:
 * Em vez de tentar adivinhar a API escondida da Shopee, este
 * servidor abre um navegador Chrome de verdade (sem tela,
 * "headless") e visita a página do produto, exatamente como
 * você faria manualmente. Enquanto a página carrega, ele fica
 * "escutando" todas as respostas de rede — igual você fez no
 * F12 — e pega o link do vídeo assim que ele aparece.
 *
 * Isso é só automação do que um navegador comum já faz. Não
 * simula token de app nem contorna proteção nenhuma — é uma
 * página pública, aberta do mesmo jeito que qualquer visitante
 * abriria.
 *
 * ENDPOINT:
 *   GET /api/extract?url=<link do produto da Shopee>
 *
 * RESPOSTA (sucesso):
 *   { "success": true, "video_url": "...", "thumbnail": "...", "title": "..." }
 *
 * RESPOSTA (erro):
 *   { "success": false, "error": "mensagem" }
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const NAV_TIMEOUT_MS = 25000; // tempo máximo esperando a página carregar
const VIDEO_WAIT_MS = 12000;  // tempo extra esperando o vídeo aparecer na rede

const app = express();
app.use(cors());

// Domínios aceitos como link de entrada (o que o usuário cola)
const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /shp\.ee$/i,
];

// Domínios onde o link do VÍDEO deve estar hospedado
const VIDEO_HOST_PATTERN = /susercontent\.com$/i;
const VIDEO_URL_PATTERN = /\.(mp4|m3u8)(\?|$)/i;

function isAllowedInputUrl(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);
    if (!/^https?:$/.test(protocol)) return false;
    return ALLOWED_INPUT_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

// Navegador reaproveitado entre requisições (mais rápido do que abrir
// um Chrome novo a cada busca). Cada requisição usa seu próprio
// "contexto incógnito", isolado das outras.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browserPromise;
}

async function extractVideoFromProductPage(productUrl) {
  const browser = await getBrowser();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  let foundVideoUrl = null;
  let resolveVideoFound;
  const videoFoundPromise = new Promise((resolve) => {
    resolveVideoFound = resolve;
  });

  // Escuta todas as respostas de rede que a própria página gera
  // (o mesmo que aparece na aba Network do F12).
  page.on('response', (response) => {
    if (foundVideoUrl) return;
    const respUrl = response.url();
    if (VIDEO_HOST_PATTERN.test(new URL(respUrl).hostname) && VIDEO_URL_PATTERN.test(respUrl)) {
      foundVideoUrl = respUrl;
      resolveVideoFound();
    }
  });

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 900 });

    // Bloqueia recursos pesados que não precisamos (deixa a busca mais
    // rápida). Não bloqueamos "media"/"xhr"/"fetch" — é exatamente
    // onde o link do vídeo pode aparecer.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'font' || type === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(productUrl, {
      waitUntil: 'networkidle2',
      timeout: NAV_TIMEOUT_MS,
    });

    // Se o vídeo já apareceu durante o carregamento, ótimo. Senão,
    // esperamos mais um pouco (alguns players só carregam o vídeo
    // quando entram na área visível da tela).
    if (!foundVideoUrl) {
      await Promise.race([
        videoFoundPromise,
        new Promise((resolve) => setTimeout(resolve, VIDEO_WAIT_MS)),
      ]);
    }

    // Dados extras da própria página (título, thumbnail) — não
    // dependem de nenhuma chamada escondida, só do HTML renderizado.
    const { title, thumbnail } = await page.evaluate(() => {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      return {
        title: ogTitle || document.title || null,
        thumbnail: ogImage || null,
      };
    });

    return foundVideoUrl
      ? { success: true, video_url: foundVideoUrl, thumbnail, title }
      : { success: false, error: 'Não encontramos vídeo nesse produto (ou ele demorou demais pra carregar).' };
  } catch (err) {
    return { success: false, error: 'Falha ao carregar a página: ' + err.message };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

app.get('/api/extract', async (req, res) => {
  const productUrl = req.query.url;

  if (!productUrl) {
    return res.status(400).json({ success: false, error: 'Parâmetro "url" ausente.' });
  }
  if (!isAllowedInputUrl(productUrl)) {
    return res.status(400).json({ success: false, error: 'Link inválido. Cole um link de produto da Shopee.' });
  }

  try {
    const result = await extractVideoFromProductPage(productUrl);
    const status = result.success ? 200 : 422;
    res.status(status).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Erro interno: ' + err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Extrator rodando em http://localhost:${PORT}`);
});

// Fecha o navegador direitinho quando o servidor for desligado
process.on('SIGTERM', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
