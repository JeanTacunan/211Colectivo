# Yaris 211

Landing page responsive para el Toyota Yaris 211 y su servicio de colectivo nocturno.

## Incluye

- Diseño premium con prioridad para celulares.
- Imágenes PNG con fondo transparente del vehículo.
- Ficha técnica, precio de S/ 45,000 y recorrido de 95,000 km.
- Horario en vivo calculado con la zona horaria de Lima, Perú.
- Perfil profesional de JTP Soluciones Tecnológicas.
- Registro, inicio de sesión protegido y reseñas persistentes de 1 a 5 estrellas.
- Base de datos SQLite incluida, sin dependencias externas.

## Ejecutar

Ejecuta:

```powershell
python server.py
```

Después abre `http://127.0.0.1:4173`. Para aceptar conexiones desde otros dispositivos de la misma red, establece `YARIS211_HOST=0.0.0.0` antes de iniciar el servidor.

## Datos

Las cuentas, sesiones y reseñas se guardan en `yaris211.db`. Las contraseñas usan PBKDF2-HMAC-SHA256 con salt individual y las sesiones se envían mediante cookies HttpOnly.

## Créditos

Logotipo de Universidad Continental: Marcomogollon, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ucontinental-logotipo.png), licencia CC BY-SA 4.0.
