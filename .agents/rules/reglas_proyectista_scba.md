---
trigger: always_on
description: Reglas permanentes de consulta jurisprudencial en tiempo real a sentencias.scba.gov.ar y redacción de proyectos de resolución bajo el CPCCBA y CCyCN para el Juzgado Civil y Comercial N° 7 de Avellaneda.
---

# Reglas de Resolución y Proyección Jurisprudencial - Juzgado en lo Civil y Comercial N° 7 de Avellaneda (SCBA)

Cada vez que el usuario suministre los datos, hechos o planteos de un juicio o expediente:

1. **Consulta obligatoria en tiempo real**: Ejecutá `node motor_jurisprudencia_scba.js --query "<términos_clave>"` (con `NODE_TLS_REJECT_UNAUTHORIZED=0` ya integrado en el motor) para consultar en vivo `https://sentencias.scba.gov.ar/` filtrando por:
   - **Juzgado en lo Civil y Comercial N° 7 de Avellaneda** (`idOrganismo: 3659`).
   - **Cámara de Apelación en lo Civil y Comercial de Avellaneda-Lanús** (`idOrganismo: 4157`) y **Salas I, II y III de Lomas de Zamora** (`IDs: 312, 313, 2063`).
   - **Restantes Salas de las Cámaras de Apelación en lo Civil y Comercial de la Provincia de Buenos Aires** (mapeadas en `organismos_scba.json`).
2. **Cero invención de metadatos**: Queda terminantemente prohibido inventar números de causa, carátulas, fechas, códigos de acceso o textos de fallos. Solo se citan sentencias y resoluciones reales verificadas y descargadas mediante `ObtenerRegistroVisualizar/`.
3. **Formato obligatorio del dictamen y proyecto**:
   - **I. Cómo lo resolvió nuestro Juzgado N° 7**: Citando carátula, número de causa, número de registro (`RS`/`RR`), código de acceso, fecha y texto real extraído.
   - **II. Cómo lo resolvieron la Cámara de Avellaneda-Lanús y restantes Cámaras**: Priorizando la Cámara de Avellaneda-Lanús (`ID 4157`) como Alzada directa, seguida de Lomas de Zamora y restantes Cámaras departamentales, con citas verificadas reales.
   - **III. Proyecto de Sentencia Interlocutoria, Definitiva o Proveído listo para firmar**: Redactado conforme las normas exactas del **CPCCBA**, **CCyCN**, **Ley 14.967** y **Acordadas SCBA 3975/20, 4013/21 y 4039/21**, con el formato y firma del **Dr. Martín Alfredo Botassi (Juez)**.
