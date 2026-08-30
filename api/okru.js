export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const videoId = req.query.id;

  if (!videoId) {
    return res.status(400).json({ error: "Falta el parámetro 'id'" });
  }

  try {
    const embedUrl = `https://ok.ru/videoembed/${videoId}`;
    const response = await fetch(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://ok.ru/"
      }
    });

    if (!response.ok) {
      throw new Error(`OK.ru respondió con estado HTTP ${response.status}`);
    }

    const html = await response.text();
    const dataOptionsRegex = /data-options="([^"]+)"/i;
    const match = dataOptionsRegex.exec(html);

    if (!match) {
      throw new Error("No se pudo extraer data-options del reproductor de OK.ru");
    }

    const decoded = decodeHtml(match[1]);
    const jsonOpts = JSON.parse(decoded);
    const metadataStr = jsonOpts.flashvars?.metadata || jsonOpts.metadata;
    const metadata = JSON.parse(decodeURIComponent(metadataStr));

    const videos = metadata.videos || [];
    const movie = metadata.movie || {};

    return res.status(200).json({
      title: movie.title || "Video de OK.ru",
      poster: movie.poster || "",
      duration: movie.duration || 0,
      videos: videos,
      hlsManifestUrl: metadata.hlsManifestUrl || null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function decodeHtml(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}
