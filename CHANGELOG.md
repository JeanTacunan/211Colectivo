# Historial de cambios

## [1.2.1] - 2026-11-26

- Confirmación visible y accesible tras publicar o actualizar una reseña, con botón para verla y resaltado de la reseña propia.
- Mensaje específico cuando el guardado funciona pero no se puede recargar la lista.
- Verificada la persistencia de reseñas después de nuevas consultas y cierre de sesión, conservando las anteriores.

## [1.2.1] - 2026-11-26

- Confirmación visible y accesible tras publicar o actualizar una reseña, con botón para verla y resaltado de la reseña propia.
- Mensaje específico cuando el guardado funciona pero no se puede recargar la lista.
- Verificada la persistencia de reseñas después de nuevas consultas y cierre de sesión, conservando las anteriores.

## [1.2.0] - 2026-11-26

- Registro con nombres, apellidos, celular y contraseña; inicio con celular, mostrar/ocultar contraseña y cierre de sesión.
- Formularios adaptables y versión visible en el footer.
- Eliminados Decolecta, consulta de DNI, comprobantes y credenciales del proveedor en el ejemplo de configuración.
- Contraseñas scrypt con salt aleatorio; sesiones seguras con rotación y cierre.
- Límites persistentes de intentos por celular e IP mediante D1 y HMAC.
- Migración aditiva que conserva usuarios, sesiones y reseñas; índice único para celular.
- Incorporados los cambios previos de edición de reseñas y fechas.
- Verificado con Workers y D1 aislados. Migración aplicada solo localmente, sin despliegue.

## [1.1.0] - 2026-11-26

- Actualizada la identidad p?blica de la flota de 211 a 152 Yaris: navegaci?n, portada, veh?culo, textos alternativos y metadatos.
- Incorporado versionado sem?ntico en el paquete y su archivo de bloqueo.
- Configurado el servidor de desarrollo con recursos locales en 127.0.0.1:8787.
- Conservados los recursos de infraestructura y las fotograf?as existentes.

Esta versi?n est? en revisi?n local; no se ha desplegado en producci?n. Los cambios previos de rese?as permanecen pendientes por separado.
