const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;

const NAV_TIMEOUT_MS = 30000;
const VIDEO_WAIT_MS = 20000;

const app = express();

app.use(cors());
app.use(express.json());


// ============================================================
// DOMÍNIOS ACEITOS
// ============================================================

const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /(^|\.)shp\.ee$/i,
];


// ============================================================
// CDN DE VÍDEO
// ============================================================

const VIDEO_HOST_PATTERN =
  /(^|\.)susercontent\.com$/i;


// Aceita:
// .mp4
// .mp4?...
// .m3u8
// .m3u8?...
const VIDEO_URL_PATTERN =
  /\.(mp4|m3u8)(?:\?|$)/i;


// ============================================================
// VALIDA LINK SHOPEE
// ============================================================

function isAllowedInputUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (!/^https?:$/.test(parsed.protocol)) {
      return false;
    }

    return ALLOWED_INPUT_HOSTS.some(regex =>
      regex.test(parsed.hostname)
    );

  } catch {
    return false;
  }
}


// ============================================================
// VALIDA URL DO VÍDEO
// ============================================================

function isVideoUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(value);

    return (
      VIDEO_HOST_PATTERN.test(parsed.hostname) &&
      VIDEO_URL_PATTERN.test(
        parsed.pathname + parsed.search
      )
    );

  } catch {
    return false;
  }
}


// ============================================================
// NAVEGADOR
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
// EXTRAI URL DE QUALQUER <video>
// ============================================================

async function getVideoUrlsFromPage(page) {

  const urls = await page.evaluate(() => {

    const result = [];

    const videos =
      Array.from(
        document.querySelectorAll('video')
      );

    for (const video of videos) {

      const candidates = [

        video.currentSrc,

        video.src,

        video.getAttribute('src'),

        ...Array.from(
          video.querySelectorAll('source')
        ).map(source =>
          source.src ||
          source.getAttribute('src')
        ),

      ];

      for (const url of candidates) {

        if (
          typeof url === 'string' &&
          url.trim()
        ) {

          result.push(url.trim());

        }

      }

    }

    return [...new Set(result)];

  });

  return urls.filter(isVideoUrl);
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


  let foundVideoUrl = null;


  // ==========================================================
  // MONITORA TODAS AS RESPOSTAS
  // ==========================================================

  page.on('response', response => {

    try {

      if (foundVideoUrl) {
        return;
      }

      const responseUrl =
        response.url();

      if (
        isVideoUrl(responseUrl)
      ) {

        foundVideoUrl =
          responseUrl;

        console.log('');
        console.log(
          '[EXTRATOR] VÍDEO ENCONTRADO NA REDE:'
        );
        console.log(foundVideoUrl);
        console.log('');

      }

    } catch (error) {

      console.log(
        '[EXTRATOR] Erro response:',
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
    // ABRE A SHOPEE
    // ========================================================

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      '[EXTRATOR] ABRINDO SHOPEE'
    );
    console.log(
      '=========================================='
    );
    console.log(productUrl);
    console.log('');


    await page.goto(productUrl, {

      waitUntil: 'domcontentloaded',

      timeout: NAV_TIMEOUT_MS,

    });


    // ========================================================
    // ESPERA UM POUCO PARA O JAVASCRIPT DA SHOPEE
    // ========================================================

    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    );


    // ========================================================
    // SCROLL
    //
    // O vídeo pode só ser inicializado quando entra na área
    // visível.
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
    // TENTA MAIS DE UMA VEZ
    // ========================================================

    const startTime =
      Date.now();


    while (
      !foundVideoUrl &&
      Date.now() - startTime < VIDEO_WAIT_MS
    ) {

      // ------------------------------------------------------
      // PROCURA <video>
      // ------------------------------------------------------

      const videoUrls =
        await getVideoUrlsFromPage(page);


      if (videoUrls.length) {

        foundVideoUrl =
          videoUrls[0];

        console.log('');
        console.log(
          '[EXTRATOR] VÍDEO ENCONTRADO NO <video>:'
        );
        console.log(foundVideoUrl);
        console.log('');

        break;

      }


      // ------------------------------------------------------
      // FORÇA OS VÍDEOS A ENTRAREM NO CAMPO DE VISÃO
      // ------------------------------------------------------

      await page.evaluate(() => {

        const videos =
          document.querySelectorAll('video');

        for (const video of videos) {

          try {

            video.scrollIntoView({
              block: 'center',
              behavior: 'instant',
            });

          } catch {}

        }

      }).catch(() => {});


      // ------------------------------------------------------
      // ESPERA
      // ------------------------------------------------------

      await new Promise(resolve =>
        setTimeout(resolve, 1000)
      );

    }


    // ========================================================
    // ÚLTIMA TENTATIVA NO <video>
    // ========================================================

    if (!foundVideoUrl) {

      const videoUrls =
        await getVideoUrlsFromPage(page);

      if (videoUrls.length) {

        foundVideoUrl =
          videoUrls[0];

      }

    }


    // ========================================================
    // TÍTULO
    // ========================================================

    const title =
      await page.evaluate(() => {

        const ogTitle =
          document.querySelector(
            'meta[property="og:title"]'
          )?.content;

        return (
          ogTitle ||
          document.title ||
          'Shopee Video'
        );

      }).catch(() =>
        'Shopee Video'
      );


    // ========================================================
    // THUMBNAIL
    // ========================================================

    const thumbnail =
      await page.evaluate(() => {

        const ogImage =
          document.querySelector(
            'meta[property="og:image"]'
          )?.content;

        return ogImage || null;

      }).catch(() =>
        null
      );


    // ========================================================
    // DIAGNÓSTICO
    // ========================================================

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      'DIAGNÓSTICO'
    );
    console.log(
      '=========================================='
    );

    console.log(
      'VIDEO:',
      foundVideoUrl || 'NÃO ENCONTRADO'
    );

    console.log(
      'TÍTULO:',
      title
    );

    console.log(
      'THUMBNAIL:',
      thumbnail
    );

    console.log(
      '=========================================='
    );
    console.log('');


    // ========================================================
    // NÃO ENCONTROU
    // ========================================================

    if (!foundVideoUrl) {

      return {

        success: false,

        error:
          'O vídeo não foi encontrado no player da Shopee.',

        title,

        thumbnail,

      };

    }


    // ========================================================
    // RESULTADO
    // ========================================================

    return {

      success: true,

      video_url:
        foundVideoUrl,

      /*
       * IMPORTANTE:
       *
       * Não estamos inventando uma "clean_url".
       * Esta URL é exatamente a URL encontrada no
       * elemento <video> ou na requisição do vídeo.
       */
      clean_url:
        foundVideoUrl,

      thumbnail,

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
// API
// ============================================================

app.get(
  '/api/extract',
  async (req, res) => {

    const productUrl =
      req.query.url;


    // --------------------------------------------------------
    // SEM URL
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


      return res
        .status(
          result.success
            ? 200
            : 422
        )
        .json(result);


    } catch (error) {

      console.error(
        '[API] ERRO:',
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
// HEALTH
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
// SERVIDOR
// ============================================================

app.listen(
  PORT,
  () => {

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      ' SHOPEE VIDEO EXTRACTOR'
    );
    console.log(
      '=========================================='
    );
    console.log(
      `Servidor: http://localhost:${PORT}`
    );
    console.log(
      '=========================================='
    );
    console.log('');

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
