#!/usr/bin/env node
/**
 * GENERADOR MASIVO DE CORPUS JURISPRUDENCIAL EN MARKDOWN (.MD) PARA NOTEBOOKLM
 * Extrae en tiempo real desde https://sentencias.scba.gov.ar y https://sentencias-camara.scba.gov.ar:
 *   1. 01_Juzgado_Civ_Com_7_Avellaneda.md
 *   2. 02_Camara_Avellaneda_Lanus.md
 *   3. 03_Camaras_Civiles_PBA.md
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fs = require("fs");
const path = require("path");
const {
  buscarEnOrganismo,
  obtenerTextoIntegro
} = require("./motor_jurisprudencia_scba");

const ORGANISMOS_PATH = path.join(__dirname, "organismos_scba.json");
const BASE_URL_PRIMERA = "https://sentencias.scba.gov.ar";
const BASE_URL_CAMARA = "https://sentencias-camara.scba.gov.ar";

// Sin recorte artificial para incluir la totalidad de los fallos descargados en cada archivo .md
const MAX_WORDS_NOTEBOOKLM = Infinity;

function countWords(str) {
  if (!str) return 0;
  const m = str.trim().match(/\S+/g);
  return m ? m.length : 0;
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

function formatFalloMarkdown(item, index) {
  const tipoLabel = item.idRegistro === "1" ? "SENTENCIA DEFINITIVA" : "RESOLUCIÓN INTERLOCUTORIA";
  return [
    `### ${index}. [${item.nroRegistro}] ${item.caratula}`,
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

async function generarArchivo01Juzgado7() {
  console.log("=== [1/3] Generando 01_Juzgado_Civ_Com_7_Avellaneda.md ===");
  const nombreOrg = "JUZGADO EN LO CIVIL Y COMERCIAL N° 7 - AVELLANEDA";

  const [sentencias, resoluciones] = await Promise.all([
    buscarEnOrganismo({
      idOrganismo: "3659",
      nombreOrganismo: nombreOrg,
      idRegistro: "1",
      fDesde: "01/06/2025",
      baseUrl: BASE_URL_PRIMERA
    }),
    buscarEnOrganismo({
      idOrganismo: "3659",
      nombreOrganismo: nombreOrg,
      idRegistro: "2",
      fDesde: "01/06/2025",
      baseUrl: BASE_URL_PRIMERA
    })
  ]);

  console.log(`Juzgado N° 7 Avellaneda -> Sentencias Definitivas: ${sentencias.length} | Resoluciones Interlocutorias: ${resoluciones.length}`);

  // 1. Descargar el texto íntegro de TODAS las Sentencias Definitivas (RS)
  console.log(`Descargando texto íntegro de las ${sentencias.length} Sentencias Definitivas (RS)...`);
  const sentenciasConTexto = await mapConcurrent(sentencias, 20, async (s) => {
    const det = await obtenerTextoIntegro(s.idCodigoAcceso, BASE_URL_PRIMERA);
    return { ...s, ...det, nombreOrganismo: nombreOrg, nroExpediente: s.nroExpediente, caratula: s.caratula };
  });

  // 2. Descargar las Resoluciones Interlocutorias (RR) más recientes (las 300 más recientes)
  const cantResoluciones = Math.min(resoluciones.length, 300);
  console.log(`Descargando texto íntegro de las ${cantResoluciones} Resoluciones Interlocutorias (RR) más recientes...`);
  const resolucionesConTexto = await mapConcurrent(resoluciones.slice(0, cantResoluciones), 25, async (r) => {
    const det = await obtenerTextoIntegro(r.idCodigoAcceso, BASE_URL_PRIMERA);
    return { ...r, ...det, nombreOrganismo: nombreOrg, nroExpediente: r.nroExpediente, caratula: r.caratula };
  });

  const headerLines = [
    `# Corpus Jurisprudencial: Juzgado en lo Civil y Comercial N° 7 de Avellaneda (Depto. Judicial Avellaneda-Lanús)`,
    "",
    `- **Organismo**: JUZGADO EN LO CIVIL Y COMERCIAL N° 7 - AVELLANEDA (\`idOrganismo: 3659\`)`,
    `- **Juez Titular**: Dr. Martín Alfredo Botassi`,
    `- **Fuente Oficial**: \`https://sentencias.scba.gov.ar/\` (Suprema Corte de Justicia de la Provincia de Buenos Aires)`,
    `- **Fecha de Extracción**: ${new Date().toISOString().slice(0, 10)}`,
    `- **Contenido**: Totalidad de las Sentencias Definitivas (\`RS\`: ${sentenciasConTexto.length}) y Resoluciones Interlocutorias recientes (\`RR\`) con Carátula, N° de Causa, Fecha, N° de Registro, Código de Acceso y Texto Íntegro.`,
    "",
    "---",
    "",
    `## SECCIÓN I: SENTENCIAS DEFINITIVAS (\`REGISTRO DE SENTENCIAS - RS\`)`,
    ""
  ];

  const blocks = [headerLines.join("\n")];
  let totalWords = countWords(blocks[0]);
  let countIncludedSent = 0;
  let countIncludedRes = 0;

  for (let i = 0; i < sentenciasConTexto.length; i++) {
    const item = sentenciasConTexto[i];
    if (!item || item.error) continue;
    const md = formatFalloMarkdown(item, i + 1);
    const w = countWords(md);
    if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(md);
    totalWords += w;
    countIncludedSent++;
  }

  const secIILines = [
    "",
    `## SECCIÓN II: RESOLUCIONES INTERLOCUTORIAS RECIENTES (\`REGISTRO DE RESOLUCIONES - RR\`)`,
    ""
  ].join("\n");
  blocks.push(secIILines);
  totalWords += countWords(secIILines);

  for (let i = 0; i < resolucionesConTexto.length; i++) {
    const item = resolucionesConTexto[i];
    if (!item || item.error) continue;
    const md = formatFalloMarkdown(item, i + 1);
    const w = countWords(md);
    if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(md);
    totalWords += w;
    countIncludedRes++;
  }

  const outPath = path.join(__dirname, "01_Juzgado_Civ_Com_7_Avellaneda.md");
  const fullContent = blocks.join("\n");
  fs.writeFileSync(outPath, fullContent, "utf8");
  console.log(`Guardado ${outPath} -> ${countIncludedSent} Sentencias + ${countIncludedRes} Resoluciones | ${totalWords} palabras | ${(Buffer.byteLength(fullContent) / (1024 * 1024)).toFixed(2)} MB`);
  return { outPath, sentencias: countIncludedSent, resoluciones: countIncludedRes, words: totalWords, bytes: Buffer.byteLength(fullContent) };
}

async function generarArchivo02CamaraAvellanedaLanus() {
  console.log("=== [2/3] Generando 02_Camara_Avellaneda_Lanus.md ===");
  const nombreCam = "CAMARA DE APELACION EN LO CIVIL Y COMERCIAL - AVELLANEDA / LANUS";

  // Consultar desde 01/03/2025 en sentencias-camara.scba.gov.ar para obtener el 100% de los fallos de la Cámara de Avellaneda-Lanús (ID 4157)
  const [sentencias4157, resoluciones4157] = await Promise.all([
    buscarEnOrganismo({
      idOrganismo: "4157",
      nombreOrganismo: nombreCam,
      idRegistro: "1",
      fDesde: "01/03/2025",
      baseUrl: BASE_URL_CAMARA
    }),
    buscarEnOrganismo({
      idOrganismo: "4157",
      nombreOrganismo: nombreCam,
      idRegistro: "2",
      fDesde: "01/03/2025",
      baseUrl: BASE_URL_CAMARA
    })
  ]);

  console.log(`Cámara Avellaneda-Lanús (4157) -> Sentencias: ${sentencias4157.length} | Resoluciones: ${resoluciones4157.length}`);

  // También consultar fallos recientes de causas "AL-..." en las Salas I (312), II (313) y III (2063) de Lomas de Zamora (Alzada histórica/residual de Avellaneda-Lanús)
  const salasLomas = [
    { id: "312", nombre: "CAMARA DE APELACION EN LO CIVIL Y COMERCIAL SALA I - LOMAS DE ZAMORA" },
    { id: "313", nombre: "CAMARA DE APELACION EN LO CIVIL Y COMERCIAL SALA II - LOMAS DE ZAMORA" },
    { id: "2063", nombre: "CAMARA DE APELACION EN LO CIVIL Y COMERCIAL SALA III - LOMAS DE ZAMORA" }
  ];

  const lomasALPromises = [];
  for (const sala of salasLomas) {
    lomasALPromises.push(
      buscarEnOrganismo({
        idOrganismo: sala.id,
        nombreOrganismo: sala.nombre,
        idRegistro: "1",
        fDesde: "01/06/2025",
        baseUrl: BASE_URL_CAMARA
      }).then(items => items.filter(x => /^AL-/i.test(x.nroExpediente)))
    );
  }
  const lomasALLists = await Promise.all(lomasALPromises);
  const sentenciasLomasAL = lomasALLists.flat().sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));
  console.log(`Salas I, II y III Lomas de Zamora en causas AL-... -> Sentencias: ${sentenciasLomasAL.length}`);

  // Descargar el 100% de las Sentencias (43) y Resoluciones (380) de la Cámara de Avellaneda-Lanús (ID 4157)
  console.log(`Descargando textos íntegros de la Cámara de Avellaneda-Lanús (ID 4157)...`);
  const [sent4157Texto, res4157Texto, sentLomasALTexto] = await Promise.all([
    mapConcurrent(sentencias4157, 20, async (s) => {
      const det = await obtenerTextoIntegro(s.idCodigoAcceso, BASE_URL_CAMARA);
      return { ...s, ...det, nombreOrganismo: nombreCam, nroExpediente: s.nroExpediente, caratula: s.caratula };
    }),
    mapConcurrent(resoluciones4157, 25, async (r) => {
      const det = await obtenerTextoIntegro(r.idCodigoAcceso, BASE_URL_CAMARA);
      return { ...r, ...det, nombreOrganismo: nombreCam, nroExpediente: r.nroExpediente, caratula: r.caratula };
    }),
    mapConcurrent(sentenciasLomasAL.slice(0, 60), 20, async (s) => {
      const det = await obtenerTextoIntegro(s.idCodigoAcceso, BASE_URL_CAMARA);
      return { ...s, ...det, nombreOrganismo: s.nombreOrganismo, nroExpediente: s.nroExpediente, caratula: s.caratula };
    })
  ]);

  const headerLines = [
    `# Corpus Jurisprudencial: Cámara de Apelación en lo Civil y Comercial de Avellaneda-Lanús (Alzada Directa)`,
    "",
    `- **Organismo Principal**: CAMARA DE APELACION EN LO CIVIL Y COMERCIAL - AVELLANEDA / LANUS (\`idOrganismo: 4157\`)`,
    `- **Alzada Residual en causas \`AL-...\` preexistentes**: Cámara de Apelación en lo Civil y Comercial de Lomas de Zamora - Salas I (\`312\`), II (\`313\`) y III (\`2063\`)`,
    `- **Fuente Oficial**: \`https://sentencias.scba.gov.ar/\` y \`https://sentencias-camara.scba.gov.ar/\``,
    `- **Fecha de Extracción**: ${new Date().toISOString().slice(0, 10)}`,
    `- **Contenido**: Totalidad de las Sentencias Definitivas (\`RS\`) y Resoluciones Interlocutorias (\`RR\`) de la Cámara de Apelación en lo Civil y Comercial de Avellaneda-Lanús (\`ID 4157\`), más Sentencias Definitivas recientes dictadas en causas del Departamento Judicial Avellaneda-Lanús (\`AL-...\`) por su Alzada histórica.`,
    "",
    "---",
    "",
    `## SECCIÓN I: SENTENCIAS DEFINITIVAS - CÁMARA CIVIL Y COMERCIAL DE AVELLANEDA-LANÚS (\`ID 4157 - RS\`)`,
    ""
  ];

  const blocks = [headerLines.join("\n")];
  let totalWords = countWords(blocks[0]);
  let countS4157 = 0;
  let countR4157 = 0;
  let countLomasAL = 0;

  for (let i = 0; i < sent4157Texto.length; i++) {
    const item = sent4157Texto[i];
    if (!item || item.error) continue;
    const md = formatFalloMarkdown(item, i + 1);
    const w = countWords(md);
    if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(md);
    totalWords += w;
    countS4157++;
  }

  const secIILines = [
    "",
    `## SECCIÓN II: RESOLUCIONES INTERLOCUTORIAS - CÁMARA CIVIL Y COMERCIAL DE AVELLANEDA-LANÚS (\`ID 4157 - RR\`)`,
    ""
  ].join("\n");
  blocks.push(secIILines);
  totalWords += countWords(secIILines);

  for (let i = 0; i < res4157Texto.length; i++) {
    const item = res4157Texto[i];
    if (!item || item.error) continue;
    const md = formatFalloMarkdown(item, i + 1);
    const w = countWords(md);
    if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(md);
    totalWords += w;
    countR4157++;
  }

  const secIIILines = [
    "",
    `## SECCIÓN III: SENTENCIAS EN CAUSAS DE AVELLANEDA-LANÚS (\`AL-...\`) DICTADAS POR LA ALZADA RESIDUAL (CÁMARA DE LOMAS DE ZAMORA - SALAS I, II Y III)`,
    ""
  ].join("\n");
  blocks.push(secIIILines);
  totalWords += countWords(secIIILines);

  for (let i = 0; i < sentLomasALTexto.length; i++) {
    const item = sentLomasALTexto[i];
    if (!item || item.error) continue;
    const md = formatFalloMarkdown(item, i + 1);
    const w = countWords(md);
    if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(md);
    totalWords += w;
    countLomasAL++;
  }

  const outPath = path.join(__dirname, "02_Camara_Avellaneda_Lanus.md");
  const fullContent = blocks.join("\n");
  fs.writeFileSync(outPath, fullContent, "utf8");
  console.log(`Guardado ${outPath} -> ${countS4157} Sentencias (4157) + ${countR4157} Resoluciones (4157) + ${countLomasAL} Sentencias AL (Lomas) | ${totalWords} palabras | ${(Buffer.byteLength(fullContent) / (1024 * 1024)).toFixed(2)} MB`);
  return { outPath, sentencias4157: countS4157, resoluciones4157: countR4157, sentenciasAL_Lomas: countLomasAL, words: totalWords, bytes: Buffer.byteLength(fullContent) };
}

async function generarArchivo03CamarasCivilesPBA() {
  console.log("=== [3/3] Generando 03_Camaras_Civiles_PBA.md ===");
  const config = JSON.parse(fs.readFileSync(ORGANISMOS_PATH, "utf8"));

  // Seleccionar todas las Salas y Cámaras activas de la PBA (excepto 4157 que ya está íntegra en el archivo 02)
  const camarasActivas = config.camaras_civil_y_comercial_todas.filter(
    c => c.activa && String(c.id) !== "4157"
  );

  console.log(`Consultando los fallos más recientes de las ${camarasActivas.length} Salas/Cámaras Civiles y Comerciales activas de la PBA...`);

  // Buscar desde el 01/09/2026 hasta hoy en cada Sala (Sentencias y Resoluciones)
  const listadosPorSala = await mapConcurrent(camarasActivas, 12, async (cam) => {
    const [sents, resos] = await Promise.all([
      buscarEnOrganismo({
        idOrganismo: cam.id,
        nombreOrganismo: cam.nombre,
        idRegistro: "1",
        fDesde: "01/09/2026",
        baseUrl: BASE_URL_CAMARA
      }),
      buscarEnOrganismo({
        idOrganismo: cam.id,
        nombreOrganismo: cam.nombre,
        idRegistro: "2",
        fDesde: "01/09/2026",
        baseUrl: BASE_URL_CAMARA
      })
    ]);
    // Seleccionar las 5 Sentencias Definitivas más recientes y las 3 Resoluciones Interlocutorias más recientes de cada Sala/Cámara
    const seleccion = [
      ...sents.slice(0, 5),
      ...resos.slice(0, 3)
    ];
    return { cam, seleccion };
  });

  const todosSeleccionados = [];
  for (const entry of listadosPorSala) {
    if (!entry || !entry.seleccion) continue;
    for (const item of entry.seleccion) {
      todosSeleccionados.push(item);
    }
  }

  console.log(`Total de fallos recientes seleccionados en las ${camarasActivas.length} Salas/Cámaras provinciales: ${todosSeleccionados.length}. Descargando textos íntegros...`);

  const fallosConTexto = await mapConcurrent(todosSeleccionados, 25, async (item) => {
    const det = await obtenerTextoIntegro(item.idCodigoAcceso, BASE_URL_CAMARA);
    return {
      ...item,
      ...det,
      nombreOrganismo: item.nombreOrganismo,
      nroExpediente: item.nroExpediente,
      caratula: item.caratula
    };
  });

  // Agrupar por organismo para una estructura limpia en Markdown
  const porOrganismo = new Map();
  for (const fallo of fallosConTexto) {
    if (!fallo || fallo.error) continue;
    if (!porOrganismo.has(fallo.nombreOrganismo)) {
      porOrganismo.set(fallo.nombreOrganismo, []);
    }
    porOrganismo.get(fallo.nombreOrganismo).push(fallo);
  }

  const headerLines = [
    `# Corpus Jurisprudencial: Cámaras de Apelación en lo Civil y Comercial de la Provincia de Buenos Aires (Fallos Más Recientes)`,
    "",
    `- **Cobertura Provincial**: ${porOrganismo.size} Salas y Cámaras de Apelación en lo Civil y Comercial de los Departamentos Judiciales de La Plata, Lomas de Zamora, Quilmes, San Isidro, San Martín, La Matanza, Morón, Mar del Plata, Mercedes, Azul, Bahía Blanca, San Nicolás, Dolores, Junín, Zárate-Campana, Pergamino, Necochea y Trenque Lauquen.`,
    `- **Fuente Oficial**: \`https://sentencias.scba.gov.ar/\` y \`https://sentencias-camara.scba.gov.ar/\``,
    `- **Fecha de Extracción**: ${new Date().toISOString().slice(0, 10)}`,
    `- **Contenido**: Selección representativa de las Sentencias Definitivas (\`RS\`) y Resoluciones Interlocutorias (\`RR\`) más recientes de cada Sala departamental con Carátula, N° de Causa, Fecha, N° de Registro, Código de Acceso y Texto Íntegro.`,
    "",
    "---",
    ""
  ];

  const blocks = [headerLines.join("\n")];
  let totalWords = countWords(blocks[0]);
  let countIncluded = 0;

  for (const [nombreOrg, fallos] of porOrganismo.entries()) {
    const orgHeader = `\n## ${nombreOrg} (\`idOrganismo: ${fallos[0].idOrganismo}\`)\n`;
    const orgHeaderWords = countWords(orgHeader);
    if (totalWords + orgHeaderWords > MAX_WORDS_NOTEBOOKLM) break;
    blocks.push(orgHeader);
    totalWords += orgHeaderWords;

    for (let i = 0; i < fallos.length; i++) {
      const md = formatFalloMarkdown(fallos[i], i + 1);
      const w = countWords(md);
      if (totalWords + w > MAX_WORDS_NOTEBOOKLM) break;
      blocks.push(md);
      totalWords += w;
      countIncluded++;
    }
  }

  const outPath = path.join(__dirname, "03_Camaras_Civiles_PBA.md");
  const fullContent = blocks.join("\n");
  fs.writeFileSync(outPath, fullContent, "utf8");
  console.log(`Guardado ${outPath} -> ${countIncluded} fallos de ${porOrganismo.size} Salas/Cámaras | ${totalWords} palabras | ${(Buffer.byteLength(fullContent) / (1024 * 1024)).toFixed(2)} MB`);
  return { outPath, fallos: countIncluded, salas: porOrganismo.size, words: totalWords, bytes: Buffer.byteLength(fullContent) };
}

async function main() {
  const t0 = Date.now();
  const r1 = await generarArchivo01Juzgado7();
  const r2 = await generarArchivo02CamaraAvellanedaLanus();
  const r3 = await generarArchivo03CamarasCivilesPBA();
  console.log("\n=== EXTRACCIÓN MASIVA COMPLETADA EN", ((Date.now() - t0) / 1000).toFixed(1), "SEGUNDOS ===");
  console.log(JSON.stringify({ r1, r2, r3 }, null, 2));
}

main().catch(err => {
  console.error("Error en extracción masiva:", err);
  process.exit(1);
});
