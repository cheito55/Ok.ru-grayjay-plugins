// ============================================================================
// Plugin no oficial de OK.ru para GrayJay
//
// IMPORTANTE (leer antes de usar):
// - Esto es un punto de partida funcional, escrito siguiendo la convención de
//   plugins de GrayJay (misma familia de clases que usan los plugins de
//   Dailymotion, Rutube, PeerTube, etc. de la comunidad).
// - NO pude probarlo en vivo contra ok.ru (mi entorno no tiene acceso a
//   internet), así que los nombres exactos de algunos campos del JSON interno
//   de ok.ru pueden haber cambiado. Están marcados con "// VERIFICAR" abajo.
// - Para depurarlo: usá el DevServer de GrayJay (Settings > Developer Settings
//   > Start Server), cargá este script en la pestaña "Testing" y mirá qué
//   devuelve getContentDetails() para una URL real de ok.ru. Si algo rompe,
//   es casi seguro que hay que ajustar el parsing de "flashvars.metadata"
//   (ver función parseOkRuMetadata).
// ============================================================================

const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|live)\/(\d+)/i;
const REGEX_DATA_OPTIONS = /id="hook_Block_VideoPlayer"[^>]*data-options="([^"]+)"/i;
const REGEX_DATA_OPTIONS_FALLBACK = /data-module="OKVideo\.Player"[^>]*data-options="([^"]+)"/i;

var _settings = {};

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

source.enable = function (conf, settings, savedState) {
	_settings = settings ?? {};
	log("[OK.ru] plugin habilitado");
};

source.disable = function () {
	log("[OK.ru] plugin deshabilitado");
};

// ---------------------------------------------------------------------------
// Home (feed inicial) — ok.ru no tiene un "home" público sin login útil,
// así que lo dejamos vacío. Si querés, se puede rellenar con una categoría
// fija (por ejemplo "populares") más adelante.
// ---------------------------------------------------------------------------

source.getHome = function () {
	return new OkRuVideoPager([], false);
};

// ---------------------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------------------

source.getSearchCapabilities = function () {
	return {
		types: [Type.Feed.Mixed],
		sorts: [Type.Order.Chronological],
		filters: []
	};
};

source.searchSuggestions = function (query) {
	return [];
};

source.search = function (query, type, order, filters) {
	// VERIFICAR: el endpoint de búsqueda web de ok.ru puede requerir cookies
	// de sesión o un token anti-bot. Si esto falla, la alternativa es scrapear
	// https://ok.ru/web-search/?st.query=...&st.type=VIDEO directamente y
	// parsear el HTML en vez de pedir JSON.
	const url = `${BASE_URL}/web-api/search/video?st.query=${encodeURIComponent(query)}&st.mode=SEARCH&page=1`;

	const resp = http.GET(url, { "Accept": "application/json" }, false);
	if (!resp.isOk) {
		throw new ScriptException(`Búsqueda falló (HTTP ${resp.code}) para "${query}"`);
	}

	let data;
	try {
		data = JSON.parse(resp.body);
	} catch (e) {
		throw new ScriptException("No se pudo parsear la respuesta de búsqueda de OK.ru: " + e);
	}

	const items = (data.videos || data.items || []).map(mapSearchResultToPlatformVideo);
	return new OkRuVideoPager(items, false);
};

// ---------------------------------------------------------------------------
// Detección y detalle de contenido
// ---------------------------------------------------------------------------

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};

source.getContentDetails = function (url) {
	const match = REGEX_VIDEO_URL.exec(url);
	if (!match) {
		throw new ScriptException("URL de video de OK.ru no reconocida: " + url);
	}
	const videoId = match[1];

	const resp = http.GET(url, {
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
	}, false);
	if (!resp.isOk) {
		throw new ScriptException(`No se pudo cargar la página del video (HTTP ${resp.code})`);
	}

	const metadata = parseOkRuMetadata(resp.body);
	if (!metadata) {
		throw new ScriptException("No se encontró el bloque de metadata del reproductor en la página de OK.ru. Es probable que ok.ru haya cambiado el HTML; revisar REGEX_DATA_OPTIONS.");
	}

	const movie = metadata.movie || {};
	const author = metadata.author || {};

	const title = movie.title || "Video de OK.ru";
	const thumbnailUrl = movie.poster || "";
	const duration = Math.round(movie.duration || 0);
	const isLive = movie.type === "LIVE" || !!metadata.isLive;

	const videoSources = buildVideoSources(metadata);
	if (videoSources.length === 0) {
		throw new ScriptException("No se encontraron URLs de video reproducibles para este contenido (puede estar geobloqueado o requerir login).");
	}

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: title,
		thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, String(author.id || ""), plugin.config.id),
			author.name || "OK.ru",
			author.url || BASE_URL,
			author.pic || ""
		),
		datetime: 0,
		duration: duration,
		viewCount: movie.viewsCount || movie.totalCount || 0,
		url: url,
		shareUrl: url,
		isLive: isLive,
		video: new VideoSourceDescriptor(videoSources)
	});
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Extrae y parsea el JSON de metadata que ok.ru embebe en el HTML del player.
// Técnica: buscar el atributo data-options del div del reproductor, decodificar
// entidades HTML, parsear como JSON, y dentro de flashvars.metadata hay OTRO
// JSON (string, URL-encoded) con la data real de video/audio.
function parseOkRuMetadata(html) {
	let optionsMatch = REGEX_DATA_OPTIONS.exec(html) || REGEX_DATA_OPTIONS_FALLBACK.exec(html);
	if (!optionsMatch) {
		return null;
	}

	const decodedOptions = htmlDecode(optionsMatch[1]);

	let options;
	try {
		options = JSON.parse(decodedOptions);
	} catch (e) {
		return null;
	}

	const flashvars = options.flashvars || options;
	if (!flashvars || !flashvars.metadata) {
		return null;
	}

	let metadataStr = flashvars.metadata;
	try {
		metadataStr = decodeURIComponent(metadataStr);
	} catch (e) {
		// puede que ya venga sin encodear
	}

	try {
		return JSON.parse(metadataStr);
	} catch (e) {
		return null;
	}
}

// A partir del objeto metadata de ok.ru, arma las fuentes reproducibles
// (mp4 progresivo por calidad + HLS si está disponible).
function buildVideoSources(metadata) {
	const sources = [];

	// VERIFICAR: el array de calidades progresivas suele venir en
	// metadata.videos = [{ name: "mobile"|"lowest"|"low"|"sd"|"hd"|"full"|"quad", url: "..." }, ...]
	(metadata.videos || []).forEach(v => {
		if (!v.url) return;
		const dims = qualityNameToDims(v.name);
		sources.push(new VideoUrlSource({
			name: v.name || "mp4",
			url: v.url,
			width: dims.width,
			height: dims.height,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: Math.round(metadata.movie?.duration || 0)
		}));
	});

	// VERIFICAR: el manifest HLS suele venir en metadata.hlsManifestUrl
	if (metadata.hlsManifestUrl) {
		sources.push(new HLSSource({
			name: "HLS",
			url: metadata.hlsManifestUrl,
			duration: Math.round(metadata.movie?.duration || 0),
			priority: true
		}));
	}

	return sources;
}

function qualityNameToDims(name) {
	switch (name) {
		case "mobile": return { width: 320, height: 240 };
		case "lowest": return { width: 426, height: 240 };
		case "low": return { width: 640, height: 360 };
		case "sd": return { width: 854, height: 480 };
		case "hd": return { width: 1280, height: 720 };
		case "full": return { width: 1920, height: 1080 };
		case "quad": return { width: 2560, height: 1440 };
		default: return { width: 0, height: 0 };
	}
}

function mapSearchResultToPlatformVideo(item) {
	// VERIFICAR: la forma exacta del item de búsqueda (nombres de campos) hay
	// que confirmarla contra la respuesta real del endpoint search/video.
	const videoUrl = item.url || `${BASE_URL}/video/${item.id}`;
	return new PlatformVideo({
		id: new PlatformID(PLATFORM, String(item.id), plugin.config.id),
		name: item.title || "",
		thumbnails: new Thumbnails([new Thumbnail(item.thumbnailUrl || item.poster || "", 0)]),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, String(item.authorId || ""), plugin.config.id),
			item.authorName || "OK.ru",
			item.authorUrl || BASE_URL,
			item.authorPic || ""
		),
		datetime: 0,
		duration: Math.round(item.duration || 0),
		viewCount: item.viewsCount || 0,
		url: videoUrl,
		isLive: item.type === "LIVE"
	});
}

function htmlDecode(str) {
	return str
		.replace(/&quot;/g, "\"")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// Pager simple (sin paginación real por ahora: devuelve una sola página)
// ---------------------------------------------------------------------------

class OkRuVideoPager extends VideoPager {
	constructor(results, hasMore, context) {
		super(results, hasMore, context ?? {});
	}
	nextPage() {
		return new OkRuVideoPager([], false, this.context);
	}
}
