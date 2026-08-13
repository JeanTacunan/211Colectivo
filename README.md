# 211 Yaris

Web móvil y de escritorio para el servicio de colectivo nocturno 211 Yaris. Conserva el diseño V2 e incorpora autenticación, validación de DNI y reseñas mediante Cloudflare Workers + D1.

## Arquitectura

- `public/`: frontend estático y fotografías del vehículo.
- `src/worker.js`: API, autenticación, consulta DNI y entrega de assets.
- `migrations/`: esquema versionado de Cloudflare D1.
- `tests/`: pruebas unitarias de validaciones y normalización.
- APIS.NET.PE / Decolecta se consulta únicamente desde el Worker. No existe llamada directa desde el navegador.

## Configuración de Cloudflare

1. Instala Node.js 20 o superior y ejecuta `npm install`.
2. Autentica Wrangler con `npx wrangler login`.
3. Crea la base: `npx wrangler d1 create yaris211-db`.
4. Copia el `database_id` devuelto y reemplaza los 32 ceros de `wrangler.jsonc`.
5. Aplica el esquema remoto: `npm run db:remote`.
6. Registra cada secreto, pegando su valor solo cuando Wrangler lo solicite:

```powershell
npx wrangler secret put DNI_API_TOKEN
npx wrangler secret put DNI_HASH_SECRET
npx wrangler secret put SESSION_SECRET
```

`DNI_HASH_SECRET` y `SESSION_SECRET` deben ser valores aleatorios, independientes y largos (mínimo recomendado: 32 bytes). No uses los nombres ni valores de `.env.example` como secretos reales.

7. Despliega con `npm run deploy`. Para dominio propio, configúralo en Workers & Pages > tu Worker > Settings > Domains & Routes.

### Desarrollo local

Crea `.dev.vars` (está ignorado por Git) con los tres secretos, aplica `npm run db:local` y ejecuta `npm run dev`. El token DNI real no es necesario para probar las validaciones que fallan antes de consultar al proveedor.

## Endpoints

- `POST /api/dni/validate`: valida formato, aplica rate limiting y consulta Decolecta con Bearer token.
- `POST /api/auth/register`: crea una cuenta usando la prueba firmada de DNI.
- `POST /api/auth/login`: inicia sesión.
- `POST /api/auth/logout`: invalida la sesión.
- `GET /api/auth/me`: devuelve la sesión actual sin datos sensibles.
- `GET /api/reviews`: reseñas públicas, promedio y total calculados por D1.
- `POST /api/reviews`: crea la única reseña de la cuenta.
- `PUT /api/reviews/mine`: actualiza la reseña propia.

## Seguridad y privacidad

- DNI: se guarda únicamente HMAC-SHA-256 determinista (`dni_hash`) y sus últimos 4 dígitos. La clave queda en `DNI_HASH_SECRET`.
- Contraseñas: PBKDF2-SHA-256 con salt aleatorio, 210 000 iteraciones y comparación resistente a diferencias de tiempo.
- Sesiones: token aleatorio; solo su SHA-256 se guarda en D1. Cookie `HttpOnly`, `SameSite=Lax` y `Secure` en HTTPS.
- Registro: la validación DNI produce una prueba HMAC firmada, expira en 10 minutos y evita que el nombre sea editado.
- DNI: límite de 5 consultas por minuto y dirección IP mediante el binding nativo de Cloudflare.
- SQL: todas las entradas se envían a D1 mediante parámetros preparados.
- Reseñas públicas: nombre abreviado, estrellas, comentario y fecha; nunca correo, DNI ni identificadores internos.

## Verificación

```powershell
npm run lint
npm test
```

Las pruebas de integración con un DNI real requieren una cuenta/token vigente de Decolecta. El proveedor indica actualmente que la consulta DNI dejó de ofrecerse como servicio público por normativa de datos personales; confirma con tu cuenta que el producto RENIEC/DNI esté habilitado antes del despliegue.

## Imágenes

Las versiones originales se conservan. La web utiliza `yaris-211-front-no-plate.png` y `yaris-211-rear-no-plate.png`, editadas para ocultar la matrícula y mantener transparencia alfa.

## Créditos

Logotipo de Universidad Continental: Marcomogollon, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ucontinental-logotipo.png), licencia CC BY-SA 4.0.
