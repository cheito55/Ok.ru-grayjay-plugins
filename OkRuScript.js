const PLATFORM_NAME = "PoseidonHD";
const BASE_URL = "https://www.poseidonhd2.co";
let PLUGIN_ID = "";

source.enable = function (conf, settings, savedState) {
    PLUGIN_ID = (conf && conf.id) ? conf.id : "";
};

source.isContentDetailsUrl = function (url) {
    return url.includes("poseidonhd2.co/pelicula/") || url.includes("poseidonhd2.co/episodio/");
};

// ------------------------------------------------------------
// Home: Extraer la portada (Novedades)
// ------------------------------------------------------------
source.getHome = function () {
    const resp = http.GET(BASE_URL, {}, false);
    if (!resp.isOk) throw new ScriptException("Error al cargar inicio: " + resp.code);

    // Usamos DOMParser en lugar de Regex
    const doc = domParser.parseFromString(resp.body);
    
    // Asumiendo estructura típica Dooplay: <article class="item movies">
    const items = doc.querySelectorAll(".items .item"); 
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const aTag = item.querySelector("a");
        const imgTag = item.querySelector("img");
        
        if (aTag && imgTag) {
            const url = aTag.getAttribute("href");
            const title = imgTag.getAttribute("alt");
            const thumbUrl = imgTag.getAttribute("src");

            results.push(new PlatformVideo({
                id: new PlatformID(PLATFORM_NAME, url, PLUGIN_ID),
                name: title,
                thumbnails: new Thumbnails([{ url: thumbUrl, quality: 480 }]),
                author: new PlatformAuthorLink(new PlatformID(PLATFORM_NAME, "", PLUGIN_ID), PLATFORM_NAME, BASE_URL, ""),
                uploadDate: 0,
                duration: 0, // Generalmente no visible en la grilla
                viewCount: 0,
                url: url,
                isLive: false
            }));
        }
    }

    return new VideoPager(results, false, {});
};

// ------------------------------------------------------------
// Búsqueda
// ------------------------------------------------------------
source.search = function (query, type, order, filters) {
    if (!query) return new VideoPager([], false, {});

    const searchUrl = BASE_URL + "/?s=" + encodeURIComponent(query);
    const resp = http.GET(searchUrl, {}, false);
    
    if (!resp.isOk) throw new ScriptException("Error en búsqueda: " + resp.code);

    const doc = domParser.parseFromString(resp.body);
    const items = doc.querySelectorAll(".result-item"); // Clase típica de búsqueda
    const results = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const aTag = item.querySelector(".title a");
        const imgTag = item.querySelector("img");

        if (aTag && imgTag) {
            const url = aTag.getAttribute("href");
            const title = aTag.text || imgTag.getAttribute("alt");
            const thumbUrl = imgTag.getAttribute("src");

            results.push(new PlatformVideo({
                id: new PlatformID(PLATFORM_NAME, url, PLUGIN_ID),
                name: title,
                thumbnails: new Thumbnails([{ url: thumbUrl, quality: 480 }]),
                author: new PlatformAuthorLink(new PlatformID(PLATFORM_NAME, "", PLUGIN_ID), PLATFORM_NAME, BASE_URL, ""),
                uploadDate: 0,
                duration: 0,
                viewCount: 0,
                url: url,
                isLive: false
            }));
        }
    }

    return new VideoPager(results, false, {});
};

// ------------------------------------------------------------
// Detalles y Extracción de Video
// ------------------------------------------------------------
source.getContentDetails = function (url) {
    const resp = http.GET(url, {}, false);
    if (!resp.isOk) throw new ScriptException("Error al cargar película: " + resp.code);

    const doc = domParser.parseFromString(resp.body);
    
    const title = doc.querySelector("h1").text;
    const imgTag = doc.querySelector(".poster img");
    const thumbUrl = imgTag ? imgTag.getAttribute("src") : "";
    const descTag = doc.querySelector(".wp-content p");
    
    // Extracción de Reproductores (Iframes)
    // Sitios como PoseidonHD suelen cargar reproductores por AJAX al hacer clic en las opciones de idioma.
    // O bien, tienen los iframes ocultos en el HTML (ej. <div id="option-1"> <iframe src="..."> )
    
    const iframes = doc.querySelectorAll(".playex iframe, .source-box iframe");
    const sources = [];

    for (let i = 0; i < iframes.length; i++) {
        const iframeSrc = iframes[i].getAttribute("src");
        if (iframeSrc) {
            // Aquí en un escenario real, tendrías que enviar la URL del iframe al extractor
            // correspondiente (ej. si es OK.ru, usar HLS; si es Streamtape, desofuscar el link).
            // GrayJay permite usar WebVideoSource para que el reproductor web interno se encargue:
            sources.push(new WebVideoSource({
                name: "Opción " + (i + 1) + " (Web Player)",
                url: iframeSrc
            }));
        }
    }

    if (sources.length === 0) {
        throw new ScriptException("No se detectaron reproductores de video en el DOM inicial. (Puede requerir simular solicitudes AJAX).");
    }

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM_NAME, url, PLUGIN_ID),
        name: title,
        thumbnails: new Thumbnails([{ url: thumbUrl, quality: 720 }]),
        author: new PlatformAuthorLink(new PlatformID(PLATFORM_NAME, "", PLUGIN_ID), PLATFORM_NAME, BASE_URL, ""),
        uploadDate: 0,
        duration: 0,
        description: descTag ? descTag.text : "",
        video: new VideoSourceDescriptor(sources)
    });
};
