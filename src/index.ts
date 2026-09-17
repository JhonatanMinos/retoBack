import { createApp } from "./app";
import { DB, runMigrations } from "./db";

// 1. Ejecutar migraciones al arrancar
runMigrations(DB);

// 2. Crear la app inyectando la DB
const app = createApp(DB);

// 3. Escuchar en el puerto (Render asigna PORT dinámicamente)
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0"; // importante en Render/containers

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on http://${HOST}:${PORT}`);
});
