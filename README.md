# Monitor local de límites Codex con bandeja de Windows

App local para consultar conjuntamente los porcentajes restantes de las ventanas de 5 horas y semanal de Codex de la cuenta ChatGPT conectada en este equipo. En Windows incluye un icono nativo en el área de notificación para el estado del límite de 5 horas.

## Estado verificado

El 6 de septiembre de 2026 se comprobó con datos reales:

- Lectura de `account/rateLimits/read` desde el app-server local de Codex.
- Visualización conjunta de 5H, SEM, minutos desde la última lectura correcta y botón de actualización.
- Actualización automática cada 30 segundos, con envío inmediato del resultado al navegador mediante SSE.
- Actualización manual mediante un clic real en el navegador de prueba.
- Conservación de los últimos datos ante un fallo, aviso `lectura no disponible` y recuperación posterior.
- Vista de escritorio y móvil de 390 píxeles sin desbordamiento horizontal.
- 26 pruebas automatizadas superadas y ninguna incidencia de consola en la interfaz antes de la desconexión simulada.

No usa Rainmeter, Electron ni widgets de terceros.

## Uso

Mientras el servidor esté en marcha, abrir:

http://127.0.0.1:47831

### Requisitos

- Node.js 18 o posterior disponible mediante el comando `node` en `PATH`.
- Codex instalado y con una sesión iniciada en el equipo. El lector encuentra automáticamente su ejecutable o permite configurarlo con `CODEX_BIN`.
- Para la bandeja: Windows con Windows PowerShell y Windows Forms disponibles (incluidos normalmente en Windows 10 y 11).

No hay paquetes npm que instalar. El monitor utiliza módulos integrados de Node.js y, solo para el icono nativo, las bibliotecas Windows Forms y System.Drawing del sistema operativo.

Para iniciar conjuntamente el servidor y la bandeja en Windows, ejecutar `start.cmd` desde esta carpeta, o:

```cmd
node launcher.cjs
```

Si también está disponible npm, `npm start` ejecuta el mismo comando. Para arrancar solo el servidor web, sin bandeja, usar `node server.cjs` (o `npm run start:server`). En sistemas distintos de Windows, el lanzador omite automáticamente la bandeja y mantiene el monitor web.

Para detener todo lo iniciado por el lanzador desde su terminal, pulsar Ctrl+C. La opción **Salir** del menú de bandeja cierra únicamente el cliente de bandeja; el servidor continúa funcionando.

## Arquitectura de la bandeja

- `launcher.cjs` inicia el servidor y, en Windows, el cliente de bandeja como procesos separados.
- `server.cjs` continúa siendo la única fuente de verdad. Calcula la tasa observada de 5H, su color y la proyección a partir del mismo `latest` e histórico que usa la web.
- `tray.cjs` consulta `GET /api/limits` cada 5 segundos. No inicia Codex, no abre otro `app-server` y no ejecuta `account/rateLimits/read`.
- Si el servidor todavía no está disponible, muestra gris y reintenta con esperas de 1, 2, 4, 8, 16 y hasta 30 segundos. Al recuperarse vuelve al intervalo normal.
- `tray-host.ps1` contiene únicamente la integración nativa con `System.Windows.Forms.NotifyIcon`: crea los cuatro iconos, muestra el tooltip y gestiona ratón y menú.

El color aplica exactamente estos umbrales sobre la caída observada durante los últimos 2 minutos:

- verde: tasa mayor que cero y menor de 33 puntos porcentuales por hora;
- amarillo: entre 33 y 50, ambos incluidos;
- rojo: más de 50;
- gris: sin datos, datos insuficientes o tasa cero/no calculable.

El tooltip muestra el porcentaje 5H restante y los minutos estimados, `En pausa`, `Sin proyección` o `sin datos`. Windows limita el texto nativo de `NotifyIcon` a 63 caracteres.

Interacciones:

- clic izquierdo: abre `http://127.0.0.1:47831` en el navegador predeterminado;
- **Actualizar ahora**: hace POST al endpoint local `/api/refresh` con la cabecera ya exigida por el servidor;
- **Abrir monitor**: abre el mismo monitor en el navegador predeterminado;
- **Salir**: libera el icono, el menú, temporizadores y el proceso de bandeja, sin cerrar el servidor.

## Fuente y alcance

La app identifica las ventanas por `windowDurationMins`:

- `300`: 5 horas.
- `10080`: semanal.

Calcula `restante = 100 - usedPercent`. No estima tokens ni peticiones. Las ventanas se identifican por duración, no por su posición primary/secondary. Se utiliza el bucket `codex` cuando existe una respuesta con varios buckets.

Son los límites de **Codex** comunicados por la cuenta conectada; no se presentan como los límites generales de todos los modelos de chatgpt.com. La primera lectura usa la sesión predeterminada de Codex en este equipo, no un selector de cuentas propio. El ejecutable se detecta bajo `%LOCALAPPDATA%\OpenAI\Codex\bin`. `CODEX_BIN` permite indicar otro ejecutable existente sin almacenar credenciales.

La frecuencia es sondeo cada 30 segundos, más el tiempo de respuesta del proveedor. Por tanto, no es telemetría instantánea ni se garantiza que el proveedor actualice su cuota al mismo ritmo. Cada lectura tiene un plazo máximo de 15 segundos. Los clics simultáneos comparten una llamada y las repeticiones en menos de dos segundos reutilizan la lectura reciente.

## Privacidad y comportamiento ante fallos

- Escucha solo en `127.0.0.1`; no publica el servidor en la red local ni en Internet.
- Valida Host y origen de refresco, no habilita CORS y limita los recursos estáticos a la interfaz.
- Codex administra su autenticación; la app no abre ni copia archivos de credenciales.
- La API del monitor solo expone las dos ventanas y marcas temporales. No publica accountId, créditos de reset ni texto bruto de errores del proveedor.
- La bandeja accede exclusivamente a la URL loopback del monitor. No tiene endpoints externos, telemetría ni actualización automática propia.
- Los únicos mensajes enviados al app-server son `initialize`, `initialized` y `account/rateLimits/read`. No inicia conversaciones ni canjea créditos de reinicio.
- Los valores se conservan durante fallos; la fecha de la última lectura correcta no se renueva hasta recibir otra respuesta válida con ambas ventanas.
- El histórico que alimenta la gráfica se guarda localmente en `data/history.json` y sobrevive al reinicio del servidor. Conserva exclusivamente `collectedAt`, porcentaje restante de 5H y porcentaje restante semanal; no incluye credenciales, ID de cuenta, respuestas brutas ni créditos de reinicio.
- En cada escritura se descartan las muestras fuera de la ventana móvil de 129 minutos (que contiene los últimos 120 minutos solicitados y coincide con la gráfica). Si el archivo falta o está dañado, el monitor inicia el histórico vacío y continúa funcionando.
- Las evidencias de prueba sí guardan porcentajes y fechas observados; no guardan credenciales.
- El monitor no depende de inferencias de un agente. El trabajo de desarrollo y pruebas de GRU sí utiliza el modelo conectado y puede consumir su cuota.

## Archivos

- `reader.cjs`: descubrimiento de Codex, protocolo y validación de ventanas.
- `five-hour-status.cjs`: tasa, umbrales, proyección y tooltip 5H compartidos.
- `server.cjs`: estado derivado, sondeo, API localhost, SSE y servicio de la interfaz.
- `public/index.html`, `public/style.css`, `public/app.js`: interfaz combinada.
- `launcher.cjs` y `start.cmd`: arranque conjunto de servidor y bandeja.
- `tray-client.cjs`: consulta local y política de reconexión.
- `tray.cjs`: controlador Node del cliente de bandeja.
- `tray-host.ps1`: icono y menú nativos de Windows.
- `test/monitor.test.cjs`: pruebas de protocolo, normalización, fallos, concurrencia, sondeo y seguridad HTTP.
- `test/tray.test.cjs`: pruebas de colores, tooltip, proyecciones, consulta y reconexión.
- `test/live-ui-check.cjs`: prueba integral en Edge headless con un perfil temporal propio, sin tocar el navegador personal.
- `evidence/` (generado localmente e ignorado por Git): resultado JSON y capturas de la prueba de interfaz; puede contener datos de uso de la cuenta conectada.

## Repetir las verificaciones

Desde la carpeta raíz del workspace:

```cmd
node --test test\monitor.test.cjs test\tray.test.cjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File tray-host.ps1 -VerifyIcons
node tray.cjs --probe
node test\live-ui-check.cjs
```

`test:tray-host` crea y libera los cuatro iconos nativos sin dejar una bandeja persistente. `test:tray-probe` inicia temporalmente la bandeja, obtiene un estado real del servidor y la cierra limpiamente. La prueba de interfaz requiere el monitor en `127.0.0.1:47831`, Edge instalado y una sesión Codex válida; vuelve a generar evidencias locales ignoradas por Git.

## Limitaciones conocidas

- El icono de bandeja solo está disponible en Windows. El monitor web sigue siendo portable.
- Windows puede colocar inicialmente el icono en el menú de iconos ocultos del área de notificación.
- Una política corporativa que bloquee Windows PowerShell o Windows Forms impedirá iniciar la bandeja, pero no el servidor web.
- La bandeja no se registra para arrancar automáticamente con Windows.
