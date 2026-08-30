const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

// Reemplaza esta URL con la tuya real de Vercel
const BRIDGE_API_URL = "https://okru-app.vercel.app/api/okru";

const REGEX_VIDEO_URL = /ok\.ru\/(?:video|live|videoembed|movie)\/(\d+)/i;
const REGEX_DATA_OPTIONS = /data-module="OKVideo"[^>]*data-options="([^"]+)"/i;

var _settings = {};

source.enable = function (conf, settings, savedState) {
	_settings = settings ?? {};
	log("[OK.ru] plugin habilitado");
};

source.disable = function () {
	log("[OK.ru] plugin deshabilitado");
};

source.getHome = function () {
	return new OkRuVideoPager([], false);
};

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

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};

source.getContentDetails = function (url) {
	const match = REGEX_VIDEO_URL.exec(url);
	if (!match) {
		throw new ScriptException("URL de video de OK.ru no reconocida: " + url);
	}
	const videoId = match[1];

	// Consultamos a nuestro servidor en Vercel para obtener los datos limpios y evitar bloqueos
	const resp = http.GET(`${BRIDGE_API_URL}?id=${videoId}`, {
		"Accept": "application/json"
	}, false);

	if (!resp.isOk) {
		throw new ScriptException(`Error al conectar con el servidor puente (HTTP ${resp.code})`);
	}

	let data;
	try {
		data = JSON.parse(resp.body);
	} catch (e) {
		throw new ScriptException("No se pudo parsear la respuesta del servidor puente.");
	}

	if (data.error) {
		throw new ScriptException("Error del servidor: " + data.error);
	}

	const title = data.title || "Video de OK.ru";
	const thumbnailUrl = data.poster || "";
	const duration = Math.round(data.duration || 0);
	const isLive = data.isLive || false;

	const videoSources = [];

	(data.videos || []).forEach(v => {
		if (!v.url) return;
		const dims = qualityNameToDims(v.name);
		videoSources.push(new VideoUrlSource({
			name: v.name || "mp4",
			url: v.url,
			width: dims.width,
			height: dims.height,
			container: "video/mp4",
			codec: "h264",
			bitrate: 0,
			duration: duration
		}));
	});

	if (data.hlsManifestUrl) {
		videoSources.push(new HLSSource({
			name: "HLS",
			url: data.hlsManifestUrl,
			duration: duration,
			priority: true
		}));
	}

	if (videoSources.length === 0) {
		throw new ScriptException("No se encontraron fuentes de video reproducibles desde el servidor puente.");
	}

	const thumbsList = thumbnailUrl ? [new Thumbnail(thumbnailUrl, 0)] : [];

	return new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, plugin.config.id),
		name: title,
		thumbnails: new Thumbnails(thumbsList),
		author: new PlatformAuthorLink(
			new PlatformID(PLATFORM, "unknown", plugin.config.id),
			"OK.ru",
			BASE_URL,
			""
		),
		datetime: 0,
		duration: duration,
		viewCount: 0,
		url: url,
		shareUrl: url,
		isLive: isLive,
		video: new VideoSourceDescriptor(videoSources)
	});
};

function parseOkRuMetadata(html) {
	let optionsMatch = REGEX_DATA_OPTIONS.exec(html);
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
	}

	try {
		return JSON.parse(metadataStr);
	} catch (e) {
		return null;
	}
}

function buildVideoSources(metadata) {
	const sources = [];

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

function buildDiagnosticSnippet(html) {
	const idx = html.indexOf("flashvars");
	if (idx === -1) {
		return `(len=${html.length}) ni "flashvars" aparece. Inicio: ...${html.substring(0, 600)}...`;
	}
	const attrStart = html.lastIndexOf('="', idx);
	const start = Math.max(0, attrStart - 250);
	const end = Math.min(html.length, attrStart + 150);
	return `(len=${html.length}) attr@${attrStart}: ...${html.substring(start, end)}...`;
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
	const videoUrl = item.url || `${BASE_URL}/video/${item.id}`;
	const thumbUrl = item.thumbnailUrl || item.poster || "";
	const thumbsList = thumbUrl ? [new Thumbnail(thumbUrl, 0)] : [];

	return new PlatformVideo({
		id: new PlatformID(PLATFORM, String(item.id), plugin.config.id),
		name: item.title || "",
		thumbnails: new Thumbnails(thumbsList),
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

class OkRuVideoPager extends VideoPager {
	constructor(results, hasMore, context) {
		super(results, hasMore, context ?? {});
	}
	nextPage() {
		return new OkRuVideoPager([], false, this.context);
	}
}
