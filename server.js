/**
 * ============================================================
 * CopiarLink - Extrator de vídeo Shopee
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;

const NAV_TIMEOUT_MS = 25000;
const VIDEO_WAIT_MS = 12000;

const app = express();
app.use(cors());

const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /shp\.ee$/i,
];

const VIDEO_HOST_PATTERN = /susercontent\.com$/i;
const VIDEO_URL_PATTERN = /\.(mp4|m3u8)(\?|$)/i;

// ------------------------------------------------------------
// Validação do link recebido
// ------------------------------------------------------------

function isAllowedInputUrl(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);

    if (!/^https?:$/.test(protocol)) {
      return false;
    }

    return ALLOWED_INPUT_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Navegador
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Verifica se é uma URL de vídeo
// ------------------------------------------------------------

function isVideoUrl(value) {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value);

    return (
      VIDEO_HOST_PATTERN.test(url.hostname) &&
      VIDEO_URL_PATTERN.test(url.href)
    );
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Procura video_url + clean_url dentro de qualquer JSON
// ------------------------------------------------------------

function findVideoData(value, result = {}) {
  if (!value) return result;

  if (typeof value === 'string') {
    if (!result.video_url && isVideoUrl(value)) {
      result.video_url = value;
    }

    return result;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findVideoData(item, result);

      if (result.video_url && result.clean_url) {
        break;
      }
    }

    return result;
  }

  if (typeof value === 'object') {
    // Primeiro tenta encontrar os campos diretamente.
    if (
      typeof value.video_url === 'string' &&
      isVideoUrl(value.video_url)
    ) {
      result.video_url = value.video_url;
    }

    // IMPORTANTE:
    // Só aceitamos clean_url se ela realmente vier na resposta.
    if (
      typeof value.clean_url === 'string' &&
      isVideoUrl(value.clean_url)
    ) {
      result.clean_url = value.clean_url;
    }

    // Alguns retornos podem usar outras estruturas.
    for (const key of Object.keys(value)) {
      if (key === 'video_url' || key === 'clean_url') {
        continue;
      }

      findVideoData(value[key], result);

      if (result.video_url && result.clean_url) {
        break;
      }
    }
  }

  return result;
}

// ------------------------------------------------------------
// Extrator principal
// ------------------------------------------------------------

async function extractVideoFromProductPage(productUrl) {
  const browser = await getBrowser();

  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  let foundVideoUrl = null;
  let foundCleanUrl = null;

  let resolveVideoFound;

  const videoFoundPromise = new Promise((resolve) => {
    resolveVideoFound = resolve;
  });

  // ----------------------------------------------------------
  // Escuta respostas da página
  // ----------------------------------------------------------

  page.on('response', async (response) => {
    try {
      if (foundVideoUrl && foundCleanUrl) {
        return;
      }

      const responseUrl = response.url();

      let parsedUrl;

      try {
        parsedUrl = new URL(responseUrl);
      } catch {
        return;
      }

      const contentType =
        response.headers()['content-type'] || '';

      // --------------------------------------------------------
      // 1. Primeiro tenta capturar respostas JSON.
      //
      // É aqui que esperamos encontrar algo parecido com:
      //
      // {
      //   "video_url": "...mp4",
      //   "clean_url": "...mp4"
      // }
      // --------------------------------------------------------

      if (
        contentType.includes('application/json') ||
        contentType.includes('text/json')
      ) {
        try {
          const text = await response.text();

          if (text) {
            const json = JSON.parse(text);

            const found = findVideoData(json);

            if (found.video_url) {
              foundVideoUrl = found.video_url;
            }

            if (found.clean_url) {
              foundCleanUrl = found.clean_url;
            }

            if (foundVideoUrl) {
              resolveVideoFound();
            }
          }
        } catch {
          // Nem toda resposta JSON pode ser lida/parseada.
        }
      }

      // --------------------------------------------------------
      // 2. Fallback:
      // se não acharmos JSON, pegamos diretamente a resposta
      // .mp4/.m3u8 do CDN.
      // --------------------------------------------------------

      if (!foundVideoUrl) {
        if (
          VIDEO_HOST_PATTERN.test(parsedUrl.hostname) &&
          VIDEO_URL_PATTERN.test(responseUrl)
        ) {
          foundVideoUrl = responseUrl;
          resolveVideoFound();
        }
      }
    } catch {
      // Ignora respostas individuais que falharem.
    }
  });

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );

    await page.setViewport({
      width: 1280,
      height: 900,
    });

    // ----------------------------------------------------------
    // Interceptação de recursos
    // ----------------------------------------------------------

    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const type = req.resourceType();

      if (type === 'font' || type === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ----------------------------------------------------------
    // Abre produto
    // ----------------------------------------------------------

    await page.goto(productUrl, {
      waitUntil: 'networkidle2',
      timeout: NAV_TIMEOUT_MS,
    });

    // ----------------------------------------------------------
    // Aguarda o vídeo/JSON aparecer
    // ----------------------------------------------------------

    if (!foundVideoUrl || !foundCleanUrl) {
      await Promise.race([
        videoFoundPromise,

        new Promise((resolve) => {
          setTimeout(resolve, VIDEO_WAIT_MS);
        }),
      ]);
    }

    // ----------------------------------------------------------
    // Segunda chance:
    // procura elementos <video> da página
    // ----------------------------------------------------------

    if (!foundVideoUrl) {
      const pageVideoUrl = await page.evaluate(() => {
        const video = document.querySelector('video');

        if (!video) return null;

        return (
          video.currentSrc ||
          video.src ||
          video.querySelector('source')?.src ||
          null
        );
      });

      if (pageVideoUrl && isVideoUrl(pageVideoUrl)) {
        foundVideoUrl = pageVideoUrl;
      }
    }

    // ----------------------------------------------------------
    // Título e thumbnail
    // ----------------------------------------------------------

    const { title, thumbnail } = await page.evaluate(() => {
      const ogTitle =
        document.querySelector(
          'meta[property="og:title"]'
        )?.content;

      const ogImage =
        document.querySelector(
          'meta[property="og:image"]'
        )?.content;

      return {
        title: ogTitle || document.title || null,
        thumbnail: ogImage || null,
      };
    });

    // ----------------------------------------------------------
    // Diagnóstico no servidor
    // ----------------------------------------------------------

    console.log('');
    console.log('==============================================');
    console.log('           DIAGNÓSTICO DO EXTRATOR');
    console.log('==============================================');
    console.log('PRODUTO:', productUrl);
    console.log('');
    console.log('VIDEO ORIGINAL:', foundVideoUrl);
    console.log('CLEAN URL:', foundCleanUrl);
    console.log(
      'ENCONTROU AS DUAS:',
      Boolean(foundVideoUrl && foundCleanUrl)
    );
    console.log('==============================================');
    console.log('');

    // ----------------------------------------------------------
    // Resultado
    // ----------------------------------------------------------

    if (!foundVideoUrl) {
      return {
        success: false,
        error:
          'Não encontramos vídeo nesse produto (ou ele demorou demais para carregar).',
      };
    }

    return {
      success: true,

      // URL encontrada originalmente
      video_url: foundVideoUrl,

      // Só será preenchida se realmente tiver sido encontrada
      // em uma resposta da página.
      clean_url: foundCleanUrl || null,

      thumbnail,
      title,
    };
  } catch (err) {
    console.error('ERRO NO EXTRATOR:', err);

    return {
      success: false,
      error:
        'Falha ao carregar a página: ' + err.message,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ------------------------------------------------------------
// API
// ------------------------------------------------------------

app.get('/api/extract', async (req, res) => {
  const productUrl = req.query.url;

  if (!productUrl) {
    return res.status(400).json({
      success: false,
      error: 'Parâmetro "url" ausente.',
    });
  }

  if (!isAllowedInputUrl(productUrl)) {
    return res.status(400).json({
      success: false,
      error:
        'Link inválido. Cole um link de produto da Shopee.',
    });
  }

  try {
    const result =
      await extractVideoFromProductPage(productUrl);

    const status = result.success ? 200 : 422;

    return res.status(status).json(result);
  } catch (err) {
    console.error('ERRO INTERNO:', err);

    return res.status(500).json({
      success: false,
      error: 'Erro interno: ' + err.message,
    });
  }
});

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
  });
});

// ------------------------------------------------------------
// Inicialização
// ------------------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Extrator rodando na porta ${PORT}`
  );
});

// ------------------------------------------------------------
// Encerramento
// ------------------------------------------------------------

process.on('SIGTERM', async () => {
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  } catch {}

  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    if (browserPromise) {
      const browser = await browserPromise;
      await browser.close();
    }
  } catch {}

  process.exit(0);
});
