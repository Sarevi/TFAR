# ANÁLISIS DE COSTES EMPRESARIAL - TFAR (Aplicación de Estudio)

## 📋 ESCENARIO DE USO

**Configuración solicitada:**
- **Usuarios:** 50
- **Preguntas por usuario/día:** 100
- **Período:** 1 mes (30 días)
- **Total preguntas/mes:** 150,000 preguntas

---

## 🔍 ARQUITECTURA TÉCNICA ACTUAL

### Modelo utilizado
- **Modelo:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
- **Ubicación en código:** `server.js:408`

### Sistema de generación
- **Preguntas por llamada API:** 2 preguntas
- **Distribución de dificultad:**
  - 20% Preguntas simples (600 tokens output)
  - 60% Preguntas medias (800 tokens output)
  - 20% Preguntas elaboradas (1000 tokens output)
- **Sistema de caché:** 90% de las preguntas se sirven desde caché
- **Generación nueva:** Solo 10% de preguntas requieren llamadas a API

### Tokens por llamada API

#### Input (entrada):
- Prompt base: ~1,200-1,500 tokens
- Chunk 1: ~480 tokens
- Chunk 2: ~480 tokens
- **Total input promedio:** ~2,300 tokens/llamada

#### Output (salida) - promedio ponderado:
- Simple (20%): 600 tokens × 0.20 = 120 tokens
- Media (60%): 800 tokens × 0.60 = 480 tokens
- Elaborada (20%): 1,000 tokens × 0.20 = 200 tokens
- **Total output promedio:** 800 tokens/llamada

---

## 💰 PRECIOS CLAUDE HAIKU 4.5 (2025)

**Precios base:**
- **Input:** $1.00 por millón de tokens
- **Output:** $5.00 por millón de tokens

**Con Prompt Caching (90% reducción en input):**
- **Input cached:** $0.10 por millón de tokens (90% descuento)
- **Input nuevo:** $1.00 por millón de tokens (solo 10%)
- **Output:** $5.00 por millón de tokens (sin descuento)

---

## 📊 CÁLCULO DETALLADO DE COSTES

### 1. Volumen de preguntas y llamadas API

```
Total preguntas/mes: 150,000
Preguntas nuevas (10%): 15,000
Preguntas del caché (90%): 135,000 (COSTE CERO en API)

Llamadas API necesarias: 15,000 preguntas ÷ 2 preguntas/llamada = 7,500 llamadas/mes
```

### 2. Consumo de tokens

#### Input tokens:
```
Total input tokens: 7,500 llamadas × 2,300 tokens = 17,250,000 tokens/mes
```

#### Output tokens:
```
Total output tokens: 7,500 llamadas × 800 tokens = 6,000,000 tokens/mes
```

### 3. Coste por tokens

#### Coste Input:
Con prompt caching implementado (como en el código actual):
```
Input: 17,250,000 tokens × $0.10 / 1,000,000 = $1.73/mes
```

Sin prompt caching (escenario conservador):
```
Input: 17,250,000 tokens × $1.00 / 1,000,000 = $17.25/mes
```

#### Coste Output:
```
Output: 6,000,000 tokens × $5.00 / 1,000,000 = $30.00/mes
```

### 4. COSTE TOTAL MENSUAL

#### Con Prompt Caching (CONFIGURACIÓN ACTUAL):
```
Input:   $1.73
Output:  $30.00
───────────────
TOTAL:   $31.73/mes
```

#### Sin Prompt Caching (escenario conservador):
```
Input:   $17.25
Output:  $30.00
───────────────
TOTAL:   $47.25/mes
```

---

## 📈 MÉTRICAS EMPRESARIALES

### Coste por usuario
```
Con caching: $31.73 ÷ 50 usuarios = $0.63/usuario/mes
Sin caching: $47.25 ÷ 50 usuarios = $0.95/usuario/mes
```

### Coste por pregunta
```
Con caching: $31.73 ÷ 150,000 preguntas = $0.00021/pregunta
Sin caching: $47.25 ÷ 150,000 preguntas = $0.00032/pregunta
```

### Coste por día
```
Con caching: $31.73 ÷ 30 días = $1.06/día
Sin caching: $47.25 ÷ 30 días = $1.58/día
```

---

## 🔄 PROYECCIÓN ANUAL

### 12 meses de uso continuo

```
Con Prompt Caching: $31.73 × 12 = $380.76/año
Sin Prompt Caching: $47.25 × 12 = $567.00/año
```

---

## 📊 ESCENARIOS DE ESCALABILIDAD

| Usuarios | Preguntas/día | Total/mes | Coste mensual (con caching) | Coste/usuario |
|----------|---------------|-----------|------------------------------|---------------|
| 50       | 100           | 150,000   | $31.73                      | $0.63         |
| 100      | 100           | 300,000   | $63.46                      | $0.63         |
| 200      | 100           | 600,000   | $126.92                     | $0.63         |
| 500      | 100           | 1,500,000 | $317.30                     | $0.63         |

| Usuarios | Preguntas/día | Total/mes | Coste mensual (con caching) | Coste/usuario |
|----------|---------------|-----------|------------------------------|---------------|
| 50       | 50            | 75,000    | $15.87                      | $0.32         |
| 50       | 100           | 150,000   | $31.73                      | $0.63         |
| 50       | 200           | 300,000   | $63.46                      | $1.27         |
| 50       | 500           | 750,000   | $158.65                     | $3.17         |

---

## 🎯 IMPACTO DEL SISTEMA DE CACHÉ

El sistema actual implementa una estrategia de caché del 90% (ver `server.js:2597`), lo cual es **CRÍTICO** para mantener los costes bajos:

### Beneficios del caché (90%):
1. **Reducción de llamadas API:** De 75,000 a 7,500 llamadas/mes (-90%)
2. **Ahorro mensual:** ~$285/mes (comparado con 0% caché)
3. **Latencia:** Respuesta instantánea (sin esperar API)
4. **Fiabilidad:** No depende de disponibilidad API

### Desglose sin caché (100% llamadas API):
```
Llamadas necesarias: 150,000 ÷ 2 = 75,000 llamadas/mes
Input tokens: 75,000 × 2,300 = 172,500,000 tokens
Output tokens: 75,000 × 800 = 60,000,000 tokens

Coste Input: 172,500,000 × $0.10 / 1,000,000 = $17.25
Coste Output: 60,000,000 × $5.00 / 1,000,000 = $300.00
TOTAL: $317.25/mes (10x más caro)
```

---

## ⚠️ FACTORES DE RIESGO Y CONSIDERACIONES

### 1. Variabilidad en tokens reales
- **Estimación conservadora:** Los cálculos asumen valores promedio
- **Tokens reales pueden variar:** ±20% según complejidad del contenido
- **Recomendación:** Implementar logging de consumo real

### 2. Tasa de caché efectiva
- **Asumido:** 90% (configurado en código)
- **Riesgo:** Nuevos usuarios o temas poco usados generan más preguntas nuevas
- **Mitigación:** Monitorizar ratio cache hit/miss

### 3. Distribución de dificultad
- **Asumida:** 20% Simple / 60% Media / 20% Elaborada
- **Impacto:** Preguntas elaboradas usan +67% más tokens que simples
- **Recomendación:** Analizar distribución real en producción

### 4. Picos de uso
- **Cálculo basado en:** Uso uniforme durante el mes
- **Realidad:** Posibles picos en fechas de exámenes
- **Buffer recomendado:** +20% en presupuesto

### 5. Límites de API (Rate Limits)
- **Configurado:** 50 req/min (ver `server.js:195`)
- **Para 50 usuarios:** ~250 req/hora necesarias (picos)
- **Estado:** Dentro de límites, pero monitorizar

---

## 🛠️ OPTIMIZACIONES ACTUALES IMPLEMENTADAS

✅ **Prompt Caching:** 90% reducción en costes de input
✅ **Pre-warming:** Generación anticipada reduce latencia
✅ **Rate Limiting:** Previene sobrecostes por uso excesivo
✅ **Batch Generation:** 2 preguntas por llamada (50% menos llamadas)
✅ **Buffer System:** Mantiene 3 preguntas listas por usuario

---

## 💡 RECOMENDACIONES ADICIONALES

### 1. Monitorización de costes
Implementar tracking en tiempo real:
```javascript
// Añadir a cada llamada API
const usage = response.usage;
db.logApiUsage(userId, {
  input_tokens: usage.input_tokens,
  output_tokens: usage.output_tokens,
  cost: calculateCost(usage),
  timestamp: Date.now()
});
```

### 2. Alertas de consumo
- Alerta si coste diario > $2.00 (anomalía)
- Alerta si rate de caché < 85%
- Dashboard de métricas en tiempo real

### 3. A/B Testing de configuración
- Probar 3 preguntas por llamada vs 2
- Evaluar ajustar distribución de dificultad (ej: 30/50/20)
- Medir impacto en costes vs calidad

---

## 📞 CONCLUSIONES EJECUTIVAS

### ✅ VIABILIDAD ECONÓMICA
El coste de **$31.73/mes para 50 usuarios** (150,000 preguntas) es **altamente sostenible** para un negocio empresarial.

### 💰 MODELO DE PRICING SUGERIDO

#### Opción 1: Freemium
- **Free:** 10 preguntas/día (coste: $0.06/usuario/mes)
- **Premium:** 100 preguntas/día @ $2.99/mes (margen: 79%)
- **Enterprise:** Ilimitado @ $9.99/mes (margen: 94% si uso medio 200/día)

#### Opción 2: B2B (Instituciones)
- **Escuelas:** 100 usuarios @ $99/mes (coste real: $63.46, margen: 36%)
- **Universidades:** 500 usuarios @ $399/mes (coste real: $317.30, margen: 20%)

### 🎯 BREAKEVEN ANALYSIS

Para cubrir $31.73/mes con:
- **11 usuarios** @ $2.99/mes
- **4 usuarios** @ $9.99/mes
- **1 institución** @ $99/mes (100 usuarios)

### 📊 ROI ESTIMADO

Con 50 usuarios pagando $2.99/mes:
```
Ingresos: 50 × $2.99 = $149.50/mes
Costes API: $31.73/mes
Margen bruto: $117.77/mes (79%)
Anual: $1,413.24/año
```

---

## 📚 FUENTES Y REFERENCIAS

### Precios oficiales Claude Haiku 4.5:
- [Claude Haiku 4.5 - Anthropic](https://www.anthropic.com/claude/haiku)
- [Pricing - Claude Docs](https://docs.claude.com/en/docs/about-claude/pricing)
- [Claude API Pricing Calculator](https://calculatequick.com/ai/claude-token-cost-calculator/)

### Código fuente analizado:
- `server.js:408` - Configuración del modelo
- `server.js:233-237` - Configuración de tokens
- `server.js:2597` - Sistema de caché (90%)
- `server.js:195` - Rate limiting

---

**Fecha del análisis:** 28 de noviembre de 2025
**Versión del documento:** 1.0
**Autor:** Análisis automatizado basado en código fuente y precios oficiales
