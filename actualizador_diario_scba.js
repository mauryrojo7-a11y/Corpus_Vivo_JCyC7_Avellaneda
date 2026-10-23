#!/usr/bin/env node
/**
 * ACTUALIZADOR INCREMENTAL DIARIO DEL CORPUS JURISPRUDENCIAL SCBA
 * + PUENTE AUTOMÁTICO CON LA NUBE (GITHUB RAW & GOOGLE DRIVE / DOCS)
 *
 * 1. Lee la última fecha registrada y todos los códigos de acceso / números de registro
 *    existentes en:
 *      - 01_Juzgado_Civ_Com_7_Avellaneda.md
 *      - 02_Camara_Avellaneda_Lanus.md
 *      - 03_Camaras_Civiles_PBA.md
 * 2. Consulta en https://sentencias.scba.gov.ar y https://sentencias-camara.scba.gov.ar
 *    únicamente las sentencias definitivas (RS) y resoluciones interlocutorias (RR)
 *    publicadas desde la última fecha registrada hasta hoy.
 * 3. Filtra duplicados por Código de Acceso SCBA (idCodigoAcceso) y Número de Registro (RS/RR).
 * 4. Descarga el texto íntegro de las nuevas sentencias y actualiza los 3 archivos .md
 *    más el documento consolidado Corpus_Vivo_JCyC7_Avellaneda.md.
 * 5. Sincroniza automáticamente:
 *      - Opción A: Carpeta local de Google Drive / rclone / Google Drive API (si está disponible).
 *      - Opción B: Repositorio GitHub con URL Raw fija mediante git commit && git push automático.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  buscarEnOrganismo,
  obtenerTextoIntegro
} = require("./motor_jurisprudencia_scba");

const ROOT_DIR = __dirname;
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const ORGANISMOS_PATH = path.join(ROOT_DIR, "organismos_scba.json");
const ESTADO_PATH = path.join(ROOT_DIR, "estado_incremental_scba.json");

const FILE_01 = path.join(ROOT_DIR, "01_Juzgado_Civ_Com_7_Avellaneda.md");
const FILE_02 = path.join(ROOT_DIR, "02_Camara_Avellaneda_Lanus.md");
const FILE_03 = path.join(ROOT_DIR, "03_Camaras_Civiles_PBA.md");
const FILE_CONSOLIDADO = path.join(ROOT_DIR, "Corpus_Vivo_JCyC7_Avellaneda.md");

const BASE_URL_PRIMERA = "https://sentencias.scba.gov.ar";
const BASE_URL_CAMARA = "https://sentencias-camara.scba.gov.ar";

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOGS_DIR, "actualizacion_diaria.log"), line + "\n", "utf8");
  } catch (_) {}
}

function formatDateDDMMYYYY(date = new Date()) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

function parseDDMMYYYYToDate(str) {
  if (!str) return null;
  const m = str.trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/**
 * Extrae de un archivo Markdown existente:
 * - Conjunto de códigos de acceso ya registrados (idCodigoAcceso)
 * - Conjunto de claves (organismo + nroRegistro) ya registradas
 * - La fecha más reciente registrada en el archivo (con ventana de seguridad de 2 días)
 */
function analizarArchivoExistente(filePath, fechaMinimaDefault = "01/06/2025") {
  const codigos = new Set();
  const registros = new Set();
  let maxDate = null;

  if (!fs.existsSync(filePath)) {
    return {
      codigos,
      registros,
      ultimaFechaStr: fechaMinimaDefault,
      fDesdeConsulta: fechaMinimaDefault
    };
  }

  const content = fs.readFileSync(filePath, "utf8");

  // Extraer Códigos de Acceso SCBA
  for (const m of content.matchAll(/\*\*Código de Acceso SCBA\*\*:\s*`([A-Fa-f0-9]+)`/g)) {
    codigos.add(m[1].toUpperCase().trim());
  }

  // Extraer Números de Registro junto con su Organismo
  const bloques = content.split(/^###\s+/m).slice(1);
  for (const b of bloques) {
    const orgMatch = b.match(/\*\*Organismo\*\*:\s*([^\n\r]+)/);
    const regMatch = b.match(/\*\*Número de Registro\*\*:\s*`([^`]+)`/);
    if (regMatch) {
      const org = orgMatch ? orgMatch[1].trim() : "";
      const reg = regMatch[1].trim().toUpperCase();
      registros.add(`${org}::${reg}`);
      registros.add(reg);
    }
  }

  // Extraer Fechas (- **Fecha**: DD-MM-YYYY)
  for (const m of content.matchAll(/\*\*Fecha\*\*:\s*(\d{2}[-/]\d{2}[-/]\d{4})/g)) {
    const dt = parseDDMMYYYYToDate(m[1]);
    if (dt && (!maxDate || dt > maxDate)) {
      maxDate = dt;
    }
  }

  if (!maxDate) {
    return {
      codigos,
      registros,
      ultimaFechaStr: fechaMinimaDefault,
      fDesdeConsulta: fechaMinimaDefault
    };
  }

  const ultimaFechaStr = formatDateDDMMYYYY(maxDate);
  // Restar 2 días de margen por posibles registraciones diferidas de fin de semana o feriado
  const desdeConMargen = new Date(maxDate.getTime());
  desdeConMargen.setDate(desdeConMargen.getDate() - 2);
  const minAllowed = parseDDMMYYYYToDate(fechaMinimaDefault);
  const finalDesde = minAllowed && desdeConMargen < minAllowed ? minAllowed : desdeConMargen;

  return {
    codigos,
    registros,
    ultimaFechaStr,
    fDesdeConsulta: formatDateDDMMYYYY(finalDesde)
  };
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        results[current] = { error: err.message, item: items[current] };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function formatFalloMarkdown(item, indexLabel = "NUEVO") {
  const tipoLabel = item.idRegistro === "1" ? "SENTENCIA DEFINITIVA" : "RESOLUCIÓN INTERLOCUTORIA";
  return [
    `### ${indexLabel}. [${item.nroRegistro}] ${item.caratula}`,
    `- **Organismo**: ${item.nombreOrganismo || item.organismo || ""}`,
    `- **Tipo de Fallo**: ${tipoLabel} (${item.tipoRegistro || ""})`,
    `- **Número de Causa / Expediente**: \`${item.nroExpediente}\``,
    `- **Fecha**: ${item.fecha}`,
    `- **Número de Registro**: \`${item.nroRegistro}\``,
    `- **Código de Acceso SCBA**: \`${item.idCodigoAcceso}\``,
    item.firmantes ? `- **Firmantes**: ${item.firmantes.replace(/\n+/g, " | ")}` : null,
    item.registracion ? `- **Datos de Registración**: ${item.registracion.replace(/\n+/g, " | ")}` : null,
    "",
    `#### Texto Íntegro`,
    "```text",
    (item.textoIntegro || "(Sin texto disponible)").trim(),
    "```",
    "",
    "---",
    ""
  ].filter(line => line !== null).join("\n");
}

function esDuplicado(item, estadoArchivo) {
  const code = String(item.idCodigoAcceso || "").toUpperCase().trim();
  const reg = String(item.nroRegistro || "").toUpperCase().trim();
  const orgReg = `${(item.nombreOrganismo || "").trim()}::${reg}`;
  if (estadoArchivo.codigos.has(code)) return true;
  if (estadoArchivo.registros.has(orgReg)) return true;
  return false;
}

function registrarEnEstado(item, estadoArchivo) {
  const code = String(item.idCodigoAcceso || "").toUpperCase().trim();
  const reg = String(item.nroRegistro || "").toUpperCase().trim();
  const orgReg = `${(item.nombreOrganismo || "").trim()}::${reg}`;
  estadoArchivo.codigos.add(code);
  estadoArchivo.registros.add(orgReg);
}

/**
 * Inserta nuevos fallos al inicio de una sección en el archivo Markdown y actualiza la fecha de extracción.
 */
function insertarNuevosFallosEnSeccion(content, seccionHeaderPrefix, nuevosFallosMd) {
  if (!nuevosFallosMd || nuevosFallosMd.length === 0) return content;
  const idx = content.indexOf(seccionHeaderPrefix);
  if (idx === -1) {
    return content + "\n\n" + nuevosFallosMd.join("\n");
  }
  const endOfHeaderLine = content.indexOf("\n", idx);
  if (endOfHeaderLine === -1) {
    return content + "\n\n" + nuevosFallosMd.join("\n");
  }
  const before = content.slice(0, endOfHeaderLine + 1);
  const after = content.slice(endOfHeaderLine + 1);
  return `${before}\n${nuevosFallosMd.join("\n")}\n${after.replace(/^\n+/, "")}`;
}

function actualizarFechaExtraccionHeader(content) {
  const hoyISO = new Date().toISOString().slice(0, 10);
  return content.replace(
    /- \*\*Fecha de Extracción\*\*:\s*[0-9-]+/,
    `- **Fecha de Extracción**: ${hoyISO}`
  );
}

/**
 * 1. Actualización incremental de 01_Juzgado_Civ_Com_7_Avellaneda.md
 */
async function actualizarIncrementalJuzgado7() {
  const estado = analizarArchivoExistente(FILE_01, "01/06/2025");
  const hoy = formatDateDDMMYYYY();
  const nombreOrg = "JUZGADO EN LO CIVIL Y COMERCIAL N° 7 - AVELLANEDA";

  log(`[Archivo 01 - Juzgado N° 7] Última fecha en archivo: ${estado.ultimaFechaStr} | Consultando desde ${estado.fDesdeConsulta} hasta ${hoy} (${estado.codigos.size} fallos ya registrados)...`);

  const [sents, resos] = await Promise.all([
    buscarEnOrganismo({
      idOrganismo: "3659",
      nombreOrganismo: nombreOrg,
      idRegistro: "1",
      fDesde: estado.fDesdeConsulta,
      fHasta: hoy,
      baseUrl: BASE_URL_PRIMERA
    }),
    buscarEnOrganismo({
      idOrganismo: "3659",
      nombreOrganismo: nombreOrg,
      idRegistro: "2",
      fDesde: estado.fDesdeConsulta,
      fHasta: hoy,
      baseUrl: BASE_URL_PRIMERA
    })
  ]);

  const nuevasSentencias = sents.filter(s => !esDuplicado(s, estado));
  const nuevasResoluciones = resos.filter(r => !esDuplicado(r, estado));

  log(`[Archivo 01 - Juzgado N° 7] Nuevas Sentencias (RS): ${nuevasSentencias.length} | Nuevas Resoluciones (RR): ${nuevasResoluciones.length}`);

  if (nuevasSentencias.length === 0 && nuevasResoluciones.length === 0) {
    const content = actualizarFechaExtraccionHeader(fs.readFileSync(FILE_01, "utf8"));
    fs.writeFileSync(FILE_01, content, "utf8");
    return { nuevasSentencias: 0, nuevasResoluciones: 0, totalRegistrados: estado.codigos.size };
  }

  const [sentsConTexto, resosConTexto] = await Promise.all([
    mapConcurrent(nuevasSentencias, 15, async (s) => {
      const det = await obtenerTextoIntegro(s.idCodigoAcceso, BASE_URL_PRIMERA);
      return { ...s, ...det, nombreOrganismo: nombreOrg, nroExpediente: s.nroExpediente, caratula: s.caratula };
    }),
    mapConcurrent(nuevasResoluciones, 15, async (r) => {
      const det = await obtenerTextoIntegro(r.idCodigoAcceso, BASE_URL_PRIMERA);
      return { ...r, ...det, nombreOrganismo: nombreOrg, nroExpediente: r.nroExpediente, caratula: r.caratula };
    })
  ]);

  let content = fs.readFileSync(FILE_01, "utf8");
  content = actualizarFechaExtraccionHeader(content);

  const mdSents = sentsConTexto
    .filter(x => x && !x.error)
    .map(x => {
      registrarEnEstado(x, estado);
      return formatFalloMarkdown(x, `ACT-${x.fecha}`);
    });

  const mdResos = resosConTexto
    .filter(x => x && !x.error)
    .map(x => {
      registrarEnEstado(x, estado);
      return formatFalloMarkdown(x, `ACT-${x.fecha}`);
    });

  if (mdSents.length > 0) {
    content = insertarNuevosFallosEnSeccion(content, "## SECCIÓN I: SENTENCIAS DEFINITIVAS", mdSents);
  }
  if (mdResos.length > 0) {
    content = insertarNuevosFallosEnSeccion(content, "## SECCIÓN II: RESOLUCIONES INTERLOCUTORIAS", mdResos);
  }

  fs.writeFileSync(FILE_01, content, "utf8");
  return {
    nuevasSentencias: mdSents.length,
    nuevasResoluciones: mdResos.length,
    totalRegistrados: estado.codigos.size
  };
}

/**
 * 2. Actualización incremental de 02_Camara_Avellaneda_Lanus.md
 */
async function actualizarIncrementalCamaraAvellaneda() {
  const estado = analizarArchivoExistente(FILE_02, "01/03/2025");
  const hoy = formatDateDDMMYYYY();
  const nombreCam = "CAMARA DE APELACION EN LO CIVIL Y COMERCIAL - AVELLANEDA / LANUS";

  log(`[Archivo 02 - Cámara Avellaneda-Lanús] Última fecha en archivo: ${estado.ultimaFechaStr} | Consultando desde ${estado.fDesdeConsulta} hasta ${hoy} (${estado.codigos.size} fallos ya registrados)...`);

  const [sents4157, resos4157] = await Promise.all([
    buscarEnOrganismo({
      idOrganismo: "4157",
      nombreOrganismo: nombreCam,
      idRegistro: "1",
      fDesde: estado.fDesdeConsulta,
      fHasta: hoy,
      baseUrl: BASE_URL_CAMARA
    }),
    buscarEnOrganismo({
      idOrganismo: "4157",
      nombreOrganismo: nombreCam,
      idRegistro: "2",
      fDesde: estado.fDesdeConsulta,
      fHasta: hoy,
      baseUrl: BASE_URL_CAMARA
    })
  ]);

  const nuevasSents = sents4157.filter(s => !esDuplicado(s, estado));
  const nuevasResos = resos4157.filter(r => !esDuplicado(r, estado));

  log(`[Archivo 02 - Cámara Avellaneda-Lanús] Nuevas Sentencias (RS): ${nuevasSents.length} | Nuevas Resoluciones (RR): ${nuevasResos.length}`);

  if (nuevasSents.length === 0 && nuevasResos.length === 0) {
    const content = actualizarFechaExtraccionHeader(fs.readFileSync(FILE_02, "utf8"));
    fs.writeFileSync(FILE_02, content, "utf8");
    return { nuevasSentencias: 0, nuevasResoluciones: 0, totalRegistrados: estado.codigos.size };
  }

  const [sentsConTexto, resosConTexto] = await Promise.all([
    mapConcurrent(nuevasSents, 15, async (s) => {
      const det = await obtenerTextoIntegro(s.idCodigoAcceso, BASE_URL_CAMARA);
      return { ...s, ...det, nombreOrganismo: nombreCam, nroExpediente: s.nroExpediente, caratula: s.caratula };
    }),
    mapConcurrent(nuevasResos, 15, async (r) => {
      const det = await obtenerTextoIntegro(r.idCodigoAcceso, BASE_URL_CAMARA);
      return { ...r, ...det, nombreOrganismo: nombreCam, nroExpediente: r.nroExpediente, caratula: r.caratula };
    })
  ]);

  let content = fs.readFileSync(FILE_02, "utf8");
  content = actualizarFechaExtraccionHeader(content);

  const mdSents = sentsConTexto
    .filter(x => x && !x.error)
    .map(x => {
      registrarEnEstado(x, estado);
      return formatFalloMarkdown(x, `ACT-${x.fecha}`);
    });

  const mdResos = resosConTexto
    .filter(x => x && !x.error)
    .map(x => {
      registrarEnEstado(x, estado);
      return formatFalloMarkdown(x, `ACT-${x.fecha}`);
    });

  if (mdSents.length > 0) {
    content = insertarNuevosFallosEnSeccion(content, "## SECCIÓN I: SENTENCIAS DEFINITIVAS", mdSents);
  }
  if (mdResos.length > 0) {
    content = insertarNuevosFallosEnSeccion(content, "## SECCIÓN II: RESOLUCIONES INTERLOCUTORIAS", mdResos);
  }

  fs.writeFileSync(FILE_02, content, "utf8");
  return {
    nuevasSentencias: mdSents.length,
    nuevasResoluciones: mdResos.length,
    totalRegistrados: estado.codigos.size
  };
}

/**
 * 3. Actualización incremental de 03_Camaras_Civiles_PBA.md
 */
async function actualizarIncrementalCamarasPBA() {
  const estado = analizarArchivoExistente(FILE_03, "01/09/2026");
  const hoy = formatDateDDMMYYYY();
  const config = JSON.parse(fs.readFileSync(ORGANISMOS_PATH, "utf8"));
  const camarasActivas = config.camaras_civil_y_comercial_todas.filter(
    c => c.activa && String(c.id) !== "4157"
  );

  log(`[Archivo 03 - Cámaras PBA] Última fecha en archivo: ${estado.ultimaFechaStr} | Consultando ${camarasActivas.length} Salas desde ${estado.fDesdeConsulta} hasta ${hoy} (${estado.codigos.size} fallos ya registrados)...`);

  const nuevosCandidatos = [];
  await mapConcurrent(camarasActivas, 12, async (cam) => {
    const [sents, resos] = await Promise.all([
      buscarEnOrganismo({
        idOrganismo: cam.id,
        nombreOrganismo: cam.nombre,
        idRegistro: "1",
        fDesde: estado.fDesdeConsulta,
        fHasta: hoy,
        baseUrl: BASE_URL_CAMARA
      }),
      buscarEnOrganismo({
        idOrganismo: cam.id,
        nombreOrganismo: cam.nombre,
        idRegistro: "2",
        fDesde: estado.fDesdeConsulta,
        fHasta: hoy,
        baseUrl: BASE_URL_CAMARA
      })
    ]);
    // Tomar hasta las 3 sentencias y 2 resoluciones más recientes nuevas por Sala en cada corrida diaria
    const nuevosSala = [
      ...sents.filter(s => !esDuplicado(s, estado)).slice(0, 3),
      ...resos.filter(r => !esDuplicado(r, estado)).slice(0, 2)
    ];
    for (const item of nuevosSala) {
      nuevosCandidatos.push(item);
    }
  });

  log(`[Archivo 03 - Cámaras PBA] Nuevos fallos provinciales detectados: ${nuevosCandidatos.length}`);

  if (nuevosCandidatos.length === 0) {
    const content = actualizarFechaExtraccionHeader(fs.readFileSync(FILE_03, "utf8"));
    fs.writeFileSync(FILE_03, content, "utf8");
    return { nuevosFallos: 0, totalRegistrados: estado.codigos.size };
  }

  const fallosConTexto = await mapConcurrent(nuevosCandidatos, 20, async (item) => {
    const det = await obtenerTextoIntegro(item.idCodigoAcceso, BASE_URL_CAMARA);
    return { ...item, ...det, nombreOrganismo: item.nombreOrganismo, nroExpediente: item.nroExpediente, caratula: item.caratula };
  });

  let content = fs.readFileSync(FILE_03, "utf8");
  content = actualizarFechaExtraccionHeader(content);

  let insertados = 0;
  for (const fallo of fallosConTexto) {
    if (!fallo || fallo.error) continue;
    registrarEnEstado(fallo, estado);
    const md = formatFalloMarkdown(fallo, `ACT-${fallo.fecha}`);
    const secHeader = `## ${fallo.nombreOrganismo}`;
    content = insertarNuevosFallosEnSeccion(content, secHeader, [md]);
    insertados++;
  }

  fs.writeFileSync(FILE_03, content, "utf8");
  return { nuevosFallos: insertados, totalRegistrados: estado.codigos.size };
}

/**
 * 4. Genera y mantiene actualizado el documento consolidado Corpus_Vivo_JCyC7_Avellaneda.md
 *    (unificando los fallos del Juzgado N° 7 y de la Cámara de Avellaneda-Lanús para consulta directa de Gemini Web / Google Drive)
 */
function actualizarDocumentoConsolidadoVivo() {
  log(`Actualizando documento consolidado Corpus_Vivo_JCyC7_Avellaneda.md...`);
  const c01 = fs.existsSync(FILE_01) ? fs.readFileSync(FILE_01, "utf8") : "";
  const c02 = fs.existsSync(FILE_02) ? fs.readFileSync(FILE_02, "utf8") : "";

  const header = [
    `# CORPUS VIVO: JUZGADO EN LO CIVIL Y COMERCIAL N° 7 DE AVELLANEDA Y CÁMARA DE APELACIÓN DE AVELLANEDA-LANÚS (SCBA)`,
    "",
    `- **Actualización Automática**: ${new Date().toISOString()}`,
    `- **Juzgado de Primera Instancia**: Juzgado en lo Civil y Comercial N° 7 de Avellaneda (\`idOrganismo: 3659\` - Dr. Martín Alfredo Botassi)`,
    `- **Alzada Departamental Directa**: Cámara de Apelación en lo Civil y Comercial de Avellaneda-Lanús (\`idOrganismo: 4157\`)`,
    `- **Fuente Oficial en Tiempo Real**: \`https://sentencias.scba.gov.ar/\` y \`https://sentencias-camara.scba.gov.ar/\``,
    "",
    "================================================================================",
    ""
  ].join("\n");

  // Tomar todas las sentencias definitivas y resoluciones recientes de Juzgado 7 y Cámara Avellaneda-Lanús
  const consolidado = `${header}\n${c01}\n\n================================================================================\n\n${c02}`;
  fs.writeFileSync(FILE_CONSOLIDADO, consolidado, "utf8");
  log(`Corpus_Vivo_JCyC7_Avellaneda.md actualizado (${(Buffer.byteLength(consolidado) / (1024 * 1024)).toFixed(2)} MB).`);
}

/**
 * 5. Sincronización en la Nube:
 *    - Opción A: Google Drive local / rclone / Google Drive API
 *    - Opción B: GitHub Raw (git commit && git push automático)
 */
async function sincronizarEnLaNube() {
  const resultadoSync = {
    googleDriveLocal: null,
    rclone: null,
    githubPush: null
  };

  // --- OPCIÓN A.1: Carpeta local sincronizada de Google Drive ---
  const posiblesRutasGDrive = [
    process.env.GOOGLE_DRIVE_DIR,
    "G:\\Mi unidad",
    "G:\\My Drive",
    path.join(process.env.USERPROFILE || "C:\\Users\\Pc", "Google Drive"),
    path.join(process.env.USERPROFILE || "C:\\Users\\Pc", "My Drive")
  ].filter(Boolean);

  for (const gdPath of posiblesRutasGDrive) {
    if (fs.existsSync(gdPath)) {
      try {
        const destDir = path.join(gdPath, "Corpus_Vivo_JCyC7_Avellaneda");
        fs.mkdirSync(destDir, { recursive: true });
        for (const f of [FILE_01, FILE_02, FILE_03, FILE_CONSOLIDADO]) {
          if (fs.existsSync(f)) {
            fs.copyFileSync(f, path.join(destDir, path.basename(f)));
          }
        }
        resultadoSync.googleDriveLocal = destDir;
        log(`[Sync Google Drive Local] Archivos actualizados en: ${destDir}`);
        break;
      } catch (err) {
        log(`[Sync Google Drive Local] Error al copiar a ${gdPath}: ${err.message}`);
      }
    }
  }

  // --- OPCIÓN A.2: rclone (si está instalado y tiene remote configurado) ---
  try {
    const remotes = execSync("rclone listremotes", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const gdriveRemote = remotes.split(/\r?\n/).find(r => /gdrive|google|drive/i.test(r)) || remotes.split(/\r?\n/)[0];
    if (gdriveRemote) {
      execSync(`rclone copy "${FILE_CONSOLIDADO}" "${gdriveRemote}Corpus_Vivo_JCyC7_Avellaneda/"`, { stdio: "ignore" });
      execSync(`rclone copy "${FILE_01}" "${gdriveRemote}Corpus_Vivo_JCyC7_Avellaneda/"`, { stdio: "ignore" });
      execSync(`rclone copy "${FILE_02}" "${gdriveRemote}Corpus_Vivo_JCyC7_Avellaneda/"`, { stdio: "ignore" });
      execSync(`rclone copy "${FILE_03}" "${gdriveRemote}Corpus_Vivo_JCyC7_Avellaneda/"`, { stdio: "ignore" });
      resultadoSync.rclone = `${gdriveRemote}Corpus_Vivo_JCyC7_Avellaneda/`;
      log(`[Sync rclone] Sincronizado en ${resultadoSync.rclone}`);
    }
  } catch (_) {
    // rclone no instalado o sin remotes
  }

  // --- OPCIÓN B: GitHub Raw (git add, commit & push automático) ---
  try {
    if (fs.existsSync(path.join(ROOT_DIR, ".git"))) {
      execSync("git add 01_Juzgado_Civ_Com_7_Avellaneda.md 02_Camara_Avellaneda_Lanus.md 03_Camaras_Civiles_PBA.md Corpus_Vivo_JCyC7_Avellaneda.md estado_incremental_scba.json", {
        cwd: ROOT_DIR,
        stdio: "pipe"
      });
      const status = execSync("git status --porcelain", { cwd: ROOT_DIR }).toString().trim();
      if (status) {
        const fechaHoy = new Date().toISOString().slice(0, 10);
        execSync(`git commit -m "Actualización incremental diaria SCBA (${fechaHoy})"`, {
          cwd: ROOT_DIR,
          stdio: "pipe"
        });
      }
      execSync("git push -u origin main", { cwd: ROOT_DIR, stdio: "pipe" });
      const remoteUrl = execSync("git remote get-url origin", { cwd: ROOT_DIR }).toString().trim();
      resultadoSync.githubPush = { ok: true, remote: remoteUrl, changesCommitted: Boolean(status) };
      log(`[Sync GitHub] Push exitoso a ${remoteUrl}`);
    }
  } catch (err) {
    resultadoSync.githubPush = { ok: false, error: err.message };
    log(`[Sync GitHub] Aviso en push: ${err.message}`);
  }

  return resultadoSync;
}

async function main() {
  log("====================================================================");
  log("INICIANDO ACTUALIZACIÓN INCREMENTAL DIARIA DEL CORPUS SCBA");
  const r01 = await actualizarIncrementalJuzgado7();
  const r02 = await actualizarIncrementalCamaraAvellaneda();
  const r03 = await actualizarIncrementalCamarasPBA();

  actualizarDocumentoConsolidadoVivo();

  const estadoGlobal = {
    ultimaEjecucion: new Date().toISOString(),
    juzgado7: r01,
    camaraAvellanedaLanus: r02,
    camarasPBA: r03
  };
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estadoGlobal, null, 2), "utf8");

  const sync = await sincronizarEnLaNube();
  estadoGlobal.sincronizacionNube = sync;
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estadoGlobal, null, 2), "utf8");

  log("ACTUALIZACIÓN INCREMENTAL FINALIZADA CON ÉXITO");
  log(JSON.stringify(estadoGlobal));
  log("====================================================================");
}

if (require.main === module) {
  main().catch(err => {
    log(`ERROR FATAL EN ACTUALIZADOR DIARIO: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
