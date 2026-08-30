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
		"Accept": "text/html",
		"User-Agent":
			"Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"
	}, false);

	const items = [];

	if (!resp || !resp.isOk || !resp.body) {
		log("[OK.ru] search: HTTP error");
		return new OkRuVideoPager([], false);
	}

	try {
		const html = resp.body;

		/*
		 * Búsqueda básica de links de videos.
		 *
		 * OK.ru puede cambiar el HTML de resultados,
		 * por eso usamos varios patrones.
		 */
		const patterns = [
			/href=["']([^"']*\/video\/\d+[^"']*)["']/gi,
			/href=["']([^"']*\/videoembed\/\d+[^"']*)["']/gi,
			/href=["']([^"']*\/movie\/\d+[^"']*)["']/gi
		];

		const seen = {};

		patterns.forEach(pattern => {
			let match;

			while ((match = pattern.exec(html)) !== null) {
				let videoUrl = match[1];

				videoUrl = htmlDecode(videoUrl);

				if (videoUrl.indexOf("http") !== 0) {
					videoUrl = BASE_URL + videoUrl;
				}

				const idMatch = REGEX_VIDEO_URL.exec(videoUrl);

				if (!idMatch) continue;

				const videoId = idMatch[1];

				if (seen[videoId]) continue;

				seen[videoId] = true;

				items.push(
					new PlatformVideo({
						id: new PlatformID(
							PLATFORM,
							videoId,
							plugin.config.id
						),

						name: "Video de OK.ru " + videoId,

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
		});

		log("[OK.ru] search: encontrados " + items.length + " videos");

	} catch (e) {
		log("[OK.ru] search parse error: " + e);
	}

	return new OkRuVideoPager(items, false);
};


/* ============================================================
 * URL DETECTION
 * ============================================================ */

source.isContentDetailsUrl = function (url) {
	return REGEX_VIDEO_URL.test(url);
};


/* ============================================================
 * CONTENT DETAILS
 * ============================================================ */

source.getContentDetails = function (url) {
	const match = REGEX_VIDEO_URL.exec(url);

	if (!match) {
		throw new ScriptException(
			"URL de video de OK.ru no reconocida: " + url
		);
	}

	const videoId = match[1];

	log("[OK.ru] getContentDetails: " + videoId);

	/*
	 * IMPORTANTE:
	 *
	 * Ya no construimos:
	 *
	 * https://vd.mycdn.me/?video_id=...
	 *
	 * porque esa NO es necesariamente la URL reproducible.
	 *
	 * Primero descargamos la página real de OK.ru.
	 */

	const resp = http.GET(url, {
		"Accept":
			"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

		"User-Agent":
			"Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",

		"Referer": BASE_URL + "/"
	}, false);

	if (!resp || !resp.isOk || !resp.body) {
		throw new ScriptException(
			"[OK.ru] No se pudo obtener la página del video"
		);
	}

	const html = resp.body;

	log("[OK.ru] HTML recibido: " + html.length + " bytes");

	let metadataResult = extractMetadataFromHtml(html);

	let metadata = metadataResult
		? metadataResult.metadata
		: null;

	/*
	 * ------------------------------------------------------------
	 * FALLBACK: metadataUrl
	 * ------------------------------------------------------------
	 */

	if (!metadata &&
		metadataResult &&
		metadataResult.metadataUrl) {

		const metadataUrl = metadataResult.metadataUrl;

		log(
			"[OK.ru] usando metadataUrl: " +
			metadataUrl
		);

		metadata = requestMetadata(
			metadataUrl,
			url
		);
	}

	/*
	 * Si no pudimos obtener metadata, devolvemos un objeto
	 * de detalles sin streams para que el error sea claro.
	 */

	if (!metadata) {
		log("[OK.ru] ERROR: no se encontró metadata");

		throw new ScriptException(
			"[OK.ru] No se pudo extraer la metadata del video " +
			videoId
		);
	}

	log("[OK.ru] metadata encontrada");

	const sources = buildVideoSources(
		metadata,
		url
	);

	if (sources.length === 0) {
		throw new ScriptException(
			"[OK.ru] La metadata no contiene ningún stream reproducible"
		);
	}

	const title =
		extractTitle(metadata) ||
		"Video de OK.ru (" + videoId + ")";

	const thumbnail =
		extractThumbnail(metadata);

	const duration =
		extractDuration(metadata);

	log(
		"[OK.ru] streams encontrados: " +
		sources.length
	);

	return new PlatformVideoDetails({
		id: new PlatformID(
			PLATFORM,
			videoId,
			plugin.config.id
		),

		name: title,

		thumbnails: thumbnail
			? new Thumbnails([
				new Thumbnail(thumbnail, 0, 0)
			])
			: new Thumbnails([]),

		author: new PlatformAuthorLink(
			new PlatformID(
				PLATFORM,
				extractAuthorId(metadata) || "unknown",
				plugin.config.id
			),

			extractAuthorName(metadata) || "OK.ru",

			BASE_URL,

			""
		),

		datetime: 0,

		duration: duration,

		viewCount:
			Number(metadata.viewCount || 0),

		url: url,

		shareUrl: url,

		isLive:
			!!metadata.liveDashManifestUrl ||
			!!metadata.isLive,

		video:
			new VideoSourceDescriptor(sources)
	});
};


/* ============================================================
 * METADATA EXTRACTION
 * ============================================================ */

function extractMetadataFromHtml(html) {
	if (!html) return null;

	/*
	 * Buscamos data-options tanto con comillas dobles
	 * como con comillas simples.
	 */

	const patterns = [
		/data-options\s*=\s*"([^"]+)"/i,
		/data-options\s*=\s*'([^']+)'/i
	];

	let optionsText = null;

	for (let i = 0; i < patterns.length; i++) {
		const match = patterns[i].exec(html);

		if (match) {
			optionsText = match[1];
			break;
		}
	}

	if (!optionsText) {
		log("[OK.ru] data-options no encontrado");
		return null;
	}

	try {
		optionsText = htmlDecode(optionsText);

		const options = JSON.parse(optionsText);

		const flashvars =
			options.flashvars || {};

		let metadata = null;
		let metadataUrl = null;

		/*
		 * Caso 1:
		 *
		 * flashvars.metadata
		 */

		if (flashvars.metadata) {
			metadata =
				parseMetadataString(
					flashvars.metadata
				);

			if (metadata) {
				log(
					"[OK.ru] metadata encontrada directamente"
				);

				return {
					metadata: metadata,
					metadataUrl: null
				};
			}
		}

		/*
		 * Caso 2:
		 *
		 * flashvars.metadataUrl
		 */

		if (flashvars.metadataUrl) {
			metadataUrl =
				safeDecodeURIComponent(
					flashvars.metadataUrl
				);

			return {
				metadata: null,
				metadataUrl: metadataUrl
			};
		}

		/*
		 * Algunos formatos pueden colocar metadata
		 * directamente en options.
		 */

		if (options.metadata) {
			metadata =
				parseMetadataString(
					options.metadata
				);

			if (metadata) {
				return {
					metadata: metadata,
					metadataUrl: null
				};
			}
		}

	} catch (e) {
		log(
			"[OK.ru] error leyendo data-options: " +
			e
		);
	}

	return null;
}


/* ============================================================
 * REQUEST METADATA URL
 * ============================================================ */

function requestMetadata(metadataUrl, referer) {
	if (!metadataUrl) return null;

	try {
		/*
		 * OK.ru utiliza metadataUrl para entregar el JSON
		 * de reproducción. Intentamos POST primero.
		 */

		let resp = null;

		try {
			resp = http.POST(
				metadataUrl,
				{
					"Accept": "application/json,text/plain,*/*",
					"Referer": referer,
					"User-Agent":
						"Mozilla/5.0 (Linux; Android 12) " +
						"AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"
				},
				"",
				false
			);
		} catch (e) {
			log(
				"[OK.ru] POST metadata falló: " +
				e
			);
		}

		/*
		 * Fallback GET.
		 */

		if (!resp || !resp.isOk || !resp.body) {
			log(
				"[OK.ru] intentando GET metadataUrl"
			);

			resp = http.GET(
				metadataUrl,
				{
					"Accept":
						"application/json,text/plain,*/*",

					"Referer": referer,

					"User-Agent":
						"Mozilla/5.0 (Linux; Android 12) " +
						"AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"
				},
				false
			);
		}

		if (!resp || !resp.isOk || !resp.body) {
			log(
				"[OK.ru] metadataUrl no respondió correctamente"
			);

			return null;
		}

		return parseMetadataString(resp.body);

	} catch (e) {
		log(
			"[OK.ru] requestMetadata error: " +
			e
		);

		return null;
	}
}


/* ============================================================
 * PARSE METADATA JSON
 * ============================================================ */

function parseMetadataString(value) {
	if (!value) return null;

	try {
		/*
		 * A veces metadata viene URL-encoded.
		 */

		let text = value;

		text = safeDecodeURIComponent(text);

		text = htmlDecode(text);

		/*
		 * Puede venir como JSON directamente.
		 */

		const parsed = JSON.parse(text);

		return parsed;

	} catch (e) {
		/*
		 * Segundo intento sin decodeURIComponent.
		 */

		try {
			return JSON.parse(
				htmlDecode(value)
			);
		} catch (e2) {
			log(
				"[OK.ru] metadata JSON inválido"
			);

			return null;
		}
	}
}


/* ============================================================
 * BUILD VIDEO SOURCES
 * ============================================================ */

function buildVideoSources(metadata, referer) {
	const sources = [];

	if (!metadata) {
		return sources;
	}

	const duration =
		extractDuration(metadata);

	/*
	 * ------------------------------------------------------------
	 * MP4 PROGRESIVO
	 * ------------------------------------------------------------
	 */

	if (
		metadata.videos &&
		Array.isArray(metadata.videos)
	) {
		metadata.videos.forEach(function (video) {

			if (!video || !video.url) {
				return;
			}

			const url =
				video.url;

			const quality =
				video.name ||
				video.quality ||
				"mp4";

			const dims =
				qualityNameToDims(
					quality
				);

			log(
				"[OK.ru] MP4: " +
				quality +
				" -> " +
				url
			);

			sources.push(
				new VideoUrlSource({
					name: quality,

					url: url,

					width: dims.width,

					height: dims.height,

					container: "video/mp4",

					codec: "h264",

					bitrate:
						Number(
							video.bitrate || 0
						),

					duration: duration
				})
			);
		});
	}


	/*
	 * ------------------------------------------------------------
	 * HLS
	 * ------------------------------------------------------------
	 *
	 * OK.ru puede proporcionar:
	 *
	 * hlsMasterPlaylistUrl
	 * hlsManifestUrl
	 */

	const hlsUrls = [];

	if (metadata.hlsMasterPlaylistUrl) {
		hlsUrls.push(
			metadata.hlsMasterPlaylistUrl
		);
	}

	if (metadata.hlsManifestUrl) {
		hlsUrls.push(
			metadata.hlsManifestUrl
		);
	}

	const seenHls = {};

	hlsUrls.forEach(function (hlsUrl) {

		if (!hlsUrl) return;

		hlsUrl =
			safeDecodeURIComponent(
				hlsUrl
			);

		if (seenHls[hlsUrl]) {
			return;
		}

		seenHls[hlsUrl] = true;

		log(
			"[OK.ru] HLS: " +
			hlsUrl
		);

		try {
			sources.push(
				new HLSSource({
					name: "HLS",

					url: hlsUrl,

					duration: duration,

					priority: true
				})
			);
		} catch (e) {
			log(
				"[OK.ru] no se pudo crear HLSSource: " +
				e
			);
		}
	});


	/*
	 * ------------------------------------------------------------
	 * LIVE DASH
	 * ------------------------------------------------------------
	 */

	if (metadata.liveDashManifestUrl) {

		log(
			"[OK.ru] DASH detectado: " +
			metadata.liveDashManifestUrl
		);

		/*
		 * No agregamos DASH automáticamente porque
		 * la API disponible en tu plugin no garantiza
		 * un tipo DASH compatible.
		 *
		 * HLS/MP4 siguen siendo las opciones principales.
		 */
	}


	return removeDuplicateSources(
		sources
	);
}


/* ============================================================
 * QUALITY
 * ============================================================ */

function qualityNameToDims(name) {

	if (!name) {
		return {
			width: 0,
			height: 0
		};
	}

	const normalized =
		String(name).toLowerCase();

	switch (normalized) {

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
		case "fullhd":
		case "1080":
		case "1080p":
			return {
				width: 1920,
				height: 1080
			};

		case "quad":
		case "1440":
		case "1440p":
			return {
				width: 2560,
				height: 1440
			};

		default:
			break;
	}

	/*
	 * Si OK.ru devuelve algo como "720p",
	 * intentamos obtener la resolución.
	 */

	const match =
		normalized.match(
			/^(\d{3,4})p$/
		);

	if (match) {

		const height =
			Number(match[1]);

		let width = 0;

		if (height === 2160) {
			width = 3840;
		} else if (height === 1440) {
			width = 2560;
		} else if (height === 1080) {
			width = 1920;
		} else if (height === 720) {
			width = 1280;
		} else if (height === 480) {
			width = 854;
		} else if (height === 360) {
			width = 640;
		}

		return {
			width: width,
			height: height
		};
	}

	return {
		width: 0,
		height: 0
	};
}


/* ============================================================
 * METADATA HELPERS
 * ============================================================ */

function extractTitle(metadata) {

	if (!metadata) return "";

	if (metadata.movie) {

		if (typeof metadata.movie === "object") {

			if (metadata.movie.title) {
				return metadata.movie.title;
			}

			if (metadata.movie.name) {
				return metadata.movie.name;
			}
		}

		if (typeof metadata.movie === "string") {
			return metadata.movie;
		}
	}

	return (
		metadata.title ||
		metadata.name ||
		""
	);
}


function extractDuration(metadata) {

	if (!metadata) return 0;

	let duration = 0;

	if (
		metadata.movie &&
		typeof metadata.movie === "object"
	) {
		duration =
			metadata.movie.duration || 0;
	}

	if (!duration) {
		duration =
			metadata.duration || 0;
	}

	return Math.round(
		Number(duration)
	);
}


function extractThumbnail(metadata) {

	if (!metadata) return null;

	if (metadata.thumbnail) {
		return metadata.thumbnail;
	}

	if (metadata.poster) {
		return metadata.poster;
	}

	if (
		metadata.movie &&
		typeof metadata.movie === "object"
	) {

		if (metadata.movie.thumbnail) {
			return metadata.movie.thumbnail;
		}

		if (metadata.movie.poster) {
			return metadata.movie.poster;
		}
	}

	if (
		metadata.thumbnails &&
		Array.isArray(metadata.thumbnails) &&
		metadata.thumbnails.length > 0
	) {

		const first =
			metadata.thumbnails[0];

		if (typeof first === "string") {
			return first;
		}

		if (first.url) {
			return first.url;
		}
	}

	return null;
}


function extractAuthorName(metadata) {

	if (!metadata) return "";

	if (metadata.author) {

		if (typeof metadata.author === "string") {
			return metadata.author;
		}

		if (metadata.author.name) {
			return metadata.author.name;
		}

		if (metadata.author.title) {
			return metadata.author.title;
		}
	}

	return "";
}


function extractAuthorId(metadata) {

	if (!metadata) return "";

	if (
		metadata.author &&
		typeof metadata.author === "object"
	) {

		return (
			metadata.author.id ||
			metadata.author.uid ||
			""
		);
	}

	return "";
}


/* ============================================================
 * DUPLICATE SOURCES
 * ============================================================ */

function removeDuplicateSources(sources) {

	const result = [];

	const seen = {};

	sources.forEach(function (source) {

		if (!source) return;

		const key =
			source.url || source.name;

		if (!key) {
			result.push(source);
			return;
		}

		if (seen[key]) {
			return;
		}

		seen[key] = true;

		result.push(source);
	});

	return result;
}


/* ============================================================
 * HTML / URL HELPERS
 * ============================================================ */

function htmlDecode(str) {

	if (!str) return "";

	return String(str)
		.replace(/&quot;/g, "\"")
		.replace(/&#34;/g, "\"")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/gi, "'")
		.replace(/&#x2F;/gi, "/");
}


function safeDecodeURIComponent(value) {

	if (!value) return value;

	let result = value;

	/*
	 * Algunas respuestas pueden estar doblemente
	 * codificadas.
	 */

	for (let i = 0; i < 2; i++) {

		try {

			const decoded =
				decodeURIComponent(result);

			if (decoded === result) {
				break;
			}

			result = decoded;

		} catch (e) {
			break;
		}
	}

	return result;
}


/* ============================================================
 * VIDEO PAGER
 * ============================================================ */

class OkRuVideoPager extends VideoPager {

	constructor(
		results,
		hasMore,
		context
	) {

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
