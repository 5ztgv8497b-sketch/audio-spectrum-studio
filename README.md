# SonicPulse Studio — Analizador de Espectro Acústico & Centro de Datos en Vivo

Aplicación web interactiva para cargar y reproducir archivos de audio con análisis espectral completo en un stack vertical de 3 rectángulos independientes, acompañada de widgets en tiempo real de Clima y Bolsa/Mercados conectados a APIs públicas gratuitas.

## Características Principales

1. **Stack Vertical de 3 Visualizadores de Audio (Web Audio API + Canvas 60 FPS)**:
   - **1. Espectro Completo de la Onda**: Analiza y decodifica el archivo completo inmediatamente al cargarlo (`decodeAudioData`), mostrando la estructura espectral completa de la canción y recorriéndola con un cursor interactivo al reproducir (permite hacer clic o arrastrar para saltar a cualquier segundo).
   - **2. Barras de Niveles de Frecuencia en Vivo**: 64 barras de frecuencia (`20 Hz` a `20 kHz`) con indicadores de pico (*peak-hold*) y 3 modos visuales (*Barras Clásicas*, *Espejo Dual* y *LED Studio*).
   - **3. Onda Acústica Instantánea**: Osciloscopio en el dominio del tiempo sincronizado con el audio.

2. **Reproductor y Controles de Transporte**:
   - Carga de múltiples archivos (`MP3`, `WAV`, `FLAC`, `OGG`, `M4A`, `AAC`) por botón o arrastrar y soltar (*Drag & Drop*).
   - Generador integrado de **Pista Demo Synth** para pruebas inmediatas.
   - Controles de **Reproducir / Pausar**, **Parar (Stop)**, **Atrasar (`-10s`)**, **Avanzar (`+10s`)**, pista anterior/siguiente, control de volumen, velocidad de reproducción (`0.75x` – `2.0x`) y repetición.

3. **Widgets en Tiempo Real (Conexiones Gratuitas sin API Key)**:
   - **Clima en Vivo**: Conectado a **Open-Meteo API** con buscador global de ciudades, accesos rápidos, geolocalización GPS y pronóstico de próximos días.
   - **Bolsa y Mercados**: Conectado a **CoinGecko / Binance**, **Open Exchange Rates** y **Yahoo Finance** para índices bursátiles, acciones, criptomonedas y divisas con gráfico *sparkline* interactivo.

## Uso

Abre `index.html` directamente en cualquier navegador moderno.
