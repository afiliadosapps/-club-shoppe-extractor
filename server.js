/**
 * ============================================================
 * CopiarLink - Extrator próprio (automação de navegador)
 * ============================================================
 *
 * Abre uma página pública da Shopee usando Puppeteer e observa
 * as respostas de rede geradas pelo navegador para encontrar
 * uma URL de vídeo.
 *
 * ENDPOINT:
 *   GET /api/extract?url=<link do produto da Shopee>
 *
 * RESPOSTA:
 *   {
 *     "success": true,
 *     "video_url": "...",
 *     "thumbnail": "...",
 *     "title": "..."
 *   }
 *
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


// ============================================================
// DOMÍNIOS ACEITOS COMO LINK DE ENTRADA
// ============================================================

const ALLOWED_INPUT_HOSTS = [
  /(^|\.)shopee\.[a-z.]+$/i,
  /(^|\.)sv\.shopee\.[a-z.]+$/i,
  /shp\.ee$/i,
];


// ============================================================
// DOMÍNIO DO VÍDEO
// ============================================================

const VIDEO_HOST_PATTERN = /susercontent\.com$/i;


// ============================================================
// FORMATOS DE VÍDEO
// ============================================================

const VIDEO_URL_PATTERN = /\.(mp4|m3u8)(\?|$)/i;


// ============================================================
// VALIDA O LINK DA SHOPEE
// ============================================================

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


// ============================================================
// NAVEGADOR REUTILIZADO
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
// EXTRAI O VÍDEO
// ============================================================

async function extractVideoFromProductPage(productUrl) {

  const browser = await getBrowser();

  const context = await browser.createBrowserContext();

  const page = await context.newPage();

  let foundVideoUrl = null;

  let resolveVideoFound;

  const videoFoundPromise = new Promise((resolve) => {
    resolveVideoFound = resolve;
  });


  // ==========================================================
  // ESCUTA AS RESPOSTAS DA REDE
  // ==========================================================

  page.on('response', (response) => {

    if (foundVideoUrl) {
      return;
    }

    const respUrl = response.url();

    try {

      const parsedUrl = new URL(respUrl);

      const isVideoHost =
        VIDEO_HOST_PATTERN.test(parsedUrl.hostname);

      const isVideoFile =
        VIDEO_URL_PATTERN.test(respUrl);


      if (isVideoHost && isVideoFile) {

        foundVideoUrl = respUrl;

        console.log('');
        console.log('==========================================');
        console.log('VÍDEO ENCONTRADO');
        console.log('==========================================');
        console.log(foundVideoUrl);
        console.log('==========================================');
        console.log('');

        resolveVideoFound();
      }

    } catch {
      // Ignora URLs inválidas
    }

  });


  try {

    // ========================================================
    // CONFIGURA O NAVEGADOR
    // ========================================================

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );


    await page.setViewport({
      width: 1280,
      height: 900,
    });


    // ========================================================
    // INTERCEPTAÇÃO DE REQUISIÇÕES
    // ========================================================

    await page.setRequestInterception(true);

    page.on('request', (req) => {

      const type = req.resourceType();

      // Bloqueia somente recursos pesados que não precisamos.
      // Mantemos media, xhr e fetch funcionando.

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
    // ABRE A PÁGINA
    // ========================================================

    console.log('');
    console.log('==========================================');
    console.log('ABRINDO PRODUTO');
    console.log('==========================================');
    console.log(productUrl);
    console.log('==========================================');
    console.log('');


    await page.goto(productUrl, {

      waitUntil: 'networkidle2',

      timeout: NAV_TIMEOUT_MS,

    });


    // ========================================================
    // ESPERA O VÍDEO
    // ========================================================

    if (!foundVideoUrl) {

      console.log('Vídeo ainda não encontrado.');
      console.log('Aguardando mais alguns segundos...');


      await Promise.race([

        videoFoundPromise,

        new Promise((resolve) => {
          setTimeout(resolve, VIDEO_WAIT_MS);
        }),

      ]);

    }


    // ========================================================
    // PEGA TÍTULO E THUMBNAIL
    // ========================================================

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
    // SE ENCONTROU O VÍDEO
    // ========================================================

    if (foundVideoUrl) {

      console.log('');
      console.log('==========================================');
      console.log('RESULTADO FINAL');
      console.log('==========================================');

      console.log('VIDEO ORIGINAL:');
      console.log(foundVideoUrl);

      console.log('');

      console.log('A URL retornada é exatamente a URL');
      console.log('que o navegador encontrou na rede.');

      console.log('==========================================');
      console.log('');


      return {

        success: true,

        video_url: foundVideoUrl,

        thumbnail,

        title,

      };

    }


    // ========================================================
    // NÃO ENCONTROU
    // ========================================================

    console.log('');
    console.log('==========================================');
    console.log('NENHUM VÍDEO ENCONTRADO');
    console.log('==========================================');
    console.log('');


    return {

      success: false,

      error:
        'Não encontramos vídeo nesse produto (ou ele demorou demais para carregar).',

    };


  } catch (err) {

    console.log('');
    console.log('==========================================');
    console.log('ERRO');
    console.log('==========================================');
    console.log(err.message);
    console.log('==========================================');
    console.log('');


    return {

      success: false,

      error:
        'Falha ao carregar a página: ' +
        err.message,

    };


  } finally {

    // ========================================================
    // FECHA A PÁGINA
    // ========================================================

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

app.get('/api/extract', async (req, res) => {

  const productUrl = req.query.url;


  // ==========================================================
  // LINK NÃO INFORMADO
  // ==========================================================

  if (!productUrl) {

    return res
      .status(400)
      .json({

        success: false,

        error:
          'Parâmetro "url" ausente.',

      });

  }


  // ==========================================================
  // LINK INVÁLIDO
  // ==========================================================

  if (!isAllowedInputUrl(productUrl)) {

    return res
      .status(400)
      .json({

        success: false,

        error:
          'Link inválido. Cole um link de produto da Shopee.',

      });

  }


  // ==========================================================
  // EXECUTA EXTRAÇÃO
  // ==========================================================

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

});


// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (_req, res) => {

  res.json({
    ok: true,
  });

});


// ============================================================
// INICIA SERVIDOR
// ============================================================

app.listen(PORT, () => {

  console.log('');
  console.log('==========================================');
  console.log('CopiarLink iniciado');
  console.log('==========================================');
  console.log(
    `Servidor rodando na porta ${PORT}`
  );
  console.log('==========================================');
  console.log('');

});


// ============================================================
// FECHA O NAVEGADOR QUANDO O SERVIDOR ENCERRAR
// ============================================================

process.on('SIGTERM', async () => {

  if (browserPromise) {

    const browser =
      await browserPromise;

    await browser.close();

  }

  process.exit(0);

});
