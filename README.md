# 152 Yaris · 1.2.0

Frontend estático y backend en Cloudflare Workers con usuarios, sesiones y reseñas en D1.

## Desarrollo local

1. Instalar Node.js 22 o superior y ejecutar npm ci.
2. Crear .dev.vars con SESSION_SECRET aleatorio (32 bytes o más). Está ignorado por Git; .env.example no contiene credenciales.
3. Ejecutar npm run db:local y npm run dev.
4. Abrir http://127.0.0.1:8787 y seleccionar Mi cuenta (en celular, dentro del menú).

Wrangler usa exclusivamente recursos locales. No requiere DNI, correo ni proveedor externo.

## Flujo de autenticación

El formulario envía JSON mediante fetch al mismo origen. El Worker vuelve a validar los campos: nombres y apellidos obligatorios de hasta 80 caracteres cada uno, celular como cadena de nueve dígitos que empieza con 9 y contraseña de 8 a 128 caracteres. La validación del navegador mejora la experiencia; la del backend protege la base.

| Endpoint | Método | JSON de entrada |
| --- | --- | --- |
| /api/auth/register | POST | firstName, lastName, phone, password |
| /api/auth/login | POST | phone, password |
| /api/auth/logout | POST | {} |
| /api/auth/me | GET | Sin cuerpo |

Registro e inicio devuelven { success: true, user: { name, phone } } y una cookie. Los errores devuelven { success: false, error }. Nunca se devuelven contraseñas ni hashes.

## Almacenamiento y seguridad

- users: nombres, apellidos, celular, hash y fechas. Un índice único impide celulares duplicados incluso con registros simultáneos. Consultas parametrizadas.
- sessions: hash SHA-256 de un token aleatorio de 32 bytes, usuario y vencimiento de 30 días. Cookie HttpOnly, SameSite=Lax y Secure en HTTPS (sin Secure en HTTP local). Al autenticar se sustituye la sesión presentada; al salir se elimina y expira la cookie. Las fechas se comparan con julianday.
- auth_attempts: contadores atómicos por celular e IP, separados para registro e inicio. Permite 5 intentos por celular y 30 por IP durante 15 minutos, contando también accesos correctos. Devuelve 429 y Retry-After al superar el límite. Claves protegidas con HMAC y SESSION_SECRET, sin celular ni IP en claro; limpieza de ventanas vencidas al siguiente intento.
- reviews: continúa vinculada a users.id. Se conservan reseñas y publicación anónima.

Contraseñas nuevas: scrypt (N=32768, r=8, p=3), salt aleatorio de 16 bytes y salida de 32 bytes. Se almacena scrypt$32768$8$3$salt$hash, nunca el texto original. Comparación timingSafeEqual. Se conserva lectura de hashes PBKDF2 históricos sin reescribirlos.

El celular se valida por formato, no por titularidad. No incluye SMS ni recuperación de contraseña.

## Migración no destructiva

0003_phone_auth.sql añade first_name, last_name, phone, el índice único y auth_attempts. No modifica ni elimina registros existentes.

Las columnas históricas obligatorias dni_hash, dni_last4 y email permanecen para conservar esquema y datos. Los nuevos usuarios tienen marcadores internos sin datos personales en esas columnas, que no intervienen en la autenticación. Las cuentas antiguas conservan phone = NULL y sus sesiones; necesitan una futura vinculación verificada para acceder con celular. Registrar el mismo nombre no fusiona cuentas ni traslada reseñas.

## Archivos y pruebas

- public/index.html, styles.css y script.js: formularios, mostrar/ocultar contraseña, estado de cuenta y cierre de sesión.
- src/worker.js: validación, hash, límites, sesiones y reseñas.
- migrations/: evolución del esquema.
- tests/auth.test.mjs: integración en Workers y D1 aislados con datos ficticios. No escribe en la base de desarrollo ni en producción.
- tests/worker.test.mjs: validaciones unitarias.

Ejecutar npm run lint y npm test. Se verifica conservación de datos, campos obligatorios, formato de celular, origen, duplicados, cookies, rotación, cierre y expiración de sesión, contraseña incorrecta y límites de intentos.

## Versiones y producción

package.json, package-lock.json, footer y CHANGELOG.md registran 1.2.0 según SemVer.

No se ha aplicado la migración remota ni desplegado esta versión. Una entrega autorizada requiere respaldo de D1, migraciones pendientes y SESSION_SECRET configurado. Los secretos antiguos del proveedor ya no se usan; su eliminación remota queda pendiente. Las credenciales anteriormente incluidas en Git deben revocarse: limpiar el archivo actual no las elimina del historial.

## Imágenes y créditos

Se conservan los nombres históricos de las fotografías yaris-211-*-no-plate.png. Logotipo Universidad Continental: Marcomogollon, Wikimedia Commons, licencia CC BY-SA 4.0.
