const PLATFORM = "OkRu";
const BASE_URL = "https://ok.ru";

const REGEX_VIDEO_URL =
	/ok\.ru\/(?:video|videoembed|live|movie)\/(\d+)/i;

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


/* ============================================================
 * SEARCH
 * ============================================================ */

source.search = function (query, type, order, filters) {
	const url =
		`${BASE_URL}/video/search?st.query=${encodeURIComponent(query)}`;

	const resp = http.GET(url, {
		"Accept": "text/html"
	}, false);

	const items = [];

	if (!resp || !resp.isOk || !resp.body) {
		log("[OK.ru] error en búsqueda");
		return new OkRuVideoPager([], false);
	}

	try {
		const html = resp.body;

		const regex =
			/href=["']([^"']*\/video\/(\d+)[^"']*)["']/gi;

		let match;
		const seen = {};

		while ((match = regex.exec(html)) !== null) {
			const videoId = match[2];

			if (seen[videoId]) {
				continue;
			}

			seen[videoId] = true;

			let videoUrl = match[1];

			if (videoUrl.indexOf("http") !== 0) {
				videoUrl = BASE_URL + videoUrl;
			}

			items.push(
				new PlatformVideo({
					id: new PlatformID(
						PLATFORM,
						videoId,
						plugin.config.id
					),

					name: "Video de OK.ru (" + videoId + ")",

					thumbnails: new Thumbnails([]),

					author: new PlatformAuthorLink(
						new PlatformID(
							PLATFORM,
							"unknown",
							plugin.config.id
						),
						"OK.ru",
						BASE_URL,
						""
					),

					datetime: 0,
					duration: 0,
					viewCount: 0,

					url: videoUrl,

					isLive: false
				})
			);
		}

	} catch (e) {
		log("[OK.ru] error parseando búsqueda: " + e);
	}

	return new OkRuVideoPager(items, false);
};


/* ============================================================
 * URL
 * ============================================================ */

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};


/* ============================================================
 * VIDEO DETAILS
 * ============================================================ */

source.getContentDetails = function (url) {
	const match = REGEX_VIDEO_URL.exec(url);

	if (!match) {
		throw new ScriptException(
			"URL de video de OK.ru no reconocida: " + url
		);
	}

	const videoId = match[1];

	log("[OK.ru] obteniendo video " + videoId);

	/*
	 * IMPORTANTE:
	 *
	 * Ya no usamos:
	 *
	 * https://vd.mycdn.me/?video_id=ID
	 *
	 * porque esa no es necesariamente una URL de reproducción.
	 */

	const resp = http.GET(url, {
		"Accept": "text/html"
	}, false);

	if (!resp || !resp.isOk || !resp.body) {
		throw new ScriptException(
			"[OK.ru] No se pudo obtener la página del video"
		);
	}

	const html = resp.body;

	log(
		"[OK.ru] página recibida: " +
		html.length +
		" caracteres"
	);

	/*
	 * Primero intentamos obtener metadata directamente.
	 */

	let metadata = parseMetadataFromHtml(html);

	/*
	 * Si no hay metadata directa, buscamos metadataUrl.
	 */

	if (!metadata) {
		const metadataUrl =
			parseMetadataUrlFromHtml(html);

		if (metadataUrl) {
			log(
				"[OK.ru] metadataUrl encontrada"
			);

			metadata =
				getMetadataFromUrl(
					metadataUrl
				);
		}
	}

	if (!metadata) {
		throw new ScriptException(
			"[OK.ru] No se encontró metadata de reproducción"
		);
	}

	log("[OK.ru] metadata encontrada");

	const sources =
		buildVideoSources(metadata);

	if (!sources || sources.length === 0) {
		throw new ScriptException(
			"[OK.ru] La metadata no contiene MP4 ni HLS reproducible"
		);
	}

	const title =
		getMetadataTitle(metadata) ||
		"Video de OK.ru (" + videoId + ")";

	const duration =
		getMetadataDuration(metadata);

	return new PlatformVideoDetails({
		id: new PlatformID(
			PLATFORM,
			videoId,
			plugin.config.id
		),

		name: title,

		thumbnails: new Thumbnails([]),

		author: new PlatformAuthorLink(
			new PlatformID(
				PLATFORM,
				"unknown",
				plugin.config.id
			),
			"OK.ru",
			BASE_URL,
			""
		),

		datetime: 0,

		duration: duration,

		viewCount: 0,

		url: url,

		shareUrl: url,

		isLive: false,

		video: new VideoSourceDescriptor(sources)
	});
};


/* ============================================================
 * DIRECT METADATA
 * ============================================================ */

function parseMetadataFromHtml(html) {
	if (!html) {
		return null;
	}

	const patterns = [
		/data-options="([^"]+)"/i,
		/data-options='([^']+)'/i
	];

	let match = null;

	for (let i = 0; i < patterns.length; i++) {
		match = patterns[i].exec(html);

		if (match) {
			break;
		}
	}

	if (!match) {
		log("[OK.ru] data-options no encontrado");
		return null;
	}

	try {
		const decoded =
			htmlDecode(match[1]);

		const options =
			JSON.parse(decoded);

		/*
		 * metadata puede estar en:
		 *
		 * flashvars.metadata
		 *
		 * o directamente:
		 *
		 * metadata
		 */

		let metadata =
			options.flashvars &&
			options.flashvars.metadata
				? options.flashvars.metadata
				: options.metadata;

		if (!metadata) {
			return null;
		}

		/*
		 * Puede venir URL encoded.
		 */

		metadata =
			safeDecodeURIComponent(metadata);

		metadata =
			htmlDecode(metadata);

		return JSON.parse(metadata);

	} catch (e) {
		log(
			"[OK.ru] error leyendo metadata: " +
			e
		);

		return null;
	}
}


/* ============================================================
 * METADATA URL
 * ============================================================ */

function parseMetadataUrlFromHtml(html) {
	if (!html) {
		return null;
	}

	const patterns = [
		/data-options="([^"]+)"/i,
		/data-options='([^']+)'/i
	];

	let match = null;

	for (let i = 0; i < patterns.length; i++) {
		match = patterns[i].exec(html);

		if (match) {
			break;
		}
	}

	if (!match) {
		return null;
	}

	try {
		const decoded =
			htmlDecode(match[1]);

		const options =
			JSON.parse(decoded);

		if (
			options.flashvars &&
			options.flashvars.metadataUrl
		) {
			return safeDecodeURIComponent(
				options.flashvars.metadataUrl
			);
		}

		if (options.metadataUrl) {
			return safeDecodeURIComponent(
				options.metadataUrl
			);
		}

	} catch (e) {
		log(
			"[OK.ru] error buscando metadataUrl: " +
			e
		);
	}

	return null;
}


/* ============================================================
 * GET METADATA URL
 * ============================================================ */

function getMetadataFromUrl(metadataUrl) {
	if (!metadataUrl) {
		return null;
	}

	try {
		const resp = http.GET(metadataUrl, {
			"Accept": "application/json,text/plain,*/*"
		}, false);

		if (!resp || !resp.isOk || !resp.body) {
			log(
				"[OK.ru] metadataUrl devolvió error"
			);

			return null;
		}

		let body =
			safeDecodeURIComponent(resp.body);

		body =
			htmlDecode(body);

		return JSON.parse(body);

	} catch (e) {
		log(
			"[OK.ru] error obteniendo metadataUrl: " +
			e
		);

		return null;
	}
}


/* ============================================================
 * VIDEO SOURCES
 * ============================================================ */

function buildVideoSources(metadata) {
	const sources = [];

	if (!metadata) {
		return sources;
	}

	const duration =
		getMetadataDuration(metadata);

	/*
	 * ------------------------------------------------------------
	 * MP4
	 * ------------------------------------------------------------
	 */

	if (
		metadata.videos &&
		Array.isArray(metadata.videos)
	) {
		metadata.videos.forEach(function (v) {

			if (!v || !v.url) {
				return;
			}

			const dims =
				qualityNameToDims(v.name);

			sources.push(
				new VideoUrlSource({
					name: v.name || "mp4",

					url: v.url,

					width: dims.width,

					height: dims.height,

					container: "video/mp4",

					codec: "h264",

					bitrate: Number(v.bitrate || 0),

					duration: duration
				})
			);

			log(
				"[OK.ru] MP4 encontrado: " +
				(v.name || "mp4")
			);
		});
	}

	/*
	 * ------------------------------------------------------------
	 * HLS
	 * ------------------------------------------------------------
	 */

	let hlsUrl = null;

	if (metadata.hlsMasterPlaylistUrl) {
		hlsUrl =
			metadata.hlsMasterPlaylistUrl;
	}

	if (!hlsUrl && metadata.hlsManifestUrl) {
		hlsUrl =
			metadata.hlsManifestUrl;
	}

	if (hlsUrl) {
		hlsUrl =
			safeDecodeURIComponent(hlsUrl);

		log(
			"[OK.ru] HLS encontrado"
		);

		sources.push(
			new HLSSource({
				name: "HLS",

				url: hlsUrl,

				duration: duration,

				priority: true
			})
		);
	}

	return sources;
}


/* ============================================================
 * HELPERS
 * ============================================================ */

function getMetadataTitle(metadata) {
	if (!metadata) {
		return "";
	}

	if (
		metadata.movie &&
		typeof metadata.movie === "object"
	) {
		if (metadata.movie.title) {
			return metadata.movie.title;
		}

		if (metadata.movie.name) {
			return metadata.movie.name;
		}
	}

	return metadata.title || metadata.name || "";
}


function getMetadataDuration(metadata) {
	if (!metadata) {
		return 0;
	}

	if (
		metadata.movie &&
		typeof metadata.movie === "object"
	) {
		if (metadata.movie.duration) {
			return Math.round(
				Number(metadata.movie.duration)
			);
		}
	}

	if (metadata.duration) {
		return Math.round(
			Number(metadata.duration)
		);
	}

	return 0;
}


function qualityNameToDims(name) {
	switch (name) {

		case "mobile":
			return {
				width: 320,
				height: 240
			};

		case "lowest":
			return {
				width: 426,
				height: 240
			};

		case "low":
			return {
				width: 640,
				height: 360
			};

		case "sd":
			return {
				width: 854,
				height: 480
			};

		case "hd":
			return {
				width: 1280,
				height: 720
			};

		case "full":
			return {
				width: 1920,
				height: 1080
			};

		case "quad":
			return {
				width: 2560,
				height: 1440
			};

		default:
			return {
				width: 0,
				height: 0
			};
	}
}


function htmlDecode(str) {
	if (!str) {
		return "";
	}

	return str
		.replace(/&quot;/g, "\"")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'");
}


function safeDecodeURIComponent(value) {
	if (!value) {
		return value;
	}

	try {
		return decodeURIComponent(value);
	} catch (e) {
		return value;
	}
}


/* ============================================================
 * PAGER
 * ============================================================ */

class OkRuVideoPager extends VideoPager {

	constructor(results, hasMore, context) {
		super(
			results,
			hasMore,
			context ?? {}
		);
	}

	nextPage() {
		return new OkRuVideoPager(
			[],
			false,
			this.context
		);
	}
}
