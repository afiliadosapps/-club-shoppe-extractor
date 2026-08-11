/**
 * ============================================================
 * CopiarLink - Extrator de vídeo Shopee
 * ============================================================
 *
 * Captura URLs de vídeo que a própria página disponibiliza.
 *
 * Se alguma resposta da página fornecer:
 *
 *   {
 *     "video_url": "...mp4",
 *     "clean_url": "...mp4"
 *   }
 *
 * o servidor preserva os dois valores.
 *
 * IMPORTANTE:
 * Não fabricamos clean_url alterando o nome do arquivo.
 * Ela somente será retornada quando vier de uma resposta
 * da própria página/serviço.
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;

const NAV_TIMEOUT_MS = 25000;
const VIDEO_WAIT_MS = 15000;

const app = express();

app.use(cors());
app.use(express.json());


// ============================================================
// DOMÍNIOS DE ENTRADA
// ============================================================

const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /(^|\.)shp\.ee$/i,
];


// ============================================================
// DOMÍNIO DO CDN DE VÍDEO
// ============================================================

const VIDEO_HOST_PATTERN = /susercontent\.com$/i;

const VIDEO_URL_PATTERN =
  /\.(mp4|m3u8)(\?|$)/i;


// ============================================================
// VALIDAÇÃO DO LINK DO PRODUTO
// ============================================================

function isAllowedInputUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (!/^https?:$/.test(parsed.protocol)) {
      return false;
    }

    return ALLOWED_INPUT_HOSTS.some((regex) =>
      regex.test(parsed.hostname)
    );

  } catch {
    return false;
  }
}


// ============================================================
// VERIFICA URL DE VÍDEO
// ============================================================

function isVideoUrl(value) {

  if (typeof value !== 'string') {
    return false;
  }

  try {

    const parsed = new URL(value);

    return (
      VIDEO_HOST_PATTERN.test(parsed.hostname) &&
      VIDEO_URL_PATTERN.test(parsed.href)
    );

  } catch {

    return false;

  }
}


// ============================================================
// NAVEGADOR REUTILIZÁVEL
// ============================================================

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


// ============================================================
// EXTRAI video_url + clean_url DE QUALQUER JSON
// ============================================================

function findVideoData(value, result = {}) {

  if (value === null || value === undefined) {
    return result;
  }


  // ----------------------------------------------------------
  // STRING
  // ----------------------------------------------------------

  if (typeof value === 'string') {

    if (
      !result.video_url &&
      isVideoUrl(value)
    ) {

      result.video_url = value;

    }

    return result;
  }


  // ----------------------------------------------------------
  // ARRAY
  // ----------------------------------------------------------

  if (Array.isArray(value)) {

    for (const item of value) {

      findVideoData(item, result);

      if (
        result.video_url &&
        result.clean_url
      ) {
        break;
      }

    }

    return result;
  }


  // ----------------------------------------------------------
  // OBJETO
  // ----------------------------------------------------------

  if (typeof value === 'object') {

    // video_url
    if (
      typeof value.video_url === 'string' &&
      isVideoUrl(value.video_url)
    ) {

      result.video_url = value.video_url;

    }


    // clean_url
    //
    // IMPORTANTE:
    // Só usamos se ela realmente existir na resposta.
    //
    if (
      typeof value.clean_url === 'string' &&
      isVideoUrl(value.clean_url)
    ) {

      result.clean_url = value.clean_url;

    }


    // Procura em outras propriedades.
    for (const key of Object.keys(value)) {

      if (
        key === 'video_url' ||
        key === 'clean_url'
      ) {
        continue;
      }

      findVideoData(value[key], result);

      if (
        result.video_url &&
        result.clean_url
      ) {
        break;
      }

    }

  }

  return result;
}


// ============================================================
// TENTA INTERPRETAR TEXTO COMO JSON
// ============================================================

function parseJsonSafely(text) {

  if (
    typeof text !== 'string' ||
    !text.trim()
  ) {
    return null;
  }

  try {

    return JSON.parse(text);

  } catch {

    return null;

  }
}


// ============================================================
// EXTRATOR PRINCIPAL
// ============================================================

async function extractVideoFromProductPage(productUrl) {

  const browser = await getBrowser();

  const context =
    await browser.createBrowserContext();

  const page =
    await context.newPage();


  // ----------------------------------------------------------
  // RESULTADOS
  // ----------------------------------------------------------

  let foundVideoUrl = null;
  let foundCleanUrl = null;


  // Evita processar a mesma resposta várias vezes.
  const processedResponses = new WeakSet();


  let resolveVideoFound;

  const videoFoundPromise =
    new Promise((resolve) => {

      resolveVideoFound = resolve;

    });


  // ==========================================================
  // ESCUTA TODAS AS RESPOSTAS
  // ==========================================================

  page.on('response', async (response) => {

    try {

      if (
        foundVideoUrl &&
        foundCleanUrl
      ) {
        return;
      }


      const responseUrl =
        response.url();


      let parsedUrl;

      try {

        parsedUrl =
          new URL(responseUrl);

      } catch {

        return;

      }


      // ------------------------------------------------------
      // HEADERS
      // ------------------------------------------------------

      const headers =
        response.headers() || {};

      const contentType =
        String(
          headers['content-type'] || ''
        ).toLowerCase();


      // ------------------------------------------------------
      // IDENTIFICA info.php
      // ------------------------------------------------------

      const isInfoPhp =
        /\/info\.php(?:\?|$)/i.test(
          parsedUrl.pathname +
          parsedUrl.search
        );


      // ------------------------------------------------------
      // IDENTIFICA JSON
      // ------------------------------------------------------

      const looksLikeJson =
        contentType.includes(
          'application/json'
        ) ||
        contentType.includes(
          'text/json'
        ) ||
        isInfoPhp;


      // ------------------------------------------------------
      // TENTA LER RESPOSTA JSON
      //
      // O ponto importante aqui é:
      //
      // mesmo que info.php retorne JSON com um Content-Type
      // estranho, nós ainda tentamos interpretar o conteúdo.
      // ------------------------------------------------------

      if (looksLikeJson) {

        try {

          if (
            processedResponses.has(response)
          ) {
            return;
          }

          processedResponses.add(response);


          const text =
            await response.text();


          if (!text) {
            return;
          }


          const json =
            parseJsonSafely(text);


          if (!json) {
            return;
          }


          const found =
            findVideoData(json);


          // --------------------------------------------------
          // VIDEO URL
          // --------------------------------------------------

          if (
            found.video_url &&
            !foundVideoUrl
          ) {

            foundVideoUrl =
              found.video_url;

            console.log(
              '[EXTRATOR] video_url encontrada'
            );

          }


          // --------------------------------------------------
          // CLEAN URL
          // --------------------------------------------------

          if (
            found.clean_url &&
            !foundCleanUrl
          ) {

            foundCleanUrl =
              found.clean_url;

            console.log(
              '[EXTRATOR] clean_url encontrada'
            );

          }


          if (foundVideoUrl) {

            resolveVideoFound();

          }

        } catch (error) {

          console.log(
            '[EXTRATOR] Não foi possível ler resposta JSON:',
            error.message
          );

        }

      }


      // ------------------------------------------------------
      // FALLBACK:
      // resposta direta de MP4/M3U8
      // ------------------------------------------------------

      if (!foundVideoUrl) {

        if (
          VIDEO_HOST_PATTERN.test(
            parsedUrl.hostname
          ) &&
          VIDEO_URL_PATTERN.test(
            responseUrl
          )
        ) {

          foundVideoUrl =
            responseUrl;


          console.log(
            '[EXTRATOR] Vídeo encontrado diretamente:',
            foundVideoUrl
          );


          resolveVideoFound();

        }

      }

    } catch (error) {

      console.log(
        '[EXTRATOR] Erro processando response:',
        error.message
      );

    }

  });


  try {

    // ========================================================
    // USER AGENT
    // ========================================================

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/151.0.0.0 Safari/537.36'
    );


    // ========================================================
    // VIEWPORT
    // ========================================================

    await page.setViewport({
      width: 1280,
      height: 900,
    });


    // ========================================================
    // NÃO BLOQUEAMOS CSS/FONTES
    //
    // Isso é proposital.
    // Algumas páginas dependem do carregamento normal para
    // disparar as requisições do player.
    // ========================================================

    await page.setRequestInterception(true);

    page.on('request', (request) => {

      try {

        request.continue();

      } catch {}

    });


    // ========================================================
    // ABRE O PRODUTO
    // ========================================================

    console.log('');
    console.log(
      '[EXTRATOR] Abrindo produto:'
    );

    console.log(productUrl);

    console.log('');


    await page.goto(productUrl, {

      waitUntil: 'networkidle2',

      timeout: NAV_TIMEOUT_MS,

    });


    // ========================================================
    // PEQUENO SCROLL
    //
    // Alguns players só iniciam quando entram na área visível.
    // ========================================================

    await page.evaluate(() => {

      window.scrollTo({
        top: Math.max(
          document.body.scrollHeight * 0.35,
          300
        ),
        behavior: 'instant',
      });

    }).catch(() => {});


    // ========================================================
    // ESPERA AS RESPOSTAS
    // ========================================================

    if (
      !foundVideoUrl ||
      !foundCleanUrl
    ) {

      await Promise.race([

        videoFoundPromise,

        new Promise((resolve) => {

          setTimeout(
            resolve,
            VIDEO_WAIT_MS
          );

        }),

      ]);

    }


    // ========================================================
    // SEGUNDA ESPERA PARA clean_url
    //
    // Se video_url apareceu primeiro, damos mais alguns
    // segundos para o JSON complementar aparecer.
    // ========================================================

    if (
      foundVideoUrl &&
      !foundCleanUrl
    ) {

      await new Promise((resolve) => {

        setTimeout(
          resolve,
          3000
        );

      });

    }


    // ========================================================
    // PROCURA <VIDEO> NA PÁGINA
    // ========================================================

    if (!foundVideoUrl) {

      const pageVideoUrl =
        await page.evaluate(() => {

          const video =
            document.querySelector(
              'video'
            );

          if (!video) {
            return null;
          }

          return (
            video.currentSrc ||
            video.src ||
            video.querySelector(
              'source'
            )?.src ||
            null
          );

        });


      if (
        pageVideoUrl &&
        isVideoUrl(pageVideoUrl)
      ) {

        foundVideoUrl =
          pageVideoUrl;


        console.log(
          '[EXTRATOR] Vídeo encontrado no elemento video.'
        );

      }

    }


    // ========================================================
    // TÍTULO + THUMBNAIL
    // ========================================================

    const {
      title,
      thumbnail,
    } = await page.evaluate(() => {

      const ogTitle =
        document.querySelector(
          'meta[property="og:title"]'
        )?.content || null;


      const ogImage =
        document.querySelector(
          'meta[property="og:image"]'
        )?.content || null;


      return {

        title:
          ogTitle ||
          document.title ||
          null,

        thumbnail:
          ogImage ||
          null,

      };

    });


    // ========================================================
    // DIAGNÓSTICO
    // ========================================================

    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      '        DIAGNÓSTICO DO EXTRATOR'
    );

    console.log(
      '=============================================='
    );

    console.log(
      'PRODUTO:',
      productUrl
    );

    console.log('');

    console.log(
      'VIDEO ORIGINAL:',
      foundVideoUrl
    );

    console.log('');

    console.log(
      'CLEAN URL:',
      foundCleanUrl
    );

    console.log('');

    console.log(
      'ENCONTROU VIDEO:',
      Boolean(foundVideoUrl)
    );

    console.log(
      'ENCONTROU CLEAN:',
      Boolean(foundCleanUrl)
    );

    console.log(
      'ENCONTROU AS DUAS:',
      Boolean(
        foundVideoUrl &&
        foundCleanUrl
      )
    );

    console.log(
      '=============================================='
    );

    console.log('');


    // ========================================================
    // SEM VÍDEO
    // ========================================================

    if (!foundVideoUrl) {

      return {

        success: false,

        error:
          'Não encontramos vídeo nesse produto ' +
          '(ou ele demorou demais para carregar).',

      };

    }


    // ========================================================
    // RESPOSTA
    // ========================================================

    return {

      success: true,

      video_url:
        foundVideoUrl,

      clean_url:
        foundCleanUrl || null,

      thumbnail:
        thumbnail,

      title:
        title,

    };


  } catch (error) {

    console.error(
      '[EXTRATOR] ERRO:',
      error
    );


    return {

      success: false,

      error:
        'Falha ao carregar a página: ' +
        error.message,

    };


  } finally {

    await page
      .close()
      .catch(() => {});


    await context
      .close()
      .catch(() => {});

  }

}


// ============================================================
// ENDPOINT /api/extract
// ============================================================

app.get(
  '/api/extract',
  async (req, res) => {

    const productUrl =
      req.query.url;


    // --------------------------------------------------------
    // URL AUSENTE
    // --------------------------------------------------------

    if (!productUrl) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Parâmetro "url" ausente.',

        });

    }


    // --------------------------------------------------------
    // URL INVÁLIDA
    // --------------------------------------------------------

    if (
      !isAllowedInputUrl(
        productUrl
      )
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Link inválido. Cole um link de produto da Shopee.',

        });

    }


    // --------------------------------------------------------
    // EXTRAÇÃO
    // --------------------------------------------------------

    try {

      const result =
        await extractVideoFromProductPage(
          productUrl
        );


      const status =
        result.success
          ? 200
          : 422;


      return res
        .status(status)
        .json(result);


    } catch (error) {

      console.error(
        '[API] ERRO INTERNO:',
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          error:
            'Erro interno: ' +
            error.message,

        });

    }

  }
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/health',
  (_req, res) => {

    res.json({

      ok: true,

      service:
        'shopee-video-extractor',

    });

  }
);


// ============================================================
// INICIA SERVIDOR
// ============================================================

app.listen(
  PORT,
  () => {

    console.log('');
    console.log(
      '=============================================='
    );

    console.log(
      '   COPIARLINK - EXTRATOR SHOPEE'
    );

    console.log(
      '=============================================='
    );

    console.log(
      `Servidor rodando na porta ${PORT}`
    );

    console.log(
      '=============================================='
    );

  }
);


// ============================================================
// ENCERRAMENTO
// ============================================================

async function shutdown() {

  try {

    if (browserPromise) {

      const browser =
        await browserPromise;

      await browser.close();

    }

  } catch {}

  process.exit(0);

}


process.on(
  'SIGTERM',
  shutdown
);

process.on(
  'SIGINT',
  shutdown
);
