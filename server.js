const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;

const NAV_TIMEOUT_MS = 25000;
const VIDEO_WAIT_MS = 12000;

const app = express();

app.use(cors());
app.use(express.json());


// ============================================================
// DOMÍNIOS DE ENTRADA
// ============================================================

const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /shp\.ee$/i,
];


// ============================================================
// DOMÍNIOS DE VÍDEO
// ============================================================

const VIDEO_HOST_PATTERN = /susercontent\.com$/i;

const VIDEO_URL_PATTERN =
  /\.(mp4|m3u8)(\?|$)/i;


// ============================================================
// VALIDA URL
// ============================================================

function isAllowedInputUrl(rawUrl) {
  try {
    const { hostname, protocol } = new URL(rawUrl);

    if (!/^https?:$/.test(protocol)) {
      return false;
    }

    return ALLOWED_INPUT_HOSTS.some((re) =>
      re.test(hostname)
    );

  } catch {
    return false;
  }
}


// ============================================================
// CONVERTE OBJETOS ENCONTRADOS NAS RESPOSTAS
// ============================================================

function inspectObject(obj, result) {

  if (!obj || typeof obj !== 'object') {
    return;
  }


  // clean_url
  if (
    typeof obj.clean_url === 'string' &&
    obj.clean_url.length > 0
  ) {

    result.clean_url = obj.clean_url;

  }


  // video_url
  if (
    typeof obj.video_url === 'string' &&
    obj.video_url.length > 0
  ) {

    result.video_url = obj.video_url;

  }


  // thumbnail
  if (
    typeof obj.thumbnail === 'string' &&
    obj.thumbnail.length > 0
  ) {

    result.thumbnail = obj.thumbnail;

  }


  // title
  if (
    typeof obj.title === 'string' &&
    obj.title.length > 0
  ) {

    result.title = obj.title;

  }


  // download_id
  if (
    obj.download_id !== undefined
  ) {

    result.download_id = obj.download_id;

  }


  // Procura também dentro de objetos aninhados
  for (const value of Object.values(obj)) {

    if (
      value &&
      typeof value === 'object'
    ) {

      inspectObject(value, result);

    }

  }

}


// ============================================================
// TENTA LER JSON DE UMA RESPONSE
// ============================================================

async function inspectResponse(response, result) {

  try {

    const contentType =
      response.headers()['content-type'] || '';

    if (
      !contentType.includes('json') &&
      !contentType.includes('javascript') &&
      !contentType.includes('text')
    ) {

      return;

    }


    const text = await response.text();

    if (!text) {
      return;
    }


    // Limita para não tentar interpretar arquivos gigantes
    if (text.length > 5 * 1024 * 1024) {
      return;
    }


    let data;

    try {

      data = JSON.parse(text);

    } catch {

      return;

    }


    inspectObject(data, result);

  } catch {
    // Algumas responses não podem ser lidas.
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
// EXTRAÇÃO
// ============================================================

async function extractVideoFromProductPage(productUrl) {

  const browser = await getBrowser();

  const context =
    await browser.createBrowserContext();

  const page =
    await context.newPage();


  const result = {

    video_url: null,

    clean_url: null,

    thumbnail: null,

    title: null,

    download_id: null,

  };


  let resolveFound;

  const foundPromise =
    new Promise((resolve) => {

      resolveFound = resolve;

    });


  // ==========================================================
  // OBSERVA TODAS AS RESPONSES
  // ==========================================================

  page.on('response', async (response) => {

    const url = response.url();


    // --------------------------------------------------------
    // 1. Procura JSON que contenha clean_url
    // --------------------------------------------------------

    await inspectResponse(
      response,
      result
    );


    // --------------------------------------------------------
    // 2. Procura diretamente uma URL de vídeo
    // --------------------------------------------------------

    if (!result.video_url) {

      try {

        const parsed =
          new URL(url);

        const isVideoHost =
          VIDEO_HOST_PATTERN.test(
            parsed.hostname
          );

        const isVideo =
          VIDEO_URL_PATTERN.test(url);


        if (
          isVideoHost &&
          isVideo
        ) {

          result.video_url = url;

          console.log('');
          console.log(
            'VÍDEO ENCONTRADO:'
          );
          console.log(url);
          console.log('');

          resolveFound();

        }

      } catch {
        // Ignora URL inválida
      }

    }


    // --------------------------------------------------------
    // 3. Se achou clean_url, já temos a informação principal
    // --------------------------------------------------------

    if (result.clean_url) {

      console.log('');
      console.log(
        'CLEAN_URL ENCONTRADA:'
      );
      console.log(
        result.clean_url
      );
      console.log('');

      resolveFound();

    }

  });


  try {

    // ========================================================
    // CONFIGURA NAVEGADOR
    // ========================================================

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );


    await page.setViewport({
      width: 1280,
      height: 900,
    });


    // ========================================================
    // INTERCEPTAÇÃO
    // ========================================================

    await page.setRequestInterception(true);


    page.on('request', (req) => {

      const type =
        req.resourceType();


      if (
        type === 'font' ||
        type === 'stylesheet'
      ) {

        req.abort();

      } else {

        req.continue();

      }

    });


    // ========================================================
    // ABRE PRODUTO
    // ========================================================

    console.log('');
    console.log(
      'ABRINDO PRODUTO:'
    );
    console.log(productUrl);
    console.log('');


    await page.goto(productUrl, {

      waitUntil: 'networkidle2',

      timeout: NAV_TIMEOUT_MS,

    });


    // ========================================================
    // ESPERA MAIS UM POUCO
    // ========================================================

    await Promise.race([

      foundPromise,

      new Promise((resolve) => {

        setTimeout(
          resolve,
          VIDEO_WAIT_MS
        );

      }),

    ]);


    // ========================================================
    // TÍTULO / THUMBNAIL DO HTML
    // ========================================================

    const pageData =
      await page.evaluate(() => {

        const ogTitle =
          document.querySelector(
            'meta[property="og:title"]'
          )?.content;

        const ogImage =
          document.querySelector(
            'meta[property="og:image"]'
          )?.content;


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


    if (!result.title) {
      result.title =
        pageData.title;
    }


    if (!result.thumbnail) {
      result.thumbnail =
        pageData.thumbnail;
    }


    // ========================================================
    // DIAGNÓSTICO
    // ========================================================

    console.log('');
    console.log(
      '========== DIAGNÓSTICO =========='
    );

    console.log(
      'VIDEO ORIGINAL:',
      result.video_url
    );

    console.log(
      'CLEAN_URL RECEBIDA:',
      result.clean_url
    );


    if (result.video_url) {

      try {

        const parsed =
          new URL(result.video_url);

        console.log(
          'HOST:',
          parsed.hostname
        );

        console.log(
          'PATH:',
          parsed.pathname
        );

        console.log(
          'QUERY:',
          parsed.search
        );

      } catch (err) {

        console.log(
          'Não foi possível analisar a URL:',
          err.message
        );

      }

    }


    console.log(
      '================================='
    );

    console.log('');


    // ========================================================
    // MOSTRA O RESULTADO
    // ========================================================

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      'RESULTADO'
    );
    console.log(
      '=========================================='
    );

    console.log(
      'video_url:',
      result.video_url
    );

    console.log(
      'clean_url:',
      result.clean_url
    );

    console.log(
      'thumbnail:',
      result.thumbnail
    );

    console.log(
      'title:',
      result.title
    );

    console.log(
      '=========================================='
    );
    console.log('');


    // ========================================================
    // RETORNA
    // ========================================================

    if (
      result.video_url ||
      result.clean_url
    ) {

      return {

        success: true,

        video_url:
          result.video_url,

        clean_url:
          result.clean_url,

        download_id:
          result.download_id,

        thumbnail:
          result.thumbnail,

        title:
          result.title,

      };

    }


    return {

      success: false,

      error:
        'Não encontramos o vídeo ou a informação clean_url.',

    };


  } catch (err) {

    console.log(
      'ERRO:',
      err.message
    );


    return {

      success: false,

      error:
        'Falha ao carregar a página: ' +
        err.message,

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
// /api/extract
// ============================================================

app.get(
  '/api/extract',
  async (req, res) => {

    const productUrl =
      req.query.url;


    if (!productUrl) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Parâmetro "url" ausente.',

        });

    }


    if (
      !isAllowedInputUrl(productUrl)
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Link inválido. Cole um link de produto da Shopee.',

        });

    }


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


    } catch (err) {

      return res
        .status(500)
        .json({

          success: false,

          error:
            'Erro interno: ' +
            err.message,

        });

    }

  }
);


// ============================================================
// /info.php
// ============================================================

app.get(
  '/info.php',
  async (req, res) => {

    const productUrl =
      req.query.url;


    if (!productUrl) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Parâmetro "url" ausente.',

        });

    }


    if (
      !isAllowedInputUrl(productUrl)
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            'Link inválido.',

        });

    }


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


    } catch (err) {

      return res
        .status(500)
        .json({

          success: false,

          error:
            err.message,

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
    });

  }
);


// ============================================================
// INICIA
// ============================================================

app.listen(
  PORT,
  () => {

    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      'CopiarLink iniciado'
    );
    console.log(
      '=========================================='
    );
    console.log(
      `http://localhost:${PORT}`
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

process.on(
  'SIGTERM',
  async () => {

    if (browserPromise) {

      const browser =
        await browserPromise;

      await browser.close();

    }

    process.exit(0);

  }
);
