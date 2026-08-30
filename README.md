# Plugin de OK.ru para GrayJay (no oficial)

Estado: **borrador funcional, sin probar en vivo**. Es un punto de partida real
siguiendo la arquitectura oficial de plugins de GrayJay — no un mock.

## Qué hace

- `search`: busca videos en OK.ru vía su endpoint interno de búsqueda.
- `getContentDetails`: dado un link de `ok.ru/video/...`, extrae el título,
  miniatura, duración y las URLs reproducibles (mp4 progresivo + HLS si existe).
- `getHome`: vacío por ahora (ok.ru no tiene home público útil sin login).

## Cómo probarlo (en el celular, con GrayJay Android)

1. En GrayJay: **More → Settings**, bajá del todo y tocá varias veces
   "Version Code" para activar el modo desarrollador.
2. Entrá a **Developer Settings → Start Server** (esto levanta el DevServer
   en el puerto 11337).
3. Fijate la IP local del celular (Ajustes → Wi-Fi → detalles de red).
4. Serví esta carpeta en tu PC (en la misma red Wi-Fi que el celular):
   ```
   npx serve okru-grayjay-plugin
   ```
   Te va a dar una URL tipo `http://192.168.X.X:3000`.
5. En el navegador de la PC o del celular, abrí
   `http://<ip-del-celular>:11337/dev`, pegá la URL de
   `OkRuConfig.json` (ej: `http://192.168.X.X:3000/OkRuConfig.json`) y
   tocá "Load Plugin".
6. Pestaña **Testing**: probá `getContentDetails` pegando una URL real de un
   video de ok.ru. Si tira error, es casi seguro que hay que ajustar el
   parsing en `parseOkRuMetadata()` — mirá el HTML real de la página
   (Ctrl+U en el navegador) y buscá el div del reproductor con el atributo
   `data-options`, para confirmar los nombres de campo.
7. Cuando funcione en Testing, pestaña **Integration → Inject Plugin** para
   probarlo dentro de la app de verdad (te va a aparecer en Sources).

## Antes de usarlo "en serio"

- **Firma del script**: GrayJay exige `scriptSignature` y `scriptPublicKey`
  en el config para plugins que no estás cargando solo en modo dev. El
  procedimiento de firma está documentado en la sección "Script Signing" de
  la doc oficial de plugins de FUTO. Sin firma, solo vas a poder usarlo vía
  DevServer/modo desarrollador, lo cual para tu uso personal alcanza.
- **Hosting**: subí la carpeta a algo público y estable (GitHub Pages es lo
  más simple) y actualizá `sourceUrl` y `scriptUrl` en el config con esa URL
  real, para que GrayJay pueda revisar actualizaciones.
- **Cast**: como este plugin le da a GrayJay URLs de video normales (mp4/HLS),
  el cast debería funcionar igual que con cualquier otra fuente — no hace
  falta nada especial de tu lado.

## Puntos frágiles (lo que más probablemente haya que tocar)

- El nombre del atributo `data-options` y la estructura de
  `flashvars.metadata` de ok.ru pueden haber cambiado desde que esto se
  escribió. Es el corazón de la extracción del video.
- El endpoint de búsqueda (`/web-api/search/video`) puede pedir cookies de
  sesión o devolver otro formato de JSON.
- Contenido geobloqueado o que requiere login no va a tener `videos`/
  `hlsManifestUrl` en la metadata — para eso haría falta manejar auth
  (ok.ru usa login por teléfono/redes, es más laborioso).
