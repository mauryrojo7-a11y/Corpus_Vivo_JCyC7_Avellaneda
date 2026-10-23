#!/usr/bin/env node
/**
 * SERVIDOR MCP LOCAL (Model Context Protocol - JSON-RPC 2.0 sobre stdio)
 * Motor Jurisprudencial Comparativo SCBA - Juzgado Civil y Comercial N° 7 de Avellaneda y Cámaras PBA
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  buscarEnOrganismo,
  obtenerTextoIntegro,
  ejecutarBusquedaComparativa
} = require("./motor_jurisprudencia_scba");

const ORGANISMOS_PATH = path.join(__dirname, "organismos_scba.json");

const TOOLS = [
  {
    name: "buscar_jurisprudencia_comparativa_scba",
    description:
      "Ejecuta en tiempo real una búsqueda jurisprudencial comparativa en https://sentencias.scba.gov.ar filtrando en paralelo por: (1) Juzgado en lo Civil y Comercial N° 7 de Avellaneda (ID 3659), (2) Cámara de Apelación en lo Civil y Comercial de Avellaneda-Lanús (ID 4157) y Alzada de Lomas de Zamora (IDs 312, 313, 2063), y (3) restantes Cámaras de Apelación en lo Civil y Comercial de la PBA. Extrae el texto íntegro real de los fallos.",
    inputSchema: {
      type: "object",
      properties: {
        terminos: {
          type: "array",
          items: { type: "string" },
          description: "Lista de términos o conceptos jurídicos a buscar en el texto íntegro (ej. ['caducidad', '310'] o ['tasa pasiva', 'intereses'])."
        },
        registros: {
          type: "array",
          items: { type: "string", enum: ["1", "2"] },
          description: "Registros a consultar: '1' (REGISTRO DE SENTENCIAS), '2' (REGISTRO DE RESOLUCIONES). Por defecto ['1', '2']."
        },
        fDesde: {
          type: "string",
          description: "Fecha desde en formato DD/MM/AAAA (por defecto '01/06/2025')."
        },
        fHasta: {
          type: "string",
          description: "Fecha hasta en formato DD/MM/AAAA (por defecto fecha actual)."
        },
        filtroCaratula: {
          type: "string",
          description: "Filtro opcional por expresión regular sobre la carátula del expediente (ej. 'DESALOJO|DAÑOS|APREMIO')."
        },
        maxTextosPorNivel: {
          type: "number",
          description: "Cantidad máxima de fallos con texto íntegro a descargar por cada instancia (por defecto 4)."
        },
        incluirTodasLasCamaras: {
          type: "boolean",
          description: "Si es true (por defecto), consulta además de la Alzada directa a todas las Salas Civiles y Comerciales de la PBA."
        }
      },
      required: ["terminos"]
    }
  },
  {
    name: "obtener_fallo_integro_scba",
    description:
      "Obtiene el texto íntegro, firmantes, número de causa, carátula y datos de registración de una sentencia o resolución de SCBA a partir de su idCodigoAcceso.",
    inputSchema: {
      type: "object",
      properties: {
        idCodigoAcceso: {
          type: "string",
          description: "Código hexadecimal del registro en sentencias.scba.gov.ar (ej. '7EECEA3C')."
        }
      },
      required: ["idCodigoAcceso"]
    }
  },
  {
    name: "listar_organismos_scba",
    description:
      "Devuelve el mapeo oficial de organismos extraído del DOM de sentencias.scba.gov.ar (Juzgado Civil y Comercial N° 7 de Avellaneda ID 3659, Cámara de Avellaneda-Lanús ID 4157 y todas las Salas de las Cámaras Civiles y Comerciales de la PBA).",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "proyectista-scba-mcp",
        version: "1.0.0"
      }
    });
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    return sendResponse(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      if (toolName === "buscar_jurisprudencia_comparativa_scba") {
        const max = args.maxTextosPorNivel || 4;
        const data = await ejecutarBusquedaComparativa({
          terminos: args.terminos || [],
          registros: args.registros || ["1", "2"],
          fDesde: args.fDesde || "01/06/2025",
          fHasta: args.fHasta,
          filtroCaratula: args.filtroCaratula || "",
          maxTextosJuzgado7: max,
          maxTextosAlzadaDirecta: max,
          maxTextosOtrasCamaras: max,
          incluirTodasLasCamaras: args.incluirTodasLasCamaras !== false
        });
        return sendResponse(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
        });
      }

      if (toolName === "obtener_fallo_integro_scba") {
        const data = await obtenerTextoIntegro(args.idCodigoAcceso);
        return sendResponse(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
        });
      }

      if (toolName === "listar_organismos_scba") {
        const orgs = fs.readFileSync(ORGANISMOS_PATH, "utf8");
        return sendResponse(id, {
          content: [{ type: "text", text: orgs }]
        });
      }

      return sendError(id, -32601, `Herramienta desconocida: ${toolName}`);
    } catch (err) {
      return sendResponse(id, {
        isError: true,
        content: [{ type: "text", text: `Error al ejecutar ${toolName}: ${err.message}` }]
      });
    }
  }

  if (id !== undefined) {
    sendError(id, -32601, `Método no soportado: ${method}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch (err) {
    // Ignorar líneas malformadas
  }
});
