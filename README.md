# ⚔️ Batalla de Pelotas

Simulador de combates entre bolas con armas que mejoran con cada golpe, y apuestas entre amigos.

## Modos de juego

- **🎮 Local**: un solo dispositivo, dos apostadores comparten pantalla (el modo clásico).
- **🌐 Online**: crea una sala, comparte el código de 4 letras y cada amigo apuesta desde su propio dispositivo.

## Cómo jugar online

1. Instala las dependencias y arranca el servidor (necesitas [Node.js](https://nodejs.org)):

   ```bash
   npm install
   npm start
   ```

2. Abre `http://localhost:8080` en tu navegador y pulsa **Online → Crear sala**.

3. Tus amigos entran en `http://<tu-ip-local>:8080` (misma red WiFi) y se unen con el código de la sala. Puedes ver tu IP local con `ip addr`.

   Para jugar por internet sin abrir puertos, usa un túnel como [Tailscale](https://tailscale.com), [ngrok](https://ngrok.com) (`ngrok http 8080`) o similar y comparte esa URL.

## Jugar por internet sin tener el PC encendido (Render)

GitHub solo aloja el código; el servidor tiene que ejecutarse en algún sitio. La opción gratuita más sencilla es [Render](https://render.com):

1. Crea una cuenta en render.com (puedes entrar con tu cuenta de GitHub).
2. **New → Web Service** → conecta este repositorio de GitHub.
3. Render detecta el `render.yaml` automáticamente (plan Free, `npm install`, `npm start`). Acepta y despliega.
4. Te dará una URL tipo `https://batalla-pelotas.onrender.com` — compártela con tus amigos y a jugar.

Nota del plan gratuito: el servicio se duerme tras ~15 min sin uso y tarda medio minuto en despertar en la primera visita. Las salas viven en memoria, así que se pierden si el servicio se reinicia.

## Flujo de una ronda online

1. **Propuestas**: cada jugador puede proponer una disposición de bolas (armas) o dejarla en aleatoria.
2. **Sorteo**: el anfitrión (👑) sortea — se elige al azar una de las propuestas, o una disposición totalmente aleatoria si nadie propuso.
3. **Apuestas**: todos ven la alineación y apuestan sus monedas a una bola. El premio es `apuesta × nº de luchadores`. Cada ronda reparte +10 monedas a todos.
4. **Combate**: el anfitrión simula la batalla y la retransmite en directo al resto.
5. **Resultado**: el servidor reparte los premios (empate = apuesta devuelta) y muestra la clasificación de monedas de la sala.

Si el anfitrión abandona a mitad de combate, este se cancela, las apuestas se devuelven y el jugador más antiguo hereda la sala.

## Armas

| Arma | Mejora por golpe |
|---|---|
| ⚔️ Espada | +1 de daño |
| 🏹 Arco | Ráfagas de flechas cada vez mayores |
| ✦ Shuriken | Estrellas teledirigidas con más rebotes |
| 🛡️ Escudo | Barra recta que crece y repele enemigos (1 de daño fijo) |
