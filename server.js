// ========================
// SERVIDOR OPTIMIZADO PARA RENDER - server.js
// ========================

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { Anthropic } = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const cron = require('node-cron');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const Bottleneck = require('bottleneck');
const async = require('async');
require('dotenv').config();

// Importar sistema de base de datos
const db = require('./database');

const app = express();
const port = process.env.PORT || 3000;

// Inicializar base de datos
db.initDatabase();

// Confiar en proxies (necesario para Render)
app.set('trust proxy', 1);

// ========================
// HELMET - Headers de Seguridad
// ========================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-hashes'", "https://cdnjs.cloudflare.com"], // unsafe-inline/unsafe-hashes para scripts y event handlers inline, CDN para jsPDF
      scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"], // Permitir event handlers inline (onclick, etc)
      styleSrc: ["'self'", "'unsafe-inline'"], // unsafe-inline necesario para estilos inline
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.anthropic.com'], // API de Claude
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"] // Previene clickjacking
    }
  },
  hsts: {
    maxAge: 31536000, // 1 año
    includeSubDomains: true,
    preload: true
  },
  frameguard: {
    action: 'deny' // Previene que la app sea embebida en iframes
  },
  noSniff: true, // Previene MIME sniffing
  xssFilter: true, // Filtro XSS legacy (navegadores antiguos)
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin'
  }
}));

console.log('✅ Helmet configurado - Headers de seguridad activos');

// Middleware de sesiones
app.use(session({
  store: new SQLiteStore({
    db: 'sessions.db',
    dir: __dirname
  }),
  secret: process.env.SESSION_SECRET || 'oposiciones-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  proxy: true,  // CRÍTICO: Confiar en el proxy de Render
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'  // 'none' necesario para HTTPS con proxy
  }
}));

// ========================
// CORS - Configuración Segura
// ========================
// Orígenes permitidos - Configurar según entorno
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
  : ['http://localhost:3000', 'http://127.0.0.1:3000']; // Desarrollo

app.use(cors({
  origin: (origin, callback) => {
    // Permitir requests sin origin (Postman, curl, acceso directo por IP)
    // Esto es seguro porque ya tenemos autenticación y rate limiting
    if (!origin) {
      return callback(null, true);
    }

    // Verificar si el origin está en la lista permitida
    if (allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
      callback(null, true);
    } else {
      console.warn(`🚫 Origen bloqueado por CORS: ${origin}`);
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'], // Eliminado X-Admin-Password
  maxAge: 86400 // Cache preflight 24 horas
}));

console.log(`✅ CORS configurado - Orígenes permitidos:`, allowedOrigins.length > 0 ? allowedOrigins : ['TODOS (⚠️  Configurar ALLOWED_ORIGINS en producción)']);
app.use(express.json({ limit: '10mb' }));

// ========================
// RATE LIMITING - Protección contra sobrecarga
// ========================

// Limiter global: 300 requests por 15 minutos por IP
// Para 300 usuarios concurrentes: ~1 request/3 segundos promedio
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // máximo 300 requests por ventana
  message: 'Demasiadas peticiones desde esta IP, por favor intenta de nuevo en 15 minutos',
  standardHeaders: true, // Retorna info en headers `RateLimit-*`
  legacyHeaders: false // Deshabilita headers `X-RateLimit-*`
  // Usa req.ip por defecto (ya configurado con trust proxy)
});

// Limiter para autenticación: 10 intentos por 15 minutos
// Previene brute force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de login. Por favor espera 15 minutos',
  skipSuccessfulRequests: false // Contar todos los intentos
});

// Limiter para generación de exámenes: 30 por hora por usuario
// Previene abuso de API de IA y costos excesivos
const examLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 30,
  message: 'Límite de generación de exámenes alcanzado. Por favor espera 1 hora',
  keyGenerator: (req) => {
    // Por usuario autenticado, no por IP (evita problemas con IPv6)
    return req.session?.userId?.toString() || 'anonymous';
  }
});

// Limiter para endpoints de estudio: 100 preguntas por hora por usuario
const studyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 100,
  message: 'Límite de preguntas alcanzado. Por favor espera 1 hora',
  keyGenerator: (req) => {
    return req.session?.userId?.toString() || 'anonymous';
  }
});

// Aplicar limiter global a todas las rutas
app.use(globalLimiter);

console.log('✅ Rate limiting configurado para 300+ usuarios concurrentes');

// Middleware de logging para debugging
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'} - Cookies: ${req.headers.cookie ? 'presente' : 'ausente'}`);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Cliente de Anthropic (Claude)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ========================
// RATE LIMITER DE CLAUDE API
// ========================
// Limita las llamadas a Claude API para respetar el límite de 50 req/min
// y prevenir errores 429 (Rate Limit Exceeded) con múltiples exámenes concurrentes
const claudeLimiter = new Bottleneck({
  maxConcurrent: 35,        // Máximo 35 requests simultáneos (optimizado para reducir timeouts)
  minTime: 1000,            // Mínimo 1 segundo entre requests (~60/min con margen)
  reservoir: 50,            // Pool de 50 tokens
  reservoirRefreshAmount: 50,
  reservoirRefreshInterval: 60 * 1000,  // Refrescar cada minuto
  // Estrategia cuando se alcanza el límite
  strategy: Bottleneck.strategy.LEAK
});

// Eventos de monitoreo (opcional, para debugging)
claudeLimiter.on('failed', (error, jobInfo) => {
  console.error(`⚠️ Claude API call failed: ${error.message}`);
  if (jobInfo.retryCount < 2) {
    console.log(`🔄 Reintentando en ${jobInfo.retryCount * 2}s...`);
    return jobInfo.retryCount * 2000; // Retry after 2s, 4s
  }
});

claudeLimiter.on('depleted', () => {
  console.warn('⏳ Rate limit alcanzado, esperando...');
});

// Directorio de documentos
const DOCUMENTS_DIR = path.join(__dirname, 'documents');

// CONFIGURACIÓN OPTIMIZADA (balance velocidad-confiabilidad)
const IMPROVED_CLAUDE_CONFIG = {
  maxRetries: 3,              // 3 intentos para mayor confiabilidad
  baseDelay: 1500,           // 1.5 segundos de delay inicial
  maxDelay: 8000,            // Máximo 8 segundos
  backoffMultiplier: 2,
  jitterFactor: 0.1          // Jitter moderado
};

// CONFIGURACIÓN DEL BUFFER DE PREGUNTAS
// Buffer más grande = menos probabilidad de que el usuario vea "Reintentando..."
const BUFFER_TARGET_SIZE = 5;       // Tamaño objetivo del buffer (antes 3)
const BUFFER_REFILL_TRIGGER = 4;    // Rellenar en cuanto baja de 4

// CONFIGURACIÓN DE TEMPERATURA VARIABLE POR DIFICULTAD
// Valores ligeramente más altos para aumentar variedad y evitar repetición de conceptos
const TEMPERATURE_CONFIG = {
  'simple': 0.5,      // Balance determinismo/variedad (antes 0.3)
  'media': 0.7,       // Más variedad en aplicación práctica (antes 0.5)
  'elaborada': 0.85   // Mayor creatividad en casos complejos (antes 0.7)
};

// CONFIGURACIÓN DE TOKENS OPTIMIZADA (2 preguntas por llamada)
const MAX_TOKENS_CONFIG = {
  simple: 600,      // 2 preguntas × 300 tokens (margen amplio)
  media: 800,       // 2 preguntas × 400 tokens (margen amplio)
  elaborada: 1000   // 2 preguntas × 500 tokens (margen amplio)
};

// CONFIGURACIÓN DE MODELO POR DIFICULTAD (ESTRATEGIA MIXTA):
// - Simple y Media → Haiku 4.5 (rápido, económico, suficiente para recall/aplicación)
// - Elaborada → Sonnet 4.6 (razonamiento profundo, distractores finos, integración multi-concepto)
// Coste ponderado resultante: ~$0.0015/pregunta (~650 preguntas/€).
const MODEL_CONFIG = {
  simple: 'claude-haiku-4-5-20251001',
  media: 'claude-haiku-4-5-20251001',
  elaborada: 'claude-sonnet-4-6'
};

// ========================
// CONTROL DE GENERACIONES EN BACKGROUND
// ========================
// Previene que múltiples clicks inicien generaciones duplicadas
// Clave: `${userId}-${topicId}` -> Promise de generación en curso
const backgroundGenerations = new Map();

// TTL para limpieza automática (5 minutos por defecto)
const BACKGROUND_GENERATION_TTL = 5 * 60 * 1000;

// ========================
// CACHÉ DE DOCUMENTOS EN MEMORIA
// ========================
// Cachea el contenido de documentos para evitar lecturas repetidas del disco
// Clave: topicId -> { content: string, chunks: string[], timestamp: number }
const documentsCache = new Map();
const DOCUMENT_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

// Función auxiliar para ejecutar generación controlada
async function runControlledBackgroundGeneration(userId, topicId, generationFn) {
  const key = `${userId}-${topicId}`;

  // Si ya hay una generación en curso para este usuario+tópico, no iniciar otra
  if (backgroundGenerations.has(key)) {
    console.log(`⏭️  Generación en background ya en progreso para usuario ${userId}, tópico ${topicId}`);
    return;
  }

  // SEGURIDAD: Limpieza automática por timeout (previene memory leaks)
  const timeoutId = setTimeout(() => {
    if (backgroundGenerations.has(key)) {
      console.warn(`⚠️ Limpiando generación expirada en background (usuario ${userId}, tópico ${topicId})`);
      backgroundGenerations.delete(key);
    }
  }, BACKGROUND_GENERATION_TTL);

  try {
    // Marcar que está en progreso
    const promise = generationFn();
    backgroundGenerations.set(key, promise);

    // Ejecutar generación
    await promise;

    console.log(`✅ Generación en background completada para usuario ${userId}, tópico ${topicId}`);
  } catch (error) {
    console.error(`❌ Error en generación background (usuario ${userId}, tópico ${topicId}):`, error);
  } finally {
    // Cancelar timeout (ya completó)
    clearTimeout(timeoutId);
    // Limpiar entrada del Map
    backgroundGenerations.delete(key);
  }
}

// Configuración completa de temas - TÉCNICO DE FARMACIA
const TOPIC_CONFIG = {
  "tema-1-educacion-salud": {
    "title": "TEMA 1 - EDUCACION PARA LA SALUD",
    "description": "Educación para la Salud",
    "files": ["TEMA 1- EDUCACION PARA LA SALUD .txt"]
  },
  "tema-2-higiene-infecciosas": {
    "title": "TEMA 2 - HIGIENE Y ENFERMEDADES INFECCIOSAS",
    "description": "Higiene y Enfermedades Infecciosas",
    "files": ["TEMA 2- HIGIENE Y ENFERMEDADES INFECCIOSAS.txt"]
  },
  "tema-4-organizaciones-farmaceuticas": {
    "title": "TEMA 4 - ORGANIZACIONES FARMACEUTICAS",
    "description": "Organizaciones Farmacéuticas",
    "files": ["TEMA 4- ORGANIZACIONES FARMACEUTICAS.txt"]
  },
  "tema-5-medicamentos": {
    "title": "TEMA 5 - MEDICAMENTOS",
    "description": "Medicamentos",
    "files": ["TEMA 5- MEDICAMENTOS.txt"]
  },
  "tema-6-formulas-magistrales": {
    "title": "TEMA 6 - FORMULAS MAGISTRALES Y PREPARADOS OFICINALES",
    "description": "Fórmulas Magistrales y Preparados Oficinales",
    "files": ["TEMA 6- FORMULAS MAGISTRALES Y PREPARADOS OFICINALES.txt"]
  },
  "tema-7-acondicionamiento": {
    "title": "TEMA 7 - ACONDICIONAMIENTO DE LOS MEDICAMENTOS",
    "description": "Acondicionamiento de los Medicamentos",
    "files": ["TEMA 7- ACONDICIONAMIENTO DE LOS MEDICAMENTOS.txt"]
  },
  "tema-8-farmacocinetica": {
    "title": "TEMA 8 - FARMACOCINETICA Y FARMACODINAMIA",
    "description": "Farmacocinética y Farmacodinamia",
    "files": ["TEMA 8- FARMACOCINETICA Y FARMACODINAMIA.txt"]
  },
  "tema-9-administracion": {
    "title": "TEMA 9 - ADMINISTRACION DE MEDICAMENTOS",
    "description": "Administración de Medicamentos",
    "files": ["TEMA 9- ADMINISTRACION DE MEDICAMENTOS.txt"]
  },
  "tema-10-formas-farmaceuticas": {
    "title": "TEMA 10 - FORMAS FARMACEUTICAS Y VIAS DE ADMINISTRACION",
    "description": "Formas Farmacéuticas y Vías de Administración",
    "files": ["TEMA 10- FORMAS FARMACEUTICAS Y VIAS DE ADMINISTRACION.txt"]
  },
  "tema-11-farmacia-hospitalaria": {
    "title": "TEMA 11 - FARMACIA HOSPITALARIA",
    "description": "Farmacia Hospitalaria",
    "files": ["TEMA 11- FARMACIA HOSPITALARIA.txt"]
  },
  "tema-12-almacenamiento": {
    "title": "TEMA 12 - ALMACENAMIENTO Y CONSERVACION",
    "description": "Almacenamiento y Conservación",
    "files": ["TEMA-12-ALMACENAMIENTO-Y-CONSERVACION.txt"]
  },
  "tema-13-laboratorio": {
    "title": "TEMA 13 - LABORATORIO FARMACEUTICO",
    "description": "Laboratorio Farmacéutico",
    "files": ["TEMA-13-LABORATORIO-FARMACEUTICO.txt"]
  },
  "tema-13-parte-2": {
    "title": "TEMA 13 (2ª parte) - LABORATORIO FARMACEUTICO",
    "description": "Laboratorio Farmacéutico - Parte 2",
    "files": ["TEMA-13-2ª-parte-LABORATORIO-FARMACEUTICO.txt"]
  },
  "tema-14-operaciones": {
    "title": "TEMA 14 - OPERACIONES FARMACEUTICAS BASICAS",
    "description": "Operaciones Farmacéuticas Básicas",
    "files": ["TEMA-14-OPERACIONES-FARMACEUTICAS-BASICAS.txt"]
  },
  "tema-14-parte-2": {
    "title": "TEMA 14 (2ª parte) - LABORATORIO FARMACEUTICO",
    "description": "Laboratorio Farmacéutico - Parte 2",
    "files": ["TEMA-14-2ª-parte-LABORATORIO-FARMACEUTICO.txt"]
  },
  "tema-15-analisis-clinicos": {
    "title": "TEMA 15 - ANALISIS CLINICOS",
    "description": "Análisis Clínicos",
    "files": ["TEMA-15-ANALISIS-CLINICOS.txt"]
  },
  "tema-17-espectrofotometria": {
    "title": "TEMA 17 - ESPECTROFOTOMETRIA Y MICROSCOPIA",
    "description": "Espectrofotometría y Microscopía",
    "files": ["TEMA-17-ESPECTROFOTOMETRIA-Y-MICROSCOPIA.txt"]
  },
  "tema-18-parafarmacia": {
    "title": "TEMA 18 - PARAFARMACIA",
    "description": "Parafarmacia",
    "files": ["TEMA-18-PARAFARMACIA.txt"]
  },
  "tema-19-seguridad-riesgos": {
    "title": "TEMA 19 - SEGURIDAD Y PREVENCION DE RIESGOS",
    "description": "Seguridad y Prevención de Riesgos",
    "files": ["TEMA 19- SEGURIDAD Y PREVENCION DE RIESGOS.txt"]
  },
  "tema-20-perspectiva-genero": {
    "title": "TEMA 20 - PERSPECTIVA DE GENERO",
    "description": "Perspectiva de Género",
    "files": ["TEMA 20- PERSPECTIVA DE GENERO.txt"]
  }
};

// ========================
// MIGRACIÓN INICIAL DE ESTADO DE TEMAS
// ========================
// Si la tabla topic_status está vacía (primer arranque tras deploy), los temas
// existentes se marcan como ACTIVOS para no romper la experiencia de usuarios
// actuales. Solo los temas nuevos añadidos después arrancarán INACTIVOS.
(function migrateInitialTopicStatus() {
  try {
    const existing = db.getTopicStatusMap();
    if (Object.keys(existing).length === 0) {
      const topicIds = Object.keys(TOPIC_CONFIG);
      console.log(`🎚️  Primera ejecución: marcando ${topicIds.length} temas existentes como ACTIVOS`);
      for (const id of topicIds) {
        db.setTopicEnabled(id, true);
      }
    }
  } catch (err) {
    console.error('⚠️  Error en migración inicial de topic_status:', err);
  }
})();

// ========================
// SISTEMA OPTIMIZADO DE LLAMADAS A CLAUDE
// ========================

function calculateDelay(attempt, config = IMPROVED_CLAUDE_CONFIG) {
  const baseDelay = config.baseDelay;
  const exponentialDelay = baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);
  const jitter = exponentialDelay * config.jitterFactor * Math.random();
  const finalDelay = Math.min(exponentialDelay + jitter, config.maxDelay);
  return Math.round(finalDelay);
}

async function callClaudeWithImprovedRetry(fullPrompt, maxTokens = 700, questionType = 'media', questionsPerCall = 2, config = IMPROVED_CLAUDE_CONFIG) {
  const ABSOLUTE_TIMEOUT = 240000; // 240 segundos (4 minutos) - margen robusto para colas + reintentos

  // Envolver toda la lógica de retry en un timeout absoluto
  const retryWithTimeout = Promise.race([
    // Lógica de retry normal
    (async () => {
      let lastError = null;

      for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
          // Estrategia mixta: Haiku 4.5 para simple/media, Sonnet 4.6 para elaborada
          const model = MODEL_CONFIG[questionType] || 'claude-haiku-4-5-20251001';
          console.log(`🤖 Intento ${attempt}/${config.maxRetries} - Generando ${questionsPerCall} preguntas ${questionType} con ${model}...`);

          // Determinar temperatura según dificultad
          const temperature = TEMPERATURE_CONFIG[questionType] || 0.5;

          // Envolver llamada a Claude con rate limiter (respeta 50 req/min)
          const response = await claudeLimiter.schedule(() => anthropic.messages.create({
        model: model, // Haiku 4.5 (simple/media) o Sonnet 4.6 (elaborada)
        max_tokens: maxTokens, // Variable según tipo de pregunta
        temperature: temperature,  // Temperatura variable según dificultad
        /* SISTEMA PREMIUM - MÁXIMA CALIDAD (20% Simple / 60% Media / 20% Elaborada):
         *
         * PREGUNTAS SIMPLES (20% - 3 por llamada) - TIPO OPOSICIÓN:
         * - Chunk: 1200 caracteres (~480 tokens)
         * - Prompt detallado: ~200 tokens (instrucciones completas + ejemplos)
         * - Input total: ~680 tokens × $0.80/1M = $0.000544
         * - Output (800 max): ~93 tokens × 3 = 280 tokens × $4.00/1M = $0.001120
         * - Total: $0.001664 ÷ 3 = $0.000555 USD/pregunta
         *
         * PREGUNTAS MEDIAS (60% - 3 por llamada) - APLICACIÓN PRÁCTICA:
         * - Chunk: 1200 caracteres (~480 tokens)
         * - Prompt detallado: ~250 tokens (metodología + casos realistas)
         * - Input total: ~730 tokens × $0.80/1M = $0.000584
         * - Output (1100 max): ~122 tokens × 3 = 366 tokens × $4.00/1M = $0.001464
         * - Total: $0.002048 ÷ 3 = $0.000683 USD/pregunta
         *
         * PREGUNTAS ELABORADAS (20% - 2 por llamada) - CASOS COMPLEJOS:
         * - Chunk: 1200 caracteres (~480 tokens)
         * - Prompt detallado: ~350 tokens (casos multifactoriales detallados)
         * - Input total: ~830 tokens × $0.80/1M = $0.000664
         * - Output (1400 max): ~233 tokens × 2 = 466 tokens × $4.00/1M = $0.001864
         * - Total: $0.002528 ÷ 2 = $0.001264 USD/pregunta
         *
         * COSTO PROMEDIO PONDERADO (20/60/20):
         * (0.20 × $0.000555) + (0.60 × $0.000683) + (0.20 × $0.001264)
         * = $0.000111 + $0.000410 + $0.000253
         * = $0.000774 USD (~0.00072 EUR) por pregunta
         *
         * 🎯 SISTEMA PREMIUM - MÁXIMA CALIDAD:
         * • Con 1€ generas ~1,290 preguntas de CALIDAD OPOSICIÓN
         * • Incremento coste: +24% vs sistema anterior (+$0.15/100 preguntas)
         * • Mejora calidad: SIGNIFICATIVA (nivel examen oficial)
         * • Examen 100 preguntas: $0.077 USD (~7 céntimos)
         * • Balance: EXCELENTE relación calidad/precio para uso educativo
         *
         * CARACTERÍSTICAS PREMIUM:
         * • Prompts extensos con metodología detallada
         * • Ejemplos de preguntas tipo oposición real
         * • Instrucciones para distractores inteligentes
         * • Casos prácticos multifactoriales realistas
         * • Verificación estricta contra invención de datos
         */
        messages: [{
          role: "user",
          content: fullPrompt
        }]
      }));

          console.log(`✅ ${questionsPerCall} preguntas ${questionType} generadas en intento ${attempt}`);
          return response;

        } catch (error) {
          lastError = error;
          console.error(`❌ Intento ${attempt} fallido:`, {
            status: error.status,
            message: error.message,
            type: error.type,
            error: error.error
          });

          if (attempt === config.maxRetries) {
            console.log(`💀 Todos los ${config.maxRetries} intentos fallaron`);
            break;
          }

          const waitTime = calculateDelay(attempt, config);
          console.log(`⏳ Esperando ${waitTime/1000}s antes del siguiente intento...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      throw lastError;
    })(),

    // Timeout absoluto
    new Promise((_, reject) =>
      setTimeout(() => {
        console.warn('⏱️ Generación tardó más de 4 minutos (posible sobrecarga del servicio)');
        reject(new Error('El servicio está experimentando alta demanda. Por favor, intenta de nuevo en unos momentos.'));
      }, ABSOLUTE_TIMEOUT)
    )
  ]);

  return retryWithTimeout;
}

// ========================
// FUNCIÓN PARA ALEATORIZAR OPCIONES
// ========================

function randomizeQuestionOptions(question) {
  // Guardar la opción correcta original
  const correctOption = question.options[question.correct];

  // Crear array de índices [0, 1, 2, 3]
  const indices = [0, 1, 2, 3];

  // Algoritmo Fisher-Yates para barajar aleatoriamente
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  // Reordenar las opciones según los índices barajados
  const shuffledOptions = indices.map(i => question.options[i]);

  // Encontrar la nueva posición de la opción correcta
  const newCorrectIndex = shuffledOptions.indexOf(correctOption);

  // Actualizar las letras de las opciones (A, B, C, D)
  const letters = ['A', 'B', 'C', 'D'];
  const reorderedOptions = shuffledOptions.map((option, index) => {
    // Remover la letra anterior y agregar la nueva
    const optionText = option.substring(3); // Quitar "A) ", "B) ", etc.
    return `${letters[index]}) ${optionText}`;
  });

  return {
    ...question,
    options: reorderedOptions,
    correct: newCorrectIndex
  };
}

// ========================
// SISTEMA DE VALIDACIÓN DE CALIDAD (FASE 2)
// ========================

function validateQuestionQuality(question) {
  const issues = [];

  // Validar que existe la pregunta y opciones
  if (!question.question || !question.options || question.options.length !== 4) {
    issues.push('missing_fields');
    return { isValid: false, issues, score: 0 };
  }

  // Validar que no empieza con frases narrativas problemáticas
  const narrativeStarts = [
    'recibes', 'durante la recepción', 'al elaborar',
    'un paciente solicita', 'en tu turno', 'te llega',
    'mientras trabajas', 'en la farmacia'
  ];

  const questionLower = question.question.toLowerCase();
  const hasNarrativeStart = narrativeStarts.some(phrase =>
    questionLower.startsWith(phrase) ||
    questionLower.includes(`. ${phrase}`)
  );

  if (hasNarrativeStart) {
    issues.push('narrative_start');
  }

  // Validar que no tiene códigos ATC completos (solo familias están permitidas)
  if (questionLower.match(/código atc[:\s]+[a-z]\d{2}[a-z]{2}\d{2}/i)) {
    issues.push('atc_code_full');
  }

  // Validar longitud razonable de pregunta
  if (question.question.length > 350) {
    issues.push('question_too_long');
  }

  if (question.question.length < 20) {
    issues.push('question_too_short');
  }

  // Validar explicación concisa (máximo 25 palabras)
  const explanationWords = question.explanation ? question.explanation.split(/\s+/).length : 0;
  if (explanationWords > 25) {
    issues.push('explanation_verbose');
  }

  if (explanationWords < 5) {
    issues.push('explanation_too_short');
  }

  // Validar que las opciones no sean idénticas
  const optionsText = question.options.map(o => o.substring(3).toLowerCase());
  const uniqueOptions = new Set(optionsText);
  if (uniqueOptions.size < 4) {
    issues.push('duplicate_options');
  }

  // Calcular score (100 - 15 puntos por cada issue)
  const score = Math.max(0, 100 - issues.length * 15);

  return {
    isValid: issues.length === 0,
    issues,
    score
  };
}

/**
 * POST-VALIDACIÓN AVANZADA (FASE 2)
 * Valida coherencia, plausibilidad de distractores y calidad general
 */
function advancedQuestionValidation(question, sourceChunks = []) {
  const issues = [];
  let score = 100;

  // 1. VALIDACIÓN DE COHERENCIA (índice correct)
  if (question.correct < 0 || question.correct > 3) {
    issues.push('invalid_correct_index');
    score -= 30;
  }

  // 2. VALIDACIÓN DE OPCIONES
  const options = question.options.map(o => o.substring(3).trim());

  // 2.1 Opciones muy cortas (probable error)
  const tooShort = options.filter(o => o.length < 5);
  if (tooShort.length > 0) {
    issues.push('options_too_short');
    score -= 15;
  }

  // 2.2 Opciones muy desbalanceadas en longitud
  const lengths = options.map(o => o.length);
  const maxLength = Math.max(...lengths);
  const minLength = Math.min(...lengths);
  if (maxLength > minLength * 3) {
    issues.push('unbalanced_option_lengths');
    score -= 10;
  }

  // 2.3 Detectar distractores absurdos (valores extremos)
  const questionLower = question.question.toLowerCase();
  if (questionLower.includes('temperatura') || questionLower.includes('°c')) {
    options.forEach(opt => {
      const optLower = opt.toLowerCase();
      // Detectar temperaturas absurdas: <-20°C o >60°C
      const tempMatch = optLower.match(/(-?\d+)\s*°?\s*c/i);
      if (tempMatch) {
        const temp = parseInt(tempMatch[1]);
        if (temp < -20 || temp > 60) {
          issues.push('absurd_temperature');
          score -= 20;
        }
      }
    });
  }

  // 3. VALIDACIÓN DE EXPLICACIÓN
  const explanation = question.explanation || '';

  // 3.1 Explicación con frases prohibidas (auto-referencias)
  const badPhrases = [
    'el texto dice', 'según el fragmento', 'la documentación indica', 'los apuntes',
    'el fragmento destaca', 'el fragmento indica', 'el fragmento establece',
    'en el texto', 'como indica el', 'según se establece'
  ];
  if (badPhrases.some(phrase => explanation.toLowerCase().includes(phrase))) {
    issues.push('explanation_bad_phrasing');
    score -= 15;  // Penalización aumentada
  }

  // 3.2 Explicación que no menciona conceptos clave de la pregunta
  const questionKeywords = extractKeywords(question.question);
  const explanationKeywords = extractKeywords(explanation);
  const overlap = questionKeywords.filter(k => explanationKeywords.includes(k)).length;
  if (overlap === 0 && questionKeywords.length > 2) {
    issues.push('explanation_unrelated');
    score -= 15;
  }

  // 4. VALIDACIÓN DE RESPUESTA CORRECTA EN SOURCE
  if (sourceChunks.length > 0) {
    const correctOption = options[question.correct];
    const sourceText = sourceChunks.join(' ').toLowerCase();

    // Extraer conceptos clave de la opción correcta
    const correctKeywords = extractKeywords(correctOption);
    const foundInSource = correctKeywords.filter(k => sourceText.includes(k.toLowerCase())).length;

    // Si menos del 30% de keywords están en el source, es sospechoso
    if (correctKeywords.length > 0 && (foundInSource / correctKeywords.length) < 0.3) {
      issues.push('answer_not_in_source');
      score -= 25;
    }
  }

  // 5. VALIDACIÓN ESPECÍFICA POR DIFICULTAD
  const difficulty = question.difficulty;
  const questionWords = question.question.split(/\s+/).length;

  if (difficulty === 'simple') {
    // Preguntas simples: 8-15 palabras
    if (questionWords > 20) {
      issues.push('simple_question_too_long');
      score -= 15;
    } else if (questionWords < 6) {
      issues.push('simple_question_too_short');
      score -= 10;
    }
  }

  if (difficulty === 'media') {
    // Preguntas medias: 15-25 palabras
    if (questionWords > 35) {
      issues.push('media_question_too_long');
      score -= 10;
    } else if (questionWords < 10) {
      issues.push('media_question_too_short');
      score -= 10;
    }
  }

  if (difficulty === 'elaborada') {
    // Preguntas elaboradas: 25-40 palabras
    if (questionWords < 20) {
      issues.push('elaborated_question_too_short');
      score -= 15;
    } else if (questionWords > 50) {
      issues.push('elaborated_question_too_long');
      score -= 10;
    }

    // Opciones deben ser detalladas
    const avgOptionLength = options.reduce((sum, o) => sum + o.length, 0) / 4;
    if (avgOptionLength < 30) {
      issues.push('elaborated_options_too_simple');
      score -= 10;
    }
  }

  // 6. BONUS: Pregunta excelente
  if (score >= 95) {
    issues.push('excellent_quality');
  }

  return {
    isValid: score >= 65, // 🔴 FIX: Umbral reducido de 70 a 65 para reducir desperdicio de API
    issues,
    score: Math.max(0, score),
    warnings: issues.filter(i => !i.startsWith('excellent'))
  };
}

/**
 * Extrae keywords relevantes de un texto (excluye palabras comunes)
 */
function extractKeywords(text) {
  const stopWords = new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'a', 'al',
    'que', 'es', 'por', 'para', 'con', 'se', 'y', 'o', 'según', 'cual',
    'cuales', 'cuál', 'cuáles', 'qué', 'como', 'cómo'
  ]);

  return text
    .toLowerCase()
    .replace(/[^\w\sáéíóúñ]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word));
}

// ========================
// SISTEMA DE CHUNKS ESPACIADOS
// ========================

function selectSpacedChunks(userId, topicId, chunks, count = 2) {
  const totalChunks = chunks.length;

  if (totalChunks === 0) {
    console.error('❌ No hay chunks disponibles');
    return [];
  }

  // Obtener chunks ya usados
  const usedStmt = db.db.prepare(`
    SELECT chunk_index
    FROM chunk_usage
    WHERE user_id = ? AND topic_id = ?
  `);
  const usedChunks = usedStmt.all(userId, topicId).map(r => r.chunk_index);

  // Crear array de disponibles
  let available = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!usedChunks.includes(i)) {
      available.push(i);
    }
  }

  // Si no hay suficientes disponibles, resetear
  if (available.length < count) {
    console.log(`♻️ Usuario ${userId} completó chunks del tema ${topicId}. Reseteando...`);
    db.resetChunkUsage(userId, topicId);
    available = Array.from({length: totalChunks}, (_, i) => i);
  }

  const selected = [];

  if (totalChunks === 1) {
    // Caso especial: solo 1 chunk disponible
    selected.push(0);
    return selected;
  }

  // Calcular distancia mínima (50% del total de chunks - mayor separación = conceptos más diversos)
  const minDistance = Math.max(3, Math.floor(totalChunks * 0.5));

  // Seleccionar primer chunk aleatorio
  const firstIdx = available[Math.floor(Math.random() * available.length)];
  selected.push(firstIdx);

  if (count === 1) {
    return selected;
  }

  // Seleccionar segundo chunk con distancia mínima
  const validForSecond = available.filter(idx =>
    Math.abs(idx - firstIdx) >= minDistance
  );

  if (validForSecond.length > 0) {
    // Hay chunks a suficiente distancia
    const secondIdx = validForSecond[Math.floor(Math.random() * validForSecond.length)];
    selected.push(secondIdx);
  } else {
    // No hay suficiente distancia: seleccionar el más lejano posible
    const others = available.filter(idx => idx !== firstIdx);
    if (others.length > 0) {
      const farthest = others.reduce((prev, curr) =>
        Math.abs(curr - firstIdx) > Math.abs(prev - firstIdx) ? curr : prev
      );
      selected.push(farthest);
    } else {
      // Último recurso: usar el mismo chunk (edge case)
      selected.push(firstIdx);
    }
  }

  const distance = selected.length === 2 ? Math.abs(selected[1] - selected[0]) : 0;
  console.log(`📍 Chunks espaciados: [${selected.join(', ')}] de ${totalChunks} total (distancia: ${distance}, objetivo: ${minDistance})`);

  return selected;
}

// ========================
// VALIDACIÓN Y PARSING
// ========================

/**
 * Extrae y valida el texto de la respuesta de Claude
 * @throws Error si la respuesta es inválida o vacía
 */
function extractClaudeResponseText(response) {
  if (!response) {
    throw new Error('Respuesta de Claude es null o undefined');
  }

  if (!response.content || !Array.isArray(response.content) || response.content.length === 0) {
    throw new Error('Respuesta de Claude sin contenido válido');
  }

  const textContent = response.content[0]?.text;

  if (!textContent || typeof textContent !== 'string' || textContent.trim().length === 0) {
    throw new Error('Respuesta de Claude vacía o inválida');
  }

  return textContent;
}

function parseClaudeResponse(responseText) {
  // Log para debug (primeros 300 caracteres)
  console.log('📝 Response preview:', responseText.substring(0, 300).replace(/\n/g, ' '));

  try {
    // Intento 1: Parsear directamente
    const parsed = JSON.parse(responseText);
    console.log('✅ JSON parseado directamente');
    return parsed;
  } catch (error) {
    console.log('🔧 Extrayendo JSON con métodos alternativos...');

    // Intento 2: Buscar JSON en bloques de código markdown
    let jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                   responseText.match(/```\s*([\s\S]*?)\s*```/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        console.log('✅ JSON extraído de bloque markdown');
        return parsed;
      } catch (e) {
        console.log('⚠️ JSON de markdown incompleto, intentando reparar...');
        // Intentar completar JSON truncado
        let jsonStr = jsonMatch[1].trim();

        // Contar llaves para cerrar
        const openBraces = (jsonStr.match(/{/g) || []).length;
        const closeBraces = (jsonStr.match(/}/g) || []).length;
        const openBrackets = (jsonStr.match(/\[/g) || []).length;
        const closeBrackets = (jsonStr.match(/]/g) || []).length;

        // Cerrar estructuras abiertas
        for (let i = 0; i < (openBrackets - closeBrackets); i++) jsonStr += ']';
        for (let i = 0; i < (openBraces - closeBraces); i++) jsonStr += '}';

        try {
          const parsed = JSON.parse(jsonStr);
          console.log('✅ JSON reparado y parseado');
          return parsed;
        } catch (e2) {
          console.log('❌ No se pudo reparar JSON:', e2.message);
        }
      }
    }

    // Intento 3: Buscar objeto JSON más externo
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}');

    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      const jsonStr = responseText.substring(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        console.log('✅ JSON extraído por búsqueda de llaves');
        return parsed;
      } catch (e) {
        console.log('❌ JSON de llaves inválido:', e.message);
      }
    }

    // Intento 4: Extraer preguntas individuales completas (nuevo método robusto)
    const questionPattern = /{[\s\S]*?"question"\s*:\s*"([^"]*)"[\s\S]*?"options"\s*:\s*\[([\s\S]*?)\][\s\S]*?"correct"\s*:\s*(\d+)[\s\S]*?"explanation"\s*:\s*"([^"]*)"[\s\S]*?"difficulty"\s*:\s*"([^"]*)"[\s\S]*?"page_reference"\s*:\s*"([^"]*)"\s*}/g;
    const questions = [];
    let match;

    while ((match = questionPattern.exec(responseText)) !== null) {
      try {
        const optionsText = match[2];
        const options = [];
        const optionPattern = /"([^"]*)"/g;
        let optMatch;
        while ((optMatch = optionPattern.exec(optionsText)) !== null) {
          options.push(optMatch[1]);
        }

        if (options.length === 4) {
          questions.push({
            question: match[1],
            options: options,
            correct: parseInt(match[3]),
            explanation: match[4],
            difficulty: match[5],
            page_reference: match[6]
          });
        }
      } catch (e) {
        console.log('⚠️ Error extrayendo pregunta individual:', e.message);
      }
    }

    if (questions.length > 0) {
      console.log(`✅ Extraídas ${questions.length} pregunta(s) completa(s) mediante regex`);
      return { questions };
    }

    // 🔴 FIX: No generar preguntas de error técnico - retornar array vacío
    console.log('🚨 Todos los métodos de parsing fallaron - retornando array vacío');
    console.log('⚠️ Este contenido será omitido del examen');

    return {
      questions: []
    };
  }
}

// ========================
// SISTEMA DE DIVERSIDAD EN PROMPTS
// ========================
// Ángulos rotatorios para forzar variedad entre lotes sucesivos del mismo tema.
// En cada llamada a Claude se inyecta UNO al azar para sesgar el enfoque.
const DIVERSITY_ANGLES = [
  'normativa y legislación aplicable (leyes, RD, decretos, artículos)',
  'plazos, fechas, tiempos y periodos de validez',
  'porcentajes, cantidades, concentraciones y valores numéricos',
  'procedimientos paso a paso y secuencias operativas',
  'responsabilidades profesionales y competencias del técnico',
  'excepciones, casos especiales y contraindicaciones',
  'clasificaciones, categorías y tipologías',
  'criterios de decisión y toma de decisiones clínicas',
  'condiciones de almacenamiento, conservación y estabilidad',
  'seguridad, prevención de riesgos y medidas de protección',
  'etiquetado, identificación e información al usuario',
  'documentación, registros y trazabilidad',
  'diferencias conceptuales y matices terminológicos',
  'consecuencias, implicaciones y efectos derivados',
  'requisitos técnicos, materiales e instrumentación necesaria',
  'interacciones, incompatibilidades y contraindicaciones',
  'control de calidad, verificación y validación',
  'situaciones de error, incidencias y su gestión'
];

function pickDiversityAngle() {
  return DIVERSITY_ANGLES[Math.floor(Math.random() * DIVERSITY_ANGLES.length)];
}

/**
 * Construye la sección "PREGUNTAS RECIENTES A EVITAR" que se inyecta en el prompt.
 * Si no hay preguntas recientes, devuelve cadena vacía (no ruido en el prompt).
 */
function buildRecentQuestionsSection(recentTexts) {
  if (!recentTexts || recentTexts.length === 0) return '';
  const trimmed = recentTexts
    .slice(0, 8)
    .map(t => {
      const clean = t.replace(/\s+/g, ' ').trim();
      return clean.length > 180 ? clean.substring(0, 180) + '…' : clean;
    })
    .map(t => `• ${t}`)
    .join('\n');
  return `\nPREGUNTAS RECIENTES DEL USUARIO (NO REPITAS CONCEPTO, ENFOQUE NI FORMA):\n${trimmed}\n`;
}

/**
 * Renderiza un prompt sustituyendo todos los placeholders (chunks + diversidad).
 * userId y topicId son opcionales: si están disponibles se consultan preguntas recientes
 * del usuario para ese tema y se inyectan como "EVITAR REPETIR".
 */
function renderPrompt(promptTemplate, chunk1, chunk2, userId = null, topicId = null) {
  const diversityAngle = pickDiversityAngle();
  let recentQuestionsSection = '';
  if (userId && topicId) {
    try {
      const recentTexts = db.getRecentQuestionTexts(userId, topicId, 8);
      recentQuestionsSection = buildRecentQuestionsSection(recentTexts);
    } catch (err) {
      console.warn('⚠️ No se pudieron obtener preguntas recientes:', err.message);
    }
  }
  return promptTemplate
    .replace('{{CHUNK_1}}', chunk1)
    .replace('{{CHUNK_2}}', chunk2)
    .replace('{{DIVERSITY_ANGLE}}', diversityAngle)
    .replace('{{RECENT_QUESTIONS}}', recentQuestionsSection);
}

// PROMPTS OPTIMIZADOS - 3 NIVELES: Simple (20%), Media (60%), Elaborada (20%)

// PROMPT SIMPLE (20% - Genera 2 preguntas, 1 por fragmento) - PREGUNTAS DIRECTAS
const CLAUDE_PROMPT_SIMPLE = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.

OBJETIVO: Genera 2 preguntas SIMPLES (1 por fragmento, conceptos DIFERENTES). Evalúan memorización de datos objetivos EXTRAÍDOS LITERALMENTE del fragmento.

🎯 ÁNGULO DE ESTE LOTE (obligatorio aplicar al menos a 1 de las 2 preguntas):
{{DIVERSITY_ANGLE}}
{{RECENT_QUESTIONS}}
DIVERSIDAD CONCEPTUAL OBLIGATORIA:
• Las 2 preguntas deben tratar ASPECTOS COMPLETAMENTE DIFERENTES del contenido
• PROHIBIDO repetir el mismo concepto, la misma entidad o el mismo verbo principal en ambas preguntas
• Si los dos fragmentos hablan del MISMO concepto central, enfoca cada pregunta en sub-aspectos radicalmente distintos (ej: temperatura vs normativa; responsabilidad vs procedimiento)
• PROHIBIDO replicar conceptos/formulaciones de las "PREGUNTAS RECIENTES" listadas arriba (si las hay)

=== FRAGMENTO 1 ===
{{CHUNK_1}}

=== FRAGMENTO 2 ===
{{CHUNK_2}}

CALIDAD EXIGIDA:
• La pregunta debe apoyarse en un DATO ESPECÍFICO presente en el fragmento (cifra, artículo, nombre propio, plazo, porcentaje, término técnico concreto)
• PROHIBIDO hacer preguntas genéricas tipo "¿Qué es X?" o "¿Para qué sirve Y?" si el fragmento permite algo más preciso
• PROHIBIDO inventar datos ausentes del fragmento
• La referencia (page_reference) debe citar artículo/sección/norma concreta del fragmento

ESTILO DE REDACCIÓN (VARÍA entre las 2 preguntas):
   • Variante A (directa normativa): "¿Cuál/Qué [dato] establece [normativa]?"
   • Variante B (con contexto breve 6-10 palabras): "En [situación], ¿qué [dato/plazo/requisito] aplica?"
   • Variante C (identificación): "¿Cuál de las siguientes [características/requisitos] corresponde a [entidad]?"
   • Variante D (excepción): "¿Cuál NO es [característica/requisito] de [entidad]?"
   • Las 2 preguntas deben usar variantes DIFERENTES
   • PROHIBIDO narrativas ficticias ("Un técnico...", "Recibes...")

DISTRACTORES SOFISTICADOS (5 trampas, usa 2-3 diferentes en cada pregunta):
   a) Error contexto cercano: dato correcto de OTRO caso relacionado del mismo tema
   b) Error numérico: cifra próxima al valor correcto
   c) Mezcla conceptual: elementos de dos situaciones reales
   d) Error común del alumno: "suena lógico" pero es incorrecto
   e) Precisión incorrecta: rango casi correcto con un detalle erróneo
   → Los 3 distractores deben ser PLAUSIBLES y requerir conocer el dato exacto

LONGITUD OPCIONES (CRÍTICO):
   • TODAS las opciones con longitud SIMILAR (±25% caracteres)
   • Ligera variación permitida, alternando (50/50) si la correcta es la más larga o la más corta
   • La longitud NUNCA debe ser pista

EXPLICACIÓN (una INDEPENDIENTE por pregunta):
   • Formato: "**Normativa/Concepto:** dato específico."
   • Máximo 12 palabras en el dato
   • NO mencionar "Fragmento 1" ni "Fragmento 2"
   • 💡 Añadir "*Razón:* porqué" (máx 5 palabras) SOLO si aporta contexto NUEVO (riesgo, implicación clínica). NUNCA repetir la información ya dada

EJEMPLO VÁLIDO:
{
  "question": "¿Cuál es el plazo máximo de validez de fórmulas magistrales acuosas sin conservantes según RD 1345/2007?",
  "options": ["A) 7 días condiciones normales", "B) 7 días entre 2-8°C", "C) 10 días entre 2-8°C con conservantes", "D) 5 días entre 2-8°C sin conservantes"],
  "correct": 1,
  "explanation": "**RD 1345/2007 Art. 8.3:** 7 días máx entre 2-8°C.\n\n💡 *Razón:* Riesgo microbiano sin conservantes.",
  "difficulty": "simple",
  "page_reference": "RD 1345/2007 Art. 8.3"
}

JSON ESTRICTO: {"questions":[{"question":"","options":["A) ","B) ","C) ","D) "],"correct":0,"explanation":"","difficulty":"simple","page_reference":""}]}`;

// PROMPT MEDIA (60% - Genera 2 preguntas, 1 por fragmento) - NIVEL INTERMEDIO
const CLAUDE_PROMPT_MEDIA = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.

OBJETIVO: Genera 2 preguntas MEDIAS (1 por fragmento, TIPOS y CONCEPTOS DIFERENTES). Evalúan comprensión y aplicación, NO memorización literal.

🎯 ÁNGULO DE ESTE LOTE (obligatorio aplicar al menos a 1 de las 2 preguntas):
{{DIVERSITY_ANGLE}}
{{RECENT_QUESTIONS}}
DIVERSIDAD CONCEPTUAL OBLIGATORIA:
• Las 2 preguntas deben abordar ASPECTOS COMPLETAMENTE DIFERENTES del contenido
• PROHIBIDO repetir el mismo concepto central, la misma entidad o el mismo verbo principal en ambas preguntas
• PROHIBIDO replicar conceptos/formulaciones de las "PREGUNTAS RECIENTES" listadas arriba (si las hay)
• Ambas preguntas deben usar TIPOS DIFERENTES de la lista de 15 (ver abajo)

=== FRAGMENTO 1 ===
{{CHUNK_1}}

=== FRAGMENTO 2 ===
{{CHUNK_2}}

15 TIPOS DE PREGUNTA (elige 2 DIFERENTES, uno para cada fragmento):
A-DESCRIPTIVAS: 1)Características/Propiedades 2)Funciones/Objetivos 3)Requisitos/Condiciones
B-PROCEDIMENTALES: 4)Procedimientos/Protocolos 5)Secuencias 6)Criterios de decisión
C-ANALÍTICAS: 7)Clasificaciones 8)Comparaciones/Diferencias 9)Causa-Efecto
D-APLICATIVAS: 10)Aplicación normativa 11)Indicaciones/Contraindicaciones 12)Identificación de errores
E-EVALUATIVAS: 13)Interpretación de datos 14)Priorización 15)Excepciones

CALIDAD EXIGIDA:
• Cada pregunta debe exigir COMPRENSIÓN (no solo recuerdo) - aplicar, comparar, interpretar, decidir
• Apoyarse en DATOS ESPECÍFICOS del fragmento: artículos, plazos, porcentajes, términos técnicos propios, nombres de protocolos
• PROHIBIDO preguntas vagas tipo "¿Qué es...?" o "¿Para qué sirve...?"
• PROHIBIDO inventar datos que no estén en el fragmento
• page_reference debe citar artículo/sección/protocolo concreto

ESTILO DE REDACCIÓN (VARÍA entre las 2 preguntas):
   • Variante A (directa normativa): "¿Qué/Cómo [aspecto] establece [normativa/protocolo]?"
   • Variante B (contexto breve 8-12 palabras): "En [situación concreta], ¿qué [aspecto] se aplica?"
   • Variante C (condicional/aplicativa): "Si [condición realista], ¿qué [consecuencia/acción] corresponde?"
   • Variante D (negativa): "¿Cuál de las siguientes NO forma parte de [concepto]?"
   • Variante E (ordenación): "¿En qué orden se realiza [proceso]?"
   • Las 2 preguntas deben usar variantes DIFERENTES
   • PROHIBIDO narrativas ficticias ("Un técnico...", "Recibes...")

DISTRACTORES SOFISTICADOS (7 tipos, usa 2-3 diferentes por pregunta):
   a) Respuesta parcial: correcta pero omite un elemento crítico
   b) Procedimiento relacionado: pasos de OTRO protocolo parecido
   c) Exceso/defecto de requisitos: intensidad o alcance inadecuados
   d) Mezcla de elementos: fragmentos de dos procedimientos distintos
   e) Inversión del orden lógico: secuencia equivocada
   f) Error de ámbito normativo: norma correcta pero de contexto distinto
   g) Confusión terminológica: término similar pero incorrecto
   → Requieren dominio completo, NO deducibles por sentido común

LONGITUD OPCIONES (CRÍTICO):
   • TODAS similares (±25% caracteres)
   • Ligera variación permitida alternando (50/50) si la correcta es la más larga o la más corta
   • La longitud NUNCA debe ser pista

EXPLICACIÓN (una INDEPENDIENTE por pregunta):
   • Formato: "**Normativa/Protocolo:** dato específico."
   • Máximo 13 palabras en el dato
   • NO mencionar "Fragmento 1" ni "Fragmento 2"
   • 💡 "*Razón:* porqué" (máx 6 palabras) SOLO si aporta lógica operativa o implicación práctica NUEVA. NUNCA repetir

JSON ESTRICTO: {"questions":[{"question":"","options":["A) ","B) ","C) ","D) "],"correct":0,"explanation":"","difficulty":"media","page_reference":""}]}`;

// PROMPT ELABORADA (20% - Genera 2 preguntas, 1 por fragmento) - NIVEL AVANZADO
const CLAUDE_PROMPT_ELABORADA = `Eres evaluador experto OPOSICIONES Técnico Farmacia SERGAS.

OBJETIVO: Genera 2 preguntas ELABORADAS (1 por fragmento, TIPOS y CONCEPTOS DIFERENTES). Requieren análisis profundo, integración de conceptos y razonamiento complejo.

🎯 ÁNGULO DE ESTE LOTE (obligatorio aplicar al menos a 1 de las 2 preguntas):
{{DIVERSITY_ANGLE}}
{{RECENT_QUESTIONS}}
DIVERSIDAD CONCEPTUAL OBLIGATORIA:
• Las 2 preguntas deben tratar ASPECTOS COMPLETAMENTE DIFERENTES
• PROHIBIDO repetir concepto central, entidad o verbo principal entre las 2 preguntas
• PROHIBIDO replicar conceptos/formulaciones de las "PREGUNTAS RECIENTES" listadas arriba (si las hay)
• Cada pregunta debe integrar 2+ conceptos del fragmento

=== FRAGMENTO 1 ===
{{CHUNK_1}}

=== FRAGMENTO 2 ===
{{CHUNK_2}}

10 TIPOS (elige 2 DIFERENTES para las 2 preguntas):
1)Análisis de criterios múltiples 2)Integración de conceptos 3)Evaluación de situaciones complejas 4)Comparación multi-criterio 5)Cadena de consecuencias 6)Procedimientos multi-paso 7)Análisis de excepciones 8)Síntesis normativa multi-requisito 9)Conflictos normativos 10)Análisis de impacto

CALIDAD EXIGIDA:
• Pregunta basada en DATOS ESPECÍFICOS del fragmento (artículos, plazos, valores, términos técnicos)
• Requiere ANÁLISIS: comparar, priorizar, integrar o decidir entre alternativas realistas
• PROHIBIDO inventar datos ausentes del fragmento
• PROHIBIDO preguntas triviales o de mera definición
• page_reference debe citar artículo/sección/protocolo concreto

ESTILO:
   • 60% contexto FUNCIONAL (10-18 palabras): "En [situación técnica compleja], ¿qué [análisis/decisión] procede?"
   • 40% directa compleja: "¿Qué [combinación de criterios/relación] [resultado]?"
   • Contexto SIEMPRE funcional (necesario para el razonamiento), NUNCA decorativo
   • PROHIBIDO narrativas ficticias

DISTRACTORES AVANZADOS (7 tipos, usa 2-3 por pregunta):
   a) Respuesta parcial: omite elementos críticos
   b) Práctica habitual no normativa: común pero técnicamente incorrecta
   c) Sobre-requisito: añade criterios no exigidos
   d) Confusión normativa: legislación similar pero incorrecta
   e) Secuencia incompleta: omite paso crítico
   f) Mezcla de escenarios: procedimientos de contextos distintos
   g) Criterio insuficiente: sólo uno de varios necesarios
   → Requieren DOMINIO PROFUNDO, no deducibles por lógica común

LONGITUD OPCIONES (CRÍTICO):
   • TODAS similares (±25% caracteres)
   • Ligera variación alternando (50/50) si la correcta es más larga o más corta
   • La longitud NUNCA debe ser pista

EXPLICACIÓN (una INDEPENDIENTE por pregunta):
   • Formato simple: "**Normativa:** dato."
   • Formato bullets si 3+ elementos: "**Normativa:**\n• Item1\n• Item2"
   • Máximo 15 palabras (20 si bullets)
   • 💡 "*Razón:* porqué" (máx 7 palabras) SOLO si aporta implicación crítica (seguridad/legal) NUEVA

JSON ESTRICTO: {"questions":[{"question":"","options":["A) ","B) ","C) ","D) "],"correct":0,"explanation":"","difficulty":"elaborada","page_reference":""}]}`;

// ========================
// FUNCIONES DE ARCHIVOS OPTIMIZADAS
// ========================

async function readFile(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.txt') {
      return await fs.readFile(filePath, 'utf8');
    }

    if (ext === '.pdf') {
      console.log(`📄 Extrayendo texto de PDF: ${path.basename(filePath)}`);
      const dataBuffer = fsSync.readFileSync(filePath);
      const data = await pdfParse(dataBuffer);
      console.log(`✅ PDF extraído: ${data.numpages} páginas, ${data.text.length} caracteres`);
      return data.text;
    }

    return '[FORMATO NO SOPORTADO]';
  } catch (error) {
    console.error(`❌ Error leyendo ${filePath}:`, error.message);
    throw error;
  }
}

async function ensureDocumentsDirectory() {
  try {
    await fs.access(DOCUMENTS_DIR);
  } catch (error) {
    console.log('📁 Creando directorio documents...');
    await fs.mkdir(DOCUMENTS_DIR, { recursive: true });
  }
}

// Función para dividir contenido en chunks OPTIMIZADO (1000 caracteres = balance calidad/coste)
function splitIntoChunks(content, chunkSize = 1000) {
  const chunks = [];
  const lines = content.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    // Si agregar esta línea excede el tamaño del chunk, guardar el chunk actual
    if (currentChunk.length + line.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += line + '\n';
  }

  // Agregar el último chunk si tiene contenido
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

async function getDocumentsByTopics(topics) {
  // Para un solo tema, intentar usar caché
  if (topics.length === 1) {
    const topicId = topics[0];
    const cached = documentsCache.get(topicId);

    // Si está en caché y no ha expirado, retornar inmediatamente
    if (cached && (Date.now() - cached.timestamp < DOCUMENT_CACHE_TTL)) {
      console.log(`💾 Contenido de ${topicId} desde caché (${Math.round((Date.now() - cached.timestamp) / 1000)}s)`);
      return cached.content;
    }
  }

  // Si no está en caché o es multi-tema, leer del disco
  let allContent = '';
  let successCount = 0;

  for (const topic of topics) {
    const topicConfig = TOPIC_CONFIG[topic];
    if (!topicConfig) continue;

    allContent += `\n\n=== ${topicConfig.title} ===\n\n`;

    for (const fileName of topicConfig.files) {
      const filePath = path.join(DOCUMENTS_DIR, fileName);

      try {
        const content = await readFile(filePath);
        if (content && !content.includes('[FORMATO NO SOPORTADO')) {
          allContent += `${content}\n\n`;
          successCount++;
          console.log(`✅ Leído: ${fileName}`);
          break;
        }
      } catch (error) {
        console.log(`❌ Error: ${fileName}`);
        continue;
      }
    }
  }

  console.log(`📊 Archivos procesados: ${successCount}/${topics.length}`);

  // Si es un solo tema, guardarlo en caché
  if (topics.length === 1 && allContent.trim()) {
    const topicId = topics[0];
    documentsCache.set(topicId, {
      content: allContent,
      timestamp: Date.now()
    });
    console.log(`💾 Contenido de ${topicId} guardado en caché`);
  }

  return allContent;
}

// Nueva función para obtener chunks aleatorios de documentos
async function getRandomChunkFromTopics(topics) {
  const allContent = await getDocumentsByTopics(topics);

  if (!allContent.trim()) {
    return null;
  }

  // Dividir en chunks de ~1200 caracteres (optimizado para costos)
  const chunks = splitIntoChunks(allContent, 1200);

  console.log(`📄 Documento dividido en ${chunks.length} chunks`);

  if (chunks.length === 0) {
    return allContent.substring(0, 3000);
  }

  // Seleccionar un chunk aleatorio
  const randomIndex = Math.floor(Math.random() * chunks.length);
  const selectedChunk = chunks[randomIndex];

  console.log(`🎲 Chunk aleatorio seleccionado: ${randomIndex + 1}/${chunks.length} (${selectedChunk.length} caracteres)`);

  return selectedChunk;
}

// ========================
// FUNCIONES DE ESTADÍSTICAS - AHORA EN DATABASE.JS
// ========================
// Las funciones de estadísticas y preguntas falladas ahora están en database.js
// usando SQLite para persistencia de datos por usuario

// ========================
// MIDDLEWARE DE AUTENTICACIÓN
// ========================

// Middleware para verificar si el usuario está autenticado
function requireAuth(req, res, next) {
  console.log('🔒 requireAuth - Session ID:', req.sessionID, '- User ID en sesión:', req.session?.userId);
  console.log('🔒 requireAuth - Cookie header:', req.headers.cookie);

  // Validar que la sesión existe
  if (!req.session || !req.session.userId) {
    console.log('❌ No hay sesión o userId - Rechazando petición');
    return res.status(401).json({
      error: 'Sesión expirada',
      requiresLogin: true,
      message: 'Tu sesión ha expirado. Por favor, inicia sesión de nuevo.'
    });
  }

  // Verificar tiempo restante de sesión y renovar automáticamente si es necesario
  try {
    // 🔴 FIX: Validar que req.session.cookie existe antes de acceder a _expires
    if (!req.session || !req.session.cookie) {
      console.warn('⚠️ Cookie de sesión no existe, sesión corrupta');
      return res.status(401).json({
        error: 'Sesión inválida',
        requiresLogin: true,
        message: 'Tu sesión es inválida. Por favor, inicia sesión de nuevo.'
      });
    }

    const expiresAt = req.session.cookie._expires;
    const now = Date.now();

    // 🔴 FIX: Validar que _expires existe y es válido
    if (!expiresAt) {
      console.warn('⚠️ Cookie de sesión sin _expires, asumiendo expirada');
      return res.status(401).json({
        error: 'Sesión inválida',
        requiresLogin: true,
        message: 'Tu sesión es inválida. Por favor, inicia sesión de nuevo.'
      });
    }

    const timeLeft = expiresAt - now;

    // Si quedan menos de 5 minutos, renovar sesión automáticamente
    if (timeLeft > 0 && timeLeft < 5 * 60 * 1000) {
      console.log('🔄 Renovando sesión automáticamente (quedan', Math.round(timeLeft / 1000), 'segundos)');
      req.session.touch();
    }

    // Si la sesión ya expiró
    if (timeLeft <= 0) {
      console.log('❌ Sesión expirada completamente');
      return res.status(401).json({
        error: 'Sesión expirada',
        requiresLogin: true,
        message: 'Tu sesión ha expirado. Por favor, inicia sesión de nuevo.'
      });
    }
  } catch (error) {
    console.error('Error verificando expiración de sesión:', error);
    // Continuar aunque falle la verificación de tiempo
  }

  // Verificar que el usuario existe y está activo
  const user = db.getUserById(req.session.userId);

  if (!user) {
    console.log('❌ Usuario no encontrado en DB');
    // Destruir sesión inválida de forma segura
    if (req.session && typeof req.session.destroy === 'function') {
      req.session.destroy();
    }
    return res.status(401).json({
      error: 'Usuario no encontrado',
      requiresLogin: true,
      message: 'Tu cuenta ya no existe. Por favor, contacta al administrador.'
    });
  }

  // NOTA: Control de sesiones simultáneas DESACTIVADO temporalmente
  // Causaba problemas con sesiones existentes - necesita reimplementación más robusta

  if (user.estado === 'bloqueado') {
    console.log('❌ Usuario bloqueado:', user.username);
    return res.status(403).json({
      error: 'Cuenta bloqueada',
      message: 'Tu cuenta está pendiente de activación por el administrador. Por favor, contacta a través de correo para activar tu cuenta.',
      requiresActivation: true,
      contactInfo: process.env.ADMIN_CONTACT || 'Contacta al administrador'
    });
  }

  console.log('✅ requireAuth OK - Usuario:', user.username);
  req.user = user;

  // Actualizar último acceso en cada petición autenticada
  try {
    db.updateLastAccess(user.id);
  } catch (error) {
    console.error('Error actualizando last_access:', error);
    // No bloqueamos la petición si falla la actualización
  }

  next();
}

// Middleware para verificar si es admin
function requireAdmin(req, res, next) {
  const adminPassword = process.env.ADMIN_PASSWORD;

  // SEGURIDAD: Validar que ADMIN_PASSWORD está configurado en producción
  if (!adminPassword) {
    console.error('🚨 ADMIN_PASSWORD no está configurado en variables de entorno');
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).json({ error: 'Configuración de servidor inválida' });
    }
    // En desarrollo, usar password por defecto pero avisar
    console.warn('⚠️ Usando password por defecto en desarrollo. NUNCA uses esto en producción.');
  }

  const providedPassword = req.headers['x-admin-password'];

  if (providedPassword !== (adminPassword || 'admin123')) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }

  next();
}

// ========================
// RUTAS DE AUTENTICACIÓN
// ========================

// Ruta principal - redirige a login si no está autenticado
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Registro de usuario
app.post('/api/auth/register', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password requeridos' });
    }

    if (username.length < 3) {
      return res.status(400).json({ error: 'Username debe tener al menos 3 caracteres' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password debe tener al menos 6 caracteres' });
    }

    const result = db.createUser(username, password);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Auto-login después de registro (pero cuenta queda bloqueada)
    req.session.userId = result.userId;
    res.json({
      success: true,
      message: 'Usuario creado. Cuenta bloqueada hasta activación del administrador.',
      requiresActivation: true
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

// Login
app.post('/api/auth/login', authLimiter, (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('🔑 Intento de login - Usuario:', username);

    if (!username || !password) {
      console.log('❌ Faltan credenciales');
      return res.status(400).json({ error: 'Username y password requeridos' });
    }

    const result = db.authenticateUser(username, password);

    if (!result.success) {
      console.log('❌ Login fallido:', result.error);
      return res.status(401).json({ error: result.error });
    }

    // Guardar en sesión
    req.session.userId = result.user.id;

    // Forzar guardado de sesión
    req.session.save((err) => {
      if (err) {
        console.error('❌ Error guardando sesión:', err);
        return res.status(500).json({ error: 'Error guardando sesión' });
      }

      console.log('✅ Login exitoso - Usuario ID:', result.user.id, '- Session ID:', req.sessionID);
      console.log('📦 Sesión guardada:', { userId: req.session.userId, sessionID: req.sessionID });
      console.log('🍪 Cookie que se enviará:', req.session.cookie);

      res.json({
        success: true,
        user: {
          id: result.user.id,
          username: result.user.username
        }
      });
    });

  } catch (error) {
    console.error('❌ Error en login (excepción):', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  // Destruir sesión
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Error al cerrar sesión' });
    }
    res.json({ success: true });
  });
});

// Verificar sesión
app.get('/api/auth/check', (req, res) => {
  console.log('🔐 Verificando sesión - Session ID:', req.sessionID, '- User ID:', req.session.userId);

  if (!req.session.userId) {
    console.log('❌ No hay userId en la sesión');
    return res.json({ authenticated: false });
  }

  const user = db.getUserById(req.session.userId);

  if (!user) {
    console.log('❌ Usuario no encontrado en DB');
    req.session.destroy();
    return res.json({ authenticated: false });
  }

  if (user.estado === 'bloqueado') {
    console.log('⚠️ Usuario bloqueado:', user.username);
    return res.json({
      authenticated: true,
      blocked: true,
      message: 'Cuenta bloqueada. Contacta al administrador.'
    });
  }

  console.log('✅ Sesión válida para usuario:', user.username);
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      username: user.username
    }
  });
});

// ========================
// RUTAS DE ADMINISTRACIÓN
// ========================

// Obtener todos los usuarios (requiere admin)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Error obteniendo usuarios:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// Crear usuario (admin)
app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password requeridos' });
    }

    const result = db.createUser(username, password);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, userId: result.userId });
  } catch (error) {
    console.error('Error creando usuario:', error);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// ========================
// FUNCIONES AUXILIARES DE VALIDACIÓN
// ========================

// Validar y parsear userId de parámetros de ruta
function parseUserId(idString) {
  const userId = parseInt(idString);
  if (isNaN(userId) || userId <= 0) {
    throw new Error('ID de usuario inválido');
  }
  return userId;
}

// ========================
// ENDPOINTS DE ADMIN
// ========================

// Activar usuario
app.post('/api/admin/users/:id/activate', requireAdmin, (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    db.activateUser(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error activando usuario:', error);
    res.status(500).json({ error: 'Error al activar usuario' });
  }
});

// Bloquear usuario
app.post('/api/admin/users/:id/block', requireAdmin, (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    db.blockUser(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error bloqueando usuario:', error);
    res.status(500).json({ error: 'Error al bloquear usuario' });
  }
});

// Bloquear todos los usuarios
app.post('/api/admin/users/block-all', requireAdmin, (req, res) => {
  try {
    const result = db.blockAllUsers();
    res.json({ success: true, count: result.count });
  } catch (error) {
    console.error('Error bloqueando usuarios:', error);
    res.status(500).json({ error: 'Error al bloquear usuarios' });
  }
});

// Obtener estadísticas completas (admin)
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const stats = db.getAdminStats();
    res.json(stats);
  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Obtener actividad detallada de un usuario (admin)
app.get('/api/admin/users/:id/activity', requireAdmin, (req, res) => {
  try {
    const userId = parseUserId(req.params.id);

    const questionsPerDay = db.getUserQuestionsPerDay(userId, 30);
    const questionsPerMonth = db.getUserQuestionsPerMonth(userId, 6);
    const sessionTime = db.getUserAverageSessionTime(userId);
    const recentActivity = db.getUserActivity(userId, 50);

    res.json({
      questionsPerDay,
      questionsPerMonth,
      sessionTime,
      recentActivity
    });
  } catch (error) {
    console.error('Error obteniendo actividad:', error);
    res.status(500).json({ error: 'Error al obtener actividad' });
  }
});

// Obtener actividad de hoy (admin)
app.get('/api/admin/today', requireAdmin, (req, res) => {
  try {
    const today = db.getTodayActivity();
    res.json(today);
  } catch (error) {
    console.error('Error obteniendo actividad de hoy:', error);
    res.status(500).json({ error: 'Error al obtener actividad de hoy' });
  }
});

// Exportar datos de un usuario específico a Excel
app.get('/api/admin/export/user/:id', requireAdmin, (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    const users = db.getAdminStats();
    const user = users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Obtener actividad detallada
    const questionsPerDay = db.getUserQuestionsPerDay(userId, 30);
    const questionsPerMonth = db.getUserQuestionsPerMonth(userId);

    // Preparar datos para Excel
    const mainData = [{
      'ID': user.id,
      'Usuario': user.username,
      'Estado': user.estado.toUpperCase(),
      'Registrado': new Date(user.created_at).toLocaleDateString('es-ES'),
      'Preguntas Totales': user.total_questions,
      'Respuestas Correctas': user.correct_answers,
      'Precisión (%)': Math.round(user.avg_accuracy * 10) / 10,
      'Último Acceso': new Date(user.last_access).toLocaleString('es-ES')
    }];

    // Crear libro de Excel
    const wb = XLSX.utils.book_new();

    // Hoja 1: Datos principales
    const ws1 = XLSX.utils.json_to_sheet(mainData);
    XLSX.utils.book_append_sheet(wb, ws1, 'Datos Usuario');

    // Hoja 2: Actividad por día (últimos 30 días)
    if (questionsPerDay.length > 0) {
      const dailyData = questionsPerDay.map(day => ({
        'Fecha': new Date(day.date).toLocaleDateString('es-ES'),
        'Preguntas': day.count
      }));
      const ws2 = XLSX.utils.json_to_sheet(dailyData);
      XLSX.utils.book_append_sheet(wb, ws2, 'Actividad Diaria');
    }

    // Hoja 3: Actividad por mes
    if (questionsPerMonth.length > 0) {
      const monthlyData = questionsPerMonth.map(month => ({
        'Mes': month.month,
        'Preguntas': month.count
      }));
      const ws3 = XLSX.utils.json_to_sheet(monthlyData);
      XLSX.utils.book_append_sheet(wb, ws3, 'Actividad Mensual');
    }

    // Generar buffer y enviar
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `usuario_${user.username}_${Date.now()}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exportando usuario a Excel:', error);
    res.status(500).json({ error: 'Error al exportar datos' });
  }
});

// Exportar todos los usuarios a Excel
app.get('/api/admin/export/all', requireAdmin, (req, res) => {
  try {
    const users = db.getAdminStats();

    // Preparar datos para Excel
    const data = users.map(user => ({
      'ID': user.id,
      'Usuario': user.username,
      'Estado': user.estado.toUpperCase(),
      'Registrado': new Date(user.created_at).toLocaleDateString('es-ES'),
      'Preguntas Totales': user.total_questions,
      'Respuestas Correctas': user.correct_answers,
      'Precisión (%)': Math.round(user.avg_accuracy * 10) / 10,
      'Último Acceso': new Date(user.last_access).toLocaleString('es-ES')
    }));

    // Crear libro y hoja de Excel
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);

    // Ajustar ancho de columnas
    ws['!cols'] = [
      { wch: 5 },   // ID
      { wch: 15 },  // Usuario
      { wch: 12 },  // Estado
      { wch: 12 },  // Registrado
      { wch: 15 },  // Preguntas Totales
      { wch: 18 },  // Respuestas Correctas
      { wch: 15 },  // Precisión
      { wch: 20 }   // Último Acceso
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Todos los Usuarios');

    // Generar buffer y enviar
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `todos_usuarios_${Date.now()}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exportando todos los usuarios a Excel:', error);
    res.status(500).json({ error: 'Error al exportar datos' });
  }
});

// ========================
// ENDPOINT: PRE-POBLAR CACHÉ
// ========================
// Genera 100 preguntas por tema para alcanzar 90% cache hit rate
// Uso: POST /api/admin/populate-cache con header "x-admin-password"
app.post('/api/admin/populate-cache', requireAdmin, async (req, res) => {
  try {
    const { topicId } = req.body;

    // Si se especifica un tema, solo ese; si no, todos
    const topicsToPopulate = topicId ? [topicId] : Object.keys(TOPIC_CONFIG);

    console.log(`🔥 Iniciando pre-población de caché para ${topicsToPopulate.length} tema(s)...`);

    // Responder inmediatamente (proceso en background)
    res.json({
      success: true,
      message: `Pre-población iniciada para ${topicsToPopulate.length} tema(s)`,
      topics: topicsToPopulate,
      estimatedTime: `${topicsToPopulate.length * 8}-${topicsToPopulate.length * 12} minutos`
    });

    // Ejecutar en background (no await aquí para no bloquear)
    (async () => {
      const ADMIN_USER_ID = 0; // Usuario especial para cache global
      const TARGET_PER_TOPIC = 100; // 100 preguntas por tema
      const TARGET_SIMPLE = 20;
      const TARGET_MEDIA = 60;
      const TARGET_ELABORADA = 20;

      for (const currentTopic of topicsToPopulate) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🎯 Pre-poblando caché: ${currentTopic}`);
        console.log(`${'='.repeat(60)}`);

        try {
          // Obtener contenido del tema
          const topicContent = await getDocumentsByTopics([currentTopic]);
          if (!topicContent) {
            console.error(`❌ No hay contenido para tema: ${currentTopic}`);
            continue;
          }

          const chunks = splitIntoChunks(topicContent, 1000);
          console.log(`📄 ${chunks.length} chunks disponibles para ${currentTopic}`);

          // Generar preguntas simples (20)
          console.log(`\n⚪ Generando ${TARGET_SIMPLE} preguntas SIMPLES...`);
          for (let i = 0; i < Math.ceil(TARGET_SIMPLE / 2); i++) {
            const chunk1Index = Math.floor(Math.random() * chunks.length);
            const chunk2Index = Math.floor(Math.random() * chunks.length);
            const chunk1 = chunks[chunk1Index];
            const chunk2 = chunks[chunk2Index];

            const fullPrompt = renderPrompt(CLAUDE_PROMPT_SIMPLE, chunk1, chunk2, ADMIN_USER_ID, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.simple, 'simple', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.forEach(q => {
                  const validation = validateQuestionQuality(q);
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(ADMIN_USER_ID, currentTopic, 'simple', q, 'populate');
                    console.log(`  ✓ Simple guardada (score: ${finalScore})`);
                  }
                });
              }
            } catch (error) {
              console.error(`  ❌ Error generando simples: ${error.message}`);
            }
          }

          // Generar preguntas medias (60)
          console.log(`\n🔵 Generando ${TARGET_MEDIA} preguntas MEDIAS...`);
          for (let i = 0; i < Math.ceil(TARGET_MEDIA / 2); i++) {
            const chunk1Index = Math.floor(Math.random() * chunks.length);
            const chunk2Index = Math.floor(Math.random() * chunks.length);
            const chunk1 = chunks[chunk1Index];
            const chunk2 = chunks[chunk2Index];

            const fullPrompt = renderPrompt(CLAUDE_PROMPT_MEDIA, chunk1, chunk2, ADMIN_USER_ID, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.media, 'media', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.forEach(q => {
                  const validation = validateQuestionQuality(q);
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(ADMIN_USER_ID, currentTopic, 'media', q, 'populate');
                    console.log(`  ✓ Media guardada (score: ${finalScore})`);
                  }
                });
              }
            } catch (error) {
              console.error(`  ❌ Error generando medias: ${error.message}`);
            }
          }

          // Generar preguntas elaboradas (20)
          console.log(`\n🔴 Generando ${TARGET_ELABORADA} preguntas ELABORADAS...`);
          for (let i = 0; i < Math.ceil(TARGET_ELABORADA / 2); i++) {
            const chunk1Index = Math.floor(Math.random() * chunks.length);
            const chunk2Index = Math.floor(Math.random() * chunks.length);
            const chunk1 = chunks[chunk1Index];
            const chunk2 = chunks[chunk2Index];

            const fullPrompt = renderPrompt(CLAUDE_PROMPT_ELABORADA, chunk1, chunk2, ADMIN_USER_ID, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.elaborada, 'elaborada', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.forEach(q => {
                  const validation = validateQuestionQuality(q);
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(ADMIN_USER_ID, currentTopic, 'elaborada', q, 'populate');
                    console.log(`  ✓ Elaborada guardada (score: ${finalScore})`);
                  }
                });
              }
            } catch (error) {
              console.error(`  ❌ Error generando elaboradas: ${error.message}`);
            }
          }

          console.log(`✅ Caché poblado para ${currentTopic}`);

        } catch (error) {
          console.error(`❌ Error poblando tema ${currentTopic}:`, error.message);
        }
      }

      console.log('\n🎉 Pre-población de caché completada');
    })();

  } catch (error) {
    console.error('❌ Error iniciando pre-población:', error);
    res.status(500).json({ error: 'Error al iniciar pre-población de caché' });
  }
});

// ========================
// GESTIÓN DE TEMAS (admin)
// ========================

/**
 * Lista TODOS los temas con su estado de activación.
 * Los temas que nunca se han registrado en topic_status se devuelven como inactivos.
 */
app.get('/api/admin/topics', requireAdmin, (req, res) => {
  try {
    const statusMap = db.getTopicStatusMap();
    const topics = Object.entries(TOPIC_CONFIG).map(([id, cfg]) => ({
      id,
      title: cfg.title,
      description: cfg.description,
      enabled: statusMap[id] === true
    }));
    res.json({ topics });
  } catch (error) {
    console.error('Error listando temas admin:', error);
    res.status(500).json({ error: 'Error al obtener temas' });
  }
});

/**
 * Activa o desactiva un tema. Body: { enabled: boolean }
 */
app.post('/api/admin/topics/:topicId/toggle', requireAdmin, (req, res) => {
  try {
    const { topicId } = req.params;
    const { enabled } = req.body;

    if (!TOPIC_CONFIG[topicId]) {
      return res.status(404).json({ error: `Tema "${topicId}" no existe en la configuración` });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Campo "enabled" debe ser booleano' });
    }

    const ok = db.setTopicEnabled(topicId, enabled);
    if (!ok) {
      return res.status(500).json({ error: 'No se pudo actualizar el estado' });
    }

    console.log(`🎚️  Tema ${topicId} ${enabled ? 'ACTIVADO' : 'DESACTIVADO'} por admin`);
    res.json({ success: true, topicId, enabled });
  } catch (error) {
    console.error('Error toggle tema:', error);
    res.status(500).json({ error: 'Error al cambiar estado del tema' });
  }
});

// ========================
// RUTAS DE LA API OPTIMIZADAS
// ========================

app.get('/api/topics', (req, res) => {
  try {
    // Solo devolver temas activos al usuario final
    const enabled = new Set(db.getEnabledTopicIds());
    const visibleTopics = Object.keys(TOPIC_CONFIG).filter(id => enabled.has(id));
    res.json(visibleTopics);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener temas' });
  }
});

// ========================
// QUEUE PARA EXÁMENES
// ========================
// Limita exámenes concurrentes para prevenir sobrecarga de memoria y Claude API
// Con 100 exámenes concurrentes + cache 90% + rate limiter, soporta 200 usuarios concurrentes
const examQueue = async.queue(async (task) => {
  return await task.fn();
}, 100); // MÁXIMO 100 exámenes simultáneos

// Monitoreo de la queue
examQueue.saturated(() => {
  console.warn('⚠️ Queue de exámenes saturada (100 concurrentes)');
});

examQueue.empty(() => {
  console.log('✅ Queue de exámenes vacía');
});

app.post('/api/generate-exam', requireAuth, examLimiter, async (req, res) => {
  const { topics, questionCount = 1 } = req.body;
  const userId = req.user.id;

  // Validación temprana antes de encolar
  if (!topics?.length) {
    return res.status(400).json({ error: 'Selecciona al menos un tema' });
  }

  console.log(`📚 Usuario ${userId} solicita ${questionCount} preguntas de:`, topics);
  console.log(`⏳ Queue: ${examQueue.length()} esperando, ${examQueue.running()} en progreso`);

  // Encolar la generación del examen (máximo 30 concurrentes)
  examQueue.push({
    fn: async () => {
      try {
        // Obtener todo el contenido para dividir en chunks
        const allContent = await getDocumentsByTopics(topics);

        if (!allContent || !allContent.trim()) {
          const error = new Error('No se encontró contenido para los temas seleccionados');
          error.status = 404;
          throw error;
        }

        // Dividir en chunks de 1000 caracteres (optimizado)
        const chunks = splitIntoChunks(allContent, 1000);
        console.log(`📄 Documento dividido en ${chunks.length} chunks`);

        if (chunks.length === 0) {
          const error = new Error('No hay contenido suficiente');
          error.status = 404;
          throw error;
        }

        let allGeneratedQuestions = [];

        // CONFIGURACIÓN DE CACHÉ
        const CACHE_PROBABILITY = 0.90; // 90% intentar caché, 10% generar nueva (optimizado para 200 usuarios concurrentes)
        let cacheHits = 0;
        let cacheMisses = 0;

        // SISTEMA 3 NIVELES: 20% simples / 60% medias / 20% elaboradas
        const totalNeeded = questionCount;
        const simpleNeeded = Math.round(totalNeeded * 0.20); // 20% simples
        const mediaNeeded = Math.round(totalNeeded * 0.60); // 60% medias
        const elaboratedNeeded = totalNeeded - simpleNeeded - mediaNeeded; // 20% elaboradas (resto)

        // Distribuir preguntas equitativamente entre temas
        const questionsPerTopic = {
          simple: Math.ceil(simpleNeeded / topics.length),
          media: Math.ceil(mediaNeeded / topics.length),
          elaborada: Math.ceil(elaboratedNeeded / topics.length)
        };

        console.log(`🎯 Plan (20/60/20): ${simpleNeeded} simples + ${mediaNeeded} medias + ${elaboratedNeeded} elaboradas`);
        console.log(`📊 Distribución por tema (${topics.length} temas): ${questionsPerTopic.simple} simples + ${questionsPerTopic.media} medias + ${questionsPerTopic.elaborada} elaboradas por tema`);

        // ====================================================================
        // GENERAR PREGUNTAS POR TEMA ESPECÍFICO (distribución equitativa)
        // ====================================================================

        for (const currentTopic of topics) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`📘 Procesando tema: ${currentTopic}`);
          console.log(`${'='.repeat(60)}`);

          // Obtener contenido específico de este tema
          const topicContent = await getDocumentsByTopics([currentTopic]);
          const topicChunks = splitIntoChunks(topicContent, 1000);

          console.log(`📄 Tema ${currentTopic}: ${topicChunks.length} chunks disponibles`);

          // --- PREGUNTAS SIMPLES para este tema ---
          let simpleCount = 0;
          while (simpleCount < questionsPerTopic.simple && allGeneratedQuestions.filter(q => q._sourceTopic === currentTopic && q.difficulty === 'simple').length < questionsPerTopic.simple) {
            const questionsToGet = Math.min(3, questionsPerTopic.simple - simpleCount);
            const tryCache = Math.random() < CACHE_PROBABILITY;
            let questions = [];

            if (tryCache) {
              console.log(`\n💾 SIMPLE [${currentTopic}] - Intentando caché (${questionsToGet} preguntas)...`);
              const excludeIds = []; // 🔴 FIX: Prevenir duplicados en el mismo examen

              for (let j = 0; j < questionsToGet; j++) {
                const cached = db.getCachedQuestion(userId, [currentTopic], 'simple', excludeIds);
                if (cached) {
                  excludeIds.push(cached.cacheId); // 🔴 FIX: Excluir esta pregunta en siguientes iteraciones
                  cached.question._sourceTopic = currentTopic;
                  questions.push(cached.question);
                  db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
                  cacheHits++;
                  console.log(`✓ Pregunta de caché (ID: ${cached.cacheId})`);
                } else {
                  break;
                }
              }
            }

          if (questions.length < questionsToGet) {
            const toGenerate = questionsToGet - questions.length;
            console.log(`\n⚪ SIMPLE [${currentTopic}] - Generando ${toGenerate} preguntas nuevas`);

            // Seleccionar 2 chunks espaciados
            const selectedIndices = selectSpacedChunks(userId, currentTopic, topicChunks, 2);
            const chunk1 = topicChunks[selectedIndices[0]];
            const chunk2 = selectedIndices.length > 1 ? topicChunks[selectedIndices[1]] : chunk1;

            // Prompt con diversidad (chunks + ángulo + historial reciente)
            const fullPrompt = renderPrompt(CLAUDE_PROMPT_SIMPLE, chunk1, chunk2, userId, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.simple, 'simple', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.slice(0, toGenerate).forEach(q => {
                  // FASE 1: Validación básica
                  const validation = validateQuestionQuality(q);

                  // FASE 2: Validación avanzada con chunks
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);

                  // Score combinado
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  console.log(`   📊 Calidad: ${finalScore}/100 (básica: ${validation.score}, avanzada: ${advValidation.score})`);
                  if (advValidation.warnings.length > 0) {
                    console.log(`   ⚠️  Warnings: ${advValidation.warnings.join(', ')}`);
                  }

                  // 🔴 FIX: Umbral reducido de 70 a 65 para reducir desperdicio de API
                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(userId, currentTopic, 'simple', q, 'exam');
                    questions.push(q);
                    cacheMisses++;
                  } else {
                    console.log(`   ❌ Pregunta rechazada (score ${finalScore} < 65)`);
                  }
                });

                // Marcar ambos chunks como usados
                selectedIndices.forEach(idx => db.markChunkAsUsed(userId, currentTopic, idx));
              }
            } catch (error) {
              console.error(`❌ Error generando simples [${currentTopic}]:`, error.message);
            }
          }

          allGeneratedQuestions.push(...questions);
          simpleCount += questions.length;
        }

        // --- PREGUNTAS MEDIAS para este tema ---
        let mediaCount = 0;
        while (mediaCount < questionsPerTopic.media && allGeneratedQuestions.filter(q => q._sourceTopic === currentTopic && q.difficulty === 'media').length < questionsPerTopic.media) {
          const questionsToGet = Math.min(3, questionsPerTopic.media - mediaCount);
          const tryCache = Math.random() < CACHE_PROBABILITY;
          let questions = [];

          if (tryCache) {
            console.log(`\n💾 MEDIA [${currentTopic}] - Intentando caché (${questionsToGet} preguntas)...`);
            const excludeIds = []; // 🔴 FIX: Prevenir duplicados en el mismo examen

            for (let j = 0; j < questionsToGet; j++) {
              const cached = db.getCachedQuestion(userId, [currentTopic], 'media', excludeIds);
              if (cached) {
                excludeIds.push(cached.cacheId); // 🔴 FIX: Excluir esta pregunta en siguientes iteraciones
                cached.question._sourceTopic = currentTopic;
                questions.push(cached.question);
                db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
                cacheHits++;
                console.log(`✓ Pregunta de caché (ID: ${cached.cacheId})`);
              } else {
                break;
              }
            }
          }

          if (questions.length < questionsToGet) {
            const toGenerate = questionsToGet - questions.length;
            console.log(`\n🔵 MEDIA [${currentTopic}] - Generando ${toGenerate} preguntas nuevas`);

            // Seleccionar 2 chunks espaciados
            const selectedIndices = selectSpacedChunks(userId, currentTopic, topicChunks, 2);
            const chunk1 = topicChunks[selectedIndices[0]];
            const chunk2 = selectedIndices.length > 1 ? topicChunks[selectedIndices[1]] : chunk1;

            // Prompt con diversidad (chunks + ángulo + historial reciente)
            const fullPrompt = renderPrompt(CLAUDE_PROMPT_MEDIA, chunk1, chunk2, userId, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.media, 'media', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.slice(0, toGenerate).forEach(q => {
                  // FASE 1: Validación básica
                  const validation = validateQuestionQuality(q);

                  // FASE 2: Validación avanzada con chunks
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);

                  // Score combinado
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  console.log(`   📊 Calidad: ${finalScore}/100 (básica: ${validation.score}, avanzada: ${advValidation.score})`);
                  if (advValidation.warnings.length > 0) {
                    console.log(`   ⚠️  Warnings: ${advValidation.warnings.join(', ')}`);
                  }

                  // 🔴 FIX: Umbral reducido de 70 a 65 para reducir desperdicio de API
                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(userId, currentTopic, 'media', q, 'exam');
                    questions.push(q);
                    cacheMisses++;
                  } else {
                    console.log(`   ❌ Pregunta rechazada (score ${finalScore} < 65)`);
                  }
                });

                // Marcar ambos chunks como usados
                selectedIndices.forEach(idx => db.markChunkAsUsed(userId, currentTopic, idx));
              }
            } catch (error) {
              console.error(`❌ Error generando medias [${currentTopic}]:`, error.message);
            }
          }

          allGeneratedQuestions.push(...questions);
          mediaCount += questions.length;
        }

        // --- PREGUNTAS ELABORADAS para este tema ---
        let elaboratedCount = 0;
        while (elaboratedCount < questionsPerTopic.elaborada && allGeneratedQuestions.filter(q => q._sourceTopic === currentTopic && q.difficulty === 'elaborada').length < questionsPerTopic.elaborada) {
          const questionsToGet = Math.min(2, questionsPerTopic.elaborada - elaboratedCount);
          const tryCache = Math.random() < CACHE_PROBABILITY;
          let questions = [];

          if (tryCache) {
            console.log(`\n💾 ELABORADA [${currentTopic}] - Intentando caché (${questionsToGet} preguntas)...`);
            const excludeIds = []; // 🔴 FIX: Prevenir duplicados en el mismo examen

            for (let j = 0; j < questionsToGet; j++) {
              const cached = db.getCachedQuestion(userId, [currentTopic], 'elaborada', excludeIds);
              if (cached) {
                excludeIds.push(cached.cacheId); // 🔴 FIX: Excluir esta pregunta en siguientes iteraciones
                cached.question._sourceTopic = currentTopic;
                questions.push(cached.question);
                db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
                cacheHits++;
                console.log(`✓ Pregunta de caché (ID: ${cached.cacheId})`);
              } else {
                break;
              }
            }
          }

          if (questions.length < questionsToGet) {
            const toGenerate = questionsToGet - questions.length;
            console.log(`\n🔴 ELABORADA [${currentTopic}] - Generando ${toGenerate} preguntas nuevas`);

            // Seleccionar 2 chunks espaciados
            const selectedIndices = selectSpacedChunks(userId, currentTopic, topicChunks, 2);
            const chunk1 = topicChunks[selectedIndices[0]];
            const chunk2 = selectedIndices.length > 1 ? topicChunks[selectedIndices[1]] : chunk1;

            // Prompt con diversidad (chunks + ángulo + historial reciente)
            const fullPrompt = renderPrompt(CLAUDE_PROMPT_ELABORADA, chunk1, chunk2, userId, currentTopic);

            try {
              const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.elaborada, 'elaborada', 2);
              const responseText = extractClaudeResponseText(response);
              const questionsData = parseClaudeResponse(responseText);

              if (questionsData?.questions?.length) {
                questionsData.questions.slice(0, toGenerate).forEach(q => {
                  // FASE 1: Validación básica
                  const validation = validateQuestionQuality(q);

                  // FASE 2: Validación avanzada con chunks
                  const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);

                  // Score combinado
                  const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

                  console.log(`   📊 Calidad: ${finalScore}/100 (básica: ${validation.score}, avanzada: ${advValidation.score})`);
                  if (advValidation.warnings.length > 0) {
                    console.log(`   ⚠️  Warnings: ${advValidation.warnings.join(', ')}`);
                  }

                  // 🔴 FIX: Umbral reducido de 70 a 65 para reducir desperdicio de API
                  if (finalScore >= 65) {
                    q._sourceTopic = currentTopic;
                    q._qualityScore = finalScore;
                    db.saveToCacheAndTrack(userId, currentTopic, 'elaborada', q, 'exam');
                    questions.push(q);
                    cacheMisses++;
                  } else {
                    console.log(`   ❌ Pregunta rechazada (score ${finalScore} < 65)`);
                  }
                });

                // Marcar ambos chunks como usados
                selectedIndices.forEach(idx => db.markChunkAsUsed(userId, currentTopic, idx));
              }
            } catch (error) {
              console.error(`❌ Error generando elaboradas [${currentTopic}]:`, error.message);
            }
          }

          allGeneratedQuestions.push(...questions);
          elaboratedCount += questions.length;
          }
        } // FIN del loop por temas

        // Validar y aleatorizar todas las preguntas generadas
        const finalQuestions = allGeneratedQuestions.slice(0, questionCount).map((q, index) => {
          if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) {
            console.log(`⚠️ Corrigiendo pregunta ${index + 1}`);
            q.options = q.options || [
              "A) Opción 1", "B) Opción 2", "C) Opción 3", "D) Opción 4"
            ];
          }
          q.correct = q.correct ?? 0;
          q.explanation = q.explanation || "Explicación no disponible.";
          q.difficulty = q.difficulty || "media";
          q.page_reference = q.page_reference || "Referencia no disponible";

          // ALEATORIZAR ORDEN DE LAS OPCIONES
          const randomizedQuestion = randomizeQuestionOptions(q);

          // Eliminar propiedad temporal _sourceTopic antes de enviar al cliente
          delete randomizedQuestion._sourceTopic;

          console.log(`🎲 Pregunta ${index + 1}: "${q.question.substring(0, 50)}..." - Correcta: ${['A', 'B', 'C', 'D'][randomizedQuestion.correct]} - Dificultad: ${q.difficulty}`);

          return randomizedQuestion;
        });

        // Si no se generaron suficientes preguntas, agregar fallback con mensaje de error
        if (finalQuestions.length === 0) {
          console.log('⚠️ No se generaron preguntas, usando fallback de error');
          const fallbackQuestion = {
            question: `⚠️ ERROR: No se pudieron generar preguntas del ${topics.map(t => TOPIC_CONFIG[t]?.title || t).join(', ')}`,
            options: [
              "A) Por favor, intenta de nuevo - Puede ser un problema temporal",
              "B) Verifica tu conexión a internet y recarga la página",
              "C) Si el error continúa, contacta al administrador del sistema",
              "D) Prueba con otro tema mientras se resuelve el problema"
            ],
            correct: 0,
            explanation: `Error técnico: No se pudieron generar preguntas del tema seleccionado. Esto puede deberse a: 1) Sobrecarga temporal del servicio de IA, 2) Problema de conexión, 3) Error en los materiales de estudio. Por favor, recarga la página e intenta de nuevo. Si el problema persiste, contacta al administrador.`,
            difficulty: "media",
            page_reference: "Error técnico - Sistema"
          };
          finalQuestions.push(randomizeQuestionOptions(fallbackQuestion));
        }

        // Registrar actividad por cada pregunta generada
        finalQuestions.forEach(() => {
            db.logActivity(userId, 'question_generated', topics[0]);
        });

        // Mostrar cobertura de chunks por tema
        console.log(`\n📊 COBERTURA DE CHUNKS POR TEMA:`);
        const coverageByTopic = await Promise.all(
            topics.map(async (topic) => {
              const topicContent = await getDocumentsByTopics([topic]);
              const topicChunks = splitIntoChunks(topicContent, 1200);
              const coverage = db.getChunkCoverage(userId, topic);
              const percentage = topicChunks.length > 0 ? Math.round(coverage / topicChunks.length * 100) : 0;
              console.log(`  ${topic}: ${coverage}/${topicChunks.length} chunks (${percentage}%)`);
              return { topic, used: coverage, total: topicChunks.length, percentage };
            })
        );

        // Estadísticas de caché
        const total = cacheHits + cacheMisses;
        const cacheHitRate = total > 0 ? Math.round((cacheHits / total) * 100) : 0;
        console.log(`\n💾 CACHÉ: ${cacheHits} hits / ${cacheMisses} misses (${cacheHitRate}% hit rate)`);

        // Actualizar estadísticas diarias de caché
        const costPerQuestion = 0.00076;
        const totalCost = cacheMisses * costPerQuestion;
        db.updateCacheStats(cacheMisses, cacheHits, totalCost);

        // 🔴 FIX: cleanExpiredCache() REMOVIDO - caché nunca expira por tiempo
        // Se limpia solo por límite de 10,000 (elimina 1000 menos útiles)

        return {
          examId: Date.now(),
          questions: finalQuestions,
          topics,
          questionCount: finalQuestions.length,
          coverageByTopic,
          cacheStats: {
            hits: cacheHits,
            misses: cacheMisses,
            hitRate: cacheHitRate,
            totalQuestions: total,
            cost: totalCost.toFixed(5)
          }
        };

      } catch (error) {
        console.error('❌ Error generando examen:', error);
        throw error; // Propagar error para manejo externo
      }
    }
  }).then(result => {
    // Éxito: enviar resultado al cliente
    res.json(result);
  }).catch(error => {
    // Error: manejar y responder
    console.error('❌ Error en queue de exámenes:', error);

    // Validar que error existe antes de acceder a propiedades
    const errorCode = error?.status || (error?.message ? 500 : 520);
    const errorType = error?.type || 'unknown_error';

    // Mensajes específicos con acciones claras
    const errorInfo = {
      529: {
        message: 'El servicio de IA está temporalmente saturado',
        action: 'Espera 10-15 segundos e intenta de nuevo',
        retryable: true,
        waitTime: 10000
      },
      429: {
        message: 'Has alcanzado el límite de solicitudes por minuto',
        action: 'Espera 30 segundos antes de generar otro examen',
        retryable: true,
        waitTime: 30000
      },
      503: {
        message: 'Servicio temporalmente no disponible',
        action: 'Intenta de nuevo en unos momentos',
        retryable: true,
        waitTime: 5000
      },
      500: {
        message: errorType === 'api_error' ? 'Error en servicio de IA' : 'Error generando examen',
        action: 'Si el problema persiste, contacta al administrador',
        retryable: true,
        waitTime: 5000
      }
    };

    const response = errorInfo[errorCode] || errorInfo[500];
    res.status(errorCode).json(response);
  });
});

// ====================================================================
// FASE 3: PRE-WARMING - Generar preguntas ANTES de que usuario las pida
// ====================================================================
app.post('/api/study/pre-warm', requireAuth, async (req, res) => {
  try {
    const { topicId } = req.body;
    const userId = req.user.id;

    // Validación: topicId es requerido
    if (!topicId) {
      return res.status(400).json({ error: 'topicId es requerido' });
    }

    // Validación: topicId existe en la configuración
    if (!TOPIC_CONFIG[topicId]) {
      return res.status(400).json({ error: `Tema "${topicId}" no existe` });
    }
    // Validación: tema está activo
    if (!db.isTopicEnabled(topicId)) {
      return res.status(403).json({ error: 'Tema no disponible' });
    }

    console.log(`🔥 Pre-warming: Usuario ${userId} seleccionó tema ${topicId}`);

    // Verificar si ya tiene buffer
    const currentBufferSize = db.getBufferSize(userId, topicId);

    if (currentBufferSize >= BUFFER_TARGET_SIZE) {
      console.log(`✓ Buffer ya tiene ${currentBufferSize} preguntas, no es necesario pre-warm`);
      return res.json({
        success: true,
        message: 'Buffer ya preparado',
        bufferSize: currentBufferSize
      });
    }

    // Retornar inmediatamente (no bloquear)
    res.json({
      success: true,
      message: 'Pre-warming iniciado en background',
      bufferSize: currentBufferSize
    });

    // Generar preguntas en background (CONTROLADO - previene duplicados)
    setImmediate(() => {
      runControlledBackgroundGeneration(userId, topicId, async () => {
        console.log(`🔨 [Background] Pre-warming: generando preguntas rápidas (cache: 90%)...`);

        // Fase 1: Genera primer lote rápido (2-3) para entrega inmediata
        const initialNeeded = Math.min(3, BUFFER_TARGET_SIZE - currentBufferSize);
        if (initialNeeded > 0) {
          const batchQuestions = await generateQuestionBatch(userId, topicId, initialNeeded, 0.90);

          for (const q of batchQuestions) {
            db.addToBuffer(userId, topicId, q, q.difficulty, q._cacheId || null);
          }

          const afterInitial = db.getBufferSize(userId, topicId);
          console.log(`✅ [Background] Pre-warming fase 1: ${afterInitial} preguntas en buffer`);

          // Fase 2: Continuar rellenando hasta el objetivo
          if (afterInitial < BUFFER_TARGET_SIZE) {
            const remaining = BUFFER_TARGET_SIZE - afterInitial;
            console.log(`🔄 Continuando pre-warming: generando ${remaining} pregunta(s) más hasta objetivo ${BUFFER_TARGET_SIZE}...`);
            await refillBuffer(userId, topicId, remaining);
          }
        }
      });
    });

  } catch (error) {
    console.error('❌ Error en /api/study/pre-warm:', error);

    res.status(500).json({
      error: 'Error iniciando pre-warming',
      success: false
    });
  }
});

// ====================================================================
// FASE 2: ENDPOINT CON PREFETCH PARA ESTUDIO (RESPUESTA INSTANTÁNEA)
// ====================================================================
app.post('/api/study/question', requireAuth, studyLimiter, async (req, res) => {
  try {
    const { topicId } = req.body;
    const userId = req.user.id;

    // Validación: topicId es requerido
    if (!topicId) {
      return res.status(400).json({ error: 'topicId es requerido' });
    }

    // Validación: topicId existe en la configuración
    if (!TOPIC_CONFIG[topicId]) {
      return res.status(400).json({ error: `Tema "${topicId}" no existe` });
    }
    // Validación: tema está activo
    if (!db.isTopicEnabled(topicId)) {
      return res.status(403).json({ error: 'Tema no disponible' });
    }

    console.log(`📚 Usuario ${userId} solicita pregunta de estudio: ${topicId}`);

    // PASO 1: Verificar si hay pregunta en buffer
    const bufferSize = db.getBufferSize(userId, topicId);
    console.log(`💾 Buffer actual: ${bufferSize} preguntas`);

    let questionToReturn = null;

    if (bufferSize > 0) {
      // Obtener pregunta del buffer (INSTANT!)
      const buffered = db.getFromBuffer(userId, topicId);

      if (buffered && buffered.question) {
        questionToReturn = buffered.question;

        // Marcar como vista si viene de caché
        if (buffered.cacheId) {
          db.markQuestionAsSeen(userId, buffered.cacheId, 'study');
        }

        console.log(`⚡ Pregunta entregada desde buffer (INSTANT!)`);

        // Check buffer size after retrieval
        const newBufferSize = db.getBufferSize(userId, topicId);
        console.log(`💾 Buffer después de entrega: ${newBufferSize} preguntas`);

        // Si buffer bajó del umbral, rellenar en background
        if (newBufferSize < BUFFER_REFILL_TRIGGER) {
          console.log(`🔄 Buffer bajo (${newBufferSize}), iniciando refill en background...`);

          // Rellenar hasta el objetivo (CONTROLADO - previene duplicados)
          setImmediate(() => {
            runControlledBackgroundGeneration(userId, topicId, async () => {
              await refillBuffer(userId, topicId, BUFFER_TARGET_SIZE - newBufferSize);
            });
          });
        }

        // Aleatorizar opciones antes de devolver
        const randomizedQuestion = randomizeQuestionOptions(questionToReturn);

        // Retornar inmediatamente
        return res.json({
          questions: [randomizedQuestion],
          source: 'buffer',
          bufferSize: newBufferSize
        });
      } else {
        // Buffer reportó preguntas pero getFromBuffer falló (datos corruptos?)
        console.warn(`⚠️ Buffer reportó ${bufferSize} preguntas pero getFromBuffer retornó null`);
      }
    }

    // PASO 2: Buffer vacío - generar 2 preguntas (OPTIMIZACIÓN: balance velocidad/buffer)
    console.log(`🔨 Buffer vacío - generando 2 preguntas (1 entrega + 1 buffer)...`);
    const startTime = Date.now();

    // Caché 90-10: Balance óptimo entre velocidad y variedad
    const batchQuestions = await generateQuestionBatch(userId, topicId, 2, 0.90);

    if (batchQuestions.length === 0) {
      return res.status(500).json({ error: 'No se pudieron generar preguntas' });
    }

    // Primera pregunta para retornar
    questionToReturn = batchQuestions[0];

    // 🔴 FIX: Marcar como vista DESPUÉS de confirmar que se va a entregar
    if (questionToReturn._cacheId) {
      db.markQuestionAsSeen(userId, questionToReturn._cacheId, 'study');
    }

    // Segunda pregunta al buffer (si existe)
    if (batchQuestions.length > 1) {
      const q = batchQuestions[1];
      db.addToBuffer(userId, topicId, q, q.difficulty, q._cacheId || null);
      console.log(`✅ 1ª pregunta entregada, 2ª pregunta añadida al buffer`);
    } else {
      console.log(`✅ Pregunta generada y entregada (solo se generó 1)`);
    }

    // Iniciar refill en background para completar buffer al objetivo
    setImmediate(() => {
      runControlledBackgroundGeneration(userId, topicId, async () => {
        const currentSize = db.getBufferSize(userId, topicId);
        const needed = BUFFER_TARGET_SIZE - currentSize;
        if (needed > 0) {
          console.log(`🔄 Llenando buffer en background (${needed} preguntas más, objetivo: ${BUFFER_TARGET_SIZE})...`);
          await refillBuffer(userId, topicId, needed);
        }
      });
    });

    const finalBufferSize = db.getBufferSize(userId, topicId);
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`💾 Buffer actual: ${finalBufferSize} pregunta(s) (refill en progreso)`);
    console.log(`⏱️  Tiempo de generación: ${elapsedTime}s`);

    // Aleatorizar opciones antes de devolver
    const randomizedQuestion = randomizeQuestionOptions(questionToReturn);

    res.json({
      questions: [randomizedQuestion],
      source: 'generated',
      bufferSize: finalBufferSize
    });

  } catch (error) {
    console.error('❌ Error en /api/study/question:', error);

    // 🆘 FALLBACK: Antes de devolver error, intentar servir CUALQUIER pregunta de caché
    // (incluso si el usuario ya la vio hace menos de 15 días). Esto evita que el usuario
    // vea la notificación de "Reintentando..." cuando la API de IA falla transitoriamente.
    try {
      const { topicId } = req.body;
      const userId = req.user?.id;
      if (userId && topicId) {
        const fallback = db.getCachedQuestionFallback(userId, [topicId], null, []);
        if (fallback && fallback.question) {
          console.log(`🆘 Sirviendo pregunta de fallback (cacheId: ${fallback.cacheId}) tras fallo de generación`);
          db.markQuestionAsSeen(userId, fallback.cacheId, 'study');

          // Lanzar refill en background para recuperar buffer sin bloquear al usuario
          setImmediate(() => {
            runControlledBackgroundGeneration(userId, topicId, async () => {
              const size = db.getBufferSize(userId, topicId);
              if (size < BUFFER_TARGET_SIZE) {
                await refillBuffer(userId, topicId, BUFFER_TARGET_SIZE - size);
              }
            });
          });

          const randomizedQuestion = randomizeQuestionOptions(fallback.question);
          return res.json({
            questions: [randomizedQuestion],
            source: 'fallback',
            bufferSize: db.getBufferSize(userId, topicId)
          });
        }
      }
    } catch (fallbackError) {
      console.error('❌ Error en fallback de caché:', fallbackError);
    }

    // Validar que error existe antes de acceder a propiedades
    const errorCode = error?.status || (error?.message ? 500 : 520);
    const errorType = error?.type || 'unknown_error';

    // Mensajes específicos con acciones claras
    const errorInfo = {
      529: {
        message: 'El servicio de IA está temporalmente saturado',
        action: 'Espera 10-15 segundos e intenta de nuevo',
        retryable: true,
        waitTime: 10000
      },
      429: {
        message: 'Has alcanzado el límite de solicitudes por minuto',
        action: 'Espera 30 segundos antes de solicitar más preguntas',
        retryable: true,
        waitTime: 30000
      },
      503: {
        message: 'Servicio temporalmente no disponible',
        action: 'Intenta de nuevo en unos momentos',
        retryable: true,
        waitTime: 5000
      },
      500: {
        message: errorType === 'api_error' ? 'Error en servicio de IA' : 'Error generando pregunta',
        action: 'Si el problema persiste, contacta al administrador',
        retryable: true,
        waitTime: 5000
      }
    };

    const response = errorInfo[errorCode] || errorInfo[500];

    res.status(errorCode).json(response);
  }
});

/**
 * Generar batch de preguntas (mix de caché + nuevas)
 * cacheProb aumentado a 90% para optimizar velocidad (prioriza caché)
 */
async function generateQuestionBatch(userId, topicId, count = 3, cacheProb = 0.90) {
  const batchStartTime = Date.now();
  const questions = [];
  const MAX_RETRIES = count * 2; // Intentar hasta el doble para asegurar al menos 1 pregunta

  // Obtener contenido del tema
  const docStartTime = Date.now();
  const topicContent = await getDocumentsByTopics([topicId]);
  const topicChunks = splitIntoChunks(topicContent, 1000);
  console.log(`⏱️  [Timing] Carga de documentos: ${((Date.now() - docStartTime) / 1000).toFixed(2)}s`);

  if (topicChunks.length === 0) {
    throw new Error('No hay contenido disponible para este tema');
  }

  console.log(`📄 Tema ${topicId}: ${topicChunks.length} chunks disponibles (cacheProb: ${(cacheProb * 100).toFixed(0)}%)`);

  // Generar preguntas mezclando dificultades (batches de 2)
  let attempts = 0;
  while (questions.length < count && attempts < MAX_RETRIES) {
    attempts++;

    // Distribuir dificultades: 20% simple, 60% media, 20% elaborada
    let difficulty = 'media';
    const rand = Math.random();
    if (rand < 0.20) difficulty = 'simple';
    else if (rand > 0.80) difficulty = 'elaborada';

    const tryCache = Math.random() < cacheProb;
    let batchQuestions = [];

    // Intentar caché primero (hasta 2 preguntas)
    if (tryCache) {
      const needed = Math.min(2, count - questions.length);
      const excludeIds = []; // 🔴 FIX: Prevenir duplicados en el mismo batch

      for (let i = 0; i < needed; i++) {
        const cached = db.getCachedQuestion(userId, [topicId], difficulty, excludeIds);
        if (cached) {
          excludeIds.push(cached.cacheId); // 🔴 FIX: Excluir esta pregunta en siguientes iteraciones
          cached.question._cacheId = cached.cacheId;
          cached.question._sourceTopic = topicId;
          batchQuestions.push(cached.question);
          // 🔴 FIX: Marcar como vista INMEDIATAMENTE al añadir al buffer (previene duplicados)
          db.markQuestionAsSeen(userId, cached.cacheId, 'study');
          console.log(`💾 Pregunta ${questions.length + batchQuestions.length}/${count} desde caché (${difficulty}) - ID ${cached.cacheId}`);
        } else {
          break;
        }
      }
    }

    // Si no hay suficientes en caché, generar batch de 2
    if (batchQuestions.length === 0) {
      // Seleccionar 2 chunks espaciados
      const selectedIndices = selectSpacedChunks(userId, topicId, topicChunks, 2);
      const chunk1 = topicChunks[selectedIndices[0]];
      const chunk2 = selectedIndices.length > 1 ? topicChunks[selectedIndices[1]] : chunk1;

      let prompt, maxTokens;
      if (difficulty === 'simple') {
        prompt = CLAUDE_PROMPT_SIMPLE;
        maxTokens = MAX_TOKENS_CONFIG.simple;
      } else if (difficulty === 'media') {
        prompt = CLAUDE_PROMPT_MEDIA;
        maxTokens = MAX_TOKENS_CONFIG.media;
      } else {
        prompt = CLAUDE_PROMPT_ELABORADA;
        maxTokens = MAX_TOKENS_CONFIG.elaborada;
      }

      // Prompt con diversidad (chunks + ángulo + historial reciente del usuario)
      const fullPrompt = renderPrompt(prompt, chunk1, chunk2, userId, topicId);

      try {
        const claudeStartTime = Date.now();
        const response = await callClaudeWithImprovedRetry(fullPrompt, maxTokens, difficulty, 2);
        console.log(`⏱️  [Timing] Llamada a Claude: ${((Date.now() - claudeStartTime) / 1000).toFixed(2)}s`);
        const responseText = extractClaudeResponseText(response);
        const questionsData = parseClaudeResponse(responseText);

        if (questionsData?.questions?.length > 0) {
          // Procesar TODAS las preguntas generadas (optimización: aprovechar 100%)
          const needed = Math.min(2, count - questions.length);

          for (let i = 0; i < questionsData.questions.length; i++) {
            const q = questionsData.questions[i];

            // FASE 1: Validación básica
            const validation = validateQuestionQuality(q);

            // FASE 2: Validación avanzada con chunks
            const advValidation = advancedQuestionValidation(q, [chunk1, chunk2]);

            // Score combinado
            const finalScore = Math.round((validation.score * 0.4) + (advValidation.score * 0.6));

            console.log(`   📊 Calidad: ${finalScore}/100 (básica: ${validation.score}, avanzada: ${advValidation.score})`);
            if (advValidation.warnings.length > 0) {
              console.log(`   ⚠️  Warnings: ${advValidation.warnings.join(', ')}`);
            }

            // 🔴 FIX: Umbral reducido de 70 a 65 para reducir desperdicio de API (~10% menos rechazos)
            if (finalScore >= 65) {
              q._sourceTopic = topicId;
              q._qualityScore = finalScore;

              // SIEMPRE guardar en caché (aprovecha 100% de preguntas generadas)
              db.saveToCacheAndTrack(userId, topicId, difficulty, q, 'study');

              // Solo añadir a batchQuestions las que necesitamos para el buffer
              if (batchQuestions.length < needed) {
                batchQuestions.push(q);
                console.log(`   ✅ Pregunta ${batchQuestions.length}/${needed} añadida al buffer`);
              } else {
                console.log(`   💾 Pregunta extra guardada solo en caché (aprovechamiento 100%)`);
              }
            } else {
              console.log(`   ❌ Pregunta rechazada (score ${finalScore} < 65)`);
            }
          }

          // Marcar chunks como usados
          selectedIndices.forEach(idx => db.markChunkAsUsed(userId, topicId, idx));

          console.log(`🆕 ${batchQuestions.length} preguntas generadas (${difficulty})`);
        }
      } catch (error) {
        console.error(`❌ Error generando pregunta (intento ${attempts}):`, error.message);
      }
    }

    // Añadir preguntas del batch
    questions.push(...batchQuestions);
  }

  // Log final con stats
  const batchTotalTime = ((Date.now() - batchStartTime) / 1000).toFixed(2);
  console.log(`✅ Batch completado: ${questions.length}/${count} preguntas en ${attempts} intentos`);
  console.log(`⏱️  [Timing] Tiempo total del batch: ${batchTotalTime}s`);

  // Si no se generó NINGUNA pregunta, lanzar error
  if (questions.length === 0) {
    throw new Error('No se pudo generar ninguna pregunta después de múltiples intentos');
  }

  return questions;
}

/**
 * Ejecutar promesas en lotes con concurrencia limitada
 * @param {Array<Function>} promiseFunctions - Array de funciones que retornan promesas
 * @param {number} concurrencyLimit - Número máximo de promesas simultáneas
 * @returns {Promise<Array>} - Array de resultados
 */
async function executeWithConcurrencyLimit(promiseFunctions, concurrencyLimit = 10) {
  const results = [];
  const executing = [];

  for (const promiseFn of promiseFunctions) {
    const promise = promiseFn().then(result => {
      executing.splice(executing.indexOf(promise), 1);
      return result;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= concurrencyLimit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

/**
 * Rellenar buffer en background
 */
async function refillBuffer(userId, topicId, count = BUFFER_TARGET_SIZE) {
  console.log(`🔄 [Background] Rellenando buffer con ${count} preguntas...`);

  try {
    // 🔴 FIX: Verificar buffer actual antes de generar (previene duplicados por race condition)
    const currentBufferSize = db.getBufferSize(userId, topicId);

    if (currentBufferSize >= BUFFER_TARGET_SIZE) {
      console.log(`⏭️  [Background] Buffer ya tiene ${currentBufferSize}/${BUFFER_TARGET_SIZE} preguntas, refill cancelado`);
      return;
    }

    // Ajustar cantidad a generar según buffer actual (tope: BUFFER_TARGET_SIZE)
    const actualCount = Math.min(count, Math.max(0, BUFFER_TARGET_SIZE - currentBufferSize));

    if (actualCount === 0) {
      console.log(`⏭️  [Background] Buffer completo, no se necesita refill`);
      return;
    }

    console.log(`🔄 [Background] Generando ${actualCount} preguntas (buffer actual: ${currentBufferSize})`);

    const newQuestions = await generateQuestionBatch(userId, topicId, actualCount);

    // 🔴 FIX: addToBuffer ahora verifica límite atómicamente (previene race conditions)
    // Si buffer se llenó mientras generábamos, addToBuffer retornará null
    let addedCount = 0;
    for (const q of newQuestions) {
      const result = db.addToBuffer(userId, topicId, q, q.difficulty, q._cacheId || null);
      if (result !== null) {
        addedCount++;
      } else {
        console.log(`⏭️  Buffer lleno, descartando preguntas sobrantes (${newQuestions.length - addedCount} no añadidas)`);
        break; // Buffer lleno, no intentar más
      }
    }

    const bufferSize = db.getBufferSize(userId, topicId);
    console.log(`✅ [Background] Buffer rellenado: ${bufferSize} preguntas (${addedCount} añadidas)`);
  } catch (error) {
    console.error(`❌ [Background] Error rellenando buffer:`, error);
  }
}

app.post('/api/record-answer', requireAuth, (req, res) => {
  try {
    const { topicId, questionData, userAnswer, isCorrect, isReview, questionId } = req.body;
    const userId = req.user.id;

    // LOG DETALLADO PARA DEBUG
    console.log(`📝 RECORD-ANSWER - Usuario: ${userId}, Tema: ${topicId}, isReview: ${isReview}, questionId: ${questionId}, isCorrect: ${isCorrect}`);

    // Obtener título del tema
    const topicConfig = TOPIC_CONFIG[topicId];
    const topicTitle = topicConfig?.title || 'Tema desconocido';

    // SISTEMA DE REPASO: Si es una pregunta de repaso
    if (isReview && questionId) {
      console.log(`🔍 MODO REPASO DETECTADO - questionId: ${questionId}, isCorrect: ${isCorrect}`);
      if (isCorrect) {
        // Si acierta la pregunta de repaso, ELIMINARLA de preguntas falladas
        const result = db.removeFailedQuestion(userId, questionId);
        console.log(`✅ ELIMINANDO pregunta ${questionId} de usuario ${userId} - Resultado:`, result);
      } else {
        // Si falla de nuevo, se mantiene en preguntas falladas
        console.log(`❌ Pregunta de repaso ${questionId} fallada nuevamente - Se mantiene`);
      }
    } else {
      // SISTEMA NORMAL: Preguntas nuevas generadas
      // Actualizar estadísticas en la base de datos
      db.updateUserStats(userId, topicId, topicTitle, isCorrect);

      // Registrar en historial para estadísticas semanales
      db.recordAnswer(userId, topicId, topicTitle, isCorrect);

      // Si es incorrecta, guardar en preguntas falladas
      if (!isCorrect) {
        db.addFailedQuestion(userId, topicId, questionData, userAnswer);
      }
    }

    // Obtener estadísticas actualizadas del usuario para este tema
    const allStats = db.getUserStats(userId);
    const topicStats = allStats.find(s => s.topic_id === topicId);

    res.json({
      success: true,
      stats: topicStats || { total_questions: 0, correct_answers: 0, accuracy: 0 },
      removedFromReview: isReview && isCorrect // Indicar si se eliminó del repaso
    });

  } catch (error) {
    console.error('❌ Error registrando respuesta:', error);
    res.status(500).json({ error: 'Error al registrar respuesta' });
  }
});

app.get('/api/user-stats', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const stats = db.getUserStats(userId);

    // Transformar formato de base de datos a formato esperado por frontend
    const statsWithTitles = {};

    stats.forEach(stat => {
      statsWithTitles[stat.topic_id] = {
        title: stat.topic_title,
        totalQuestions: stat.total_questions,
        correctAnswers: stat.correct_answers,
        accuracy: stat.accuracy,
        lastStudied: stat.last_studied
      };
    });

    res.json(statsWithTitles);
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// Nuevo endpoint: Estadísticas semanales
app.get('/api/weekly-stats', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const weeks = parseInt(req.query.weeks) || 4;

    // Obtener estadísticas por tema
    const statsByTopic = db.getWeeklyStatsByTopic(userId, weeks);

    // Obtener resumen semanal
    const summary = db.getWeeklySummary(userId, weeks);

    res.json({
      byTopic: statsByTopic,
      summary: summary
    });
  } catch (error) {
    console.error('❌ Error obteniendo estadísticas semanales:', error);
    res.status(500).json({ error: 'Error al obtener estadísticas semanales' });
  }
});

app.get('/api/failed-questions', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const failedQuestions = db.getUserFailedQuestions(userId);

    // Agregar títulos de temas desde TOPIC_CONFIG
    Object.keys(failedQuestions).forEach(topicId => {
      if (topicId.startsWith('examen-')) {
        // Para exámenes, mantener el formato original
        failedQuestions[topicId].title = failedQuestions[topicId].title || 'Examen Oficial';
      } else {
        // Para temas normales, buscar el título en TOPIC_CONFIG
        const topicConfig = TOPIC_CONFIG[topicId];
        failedQuestions[topicId].title = topicConfig?.title || `Tema ${topicId}`;
      }
    });

    res.json(failedQuestions);
  } catch (error) {
    console.error('❌ Error obteniendo preguntas falladas:', error);
    res.status(500).json({ error: 'Error al obtener preguntas falladas' });
  }
});

// Nuevo endpoint: Obtener preguntas falladas de un tema como test de repaso
app.get('/api/review-exam/:topicId', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const topicId = req.params.topicId;

    console.log(`📚 Usuario ${userId} solicita test de repaso del tema: ${topicId}`);

    // Obtener todas las preguntas falladas del usuario
    const allFailedQuestions = db.getUserFailedQuestions(userId);

    // Verificar si hay preguntas para ese tema
    if (!allFailedQuestions[topicId] || !allFailedQuestions[topicId].questions.length) {
      return res.status(404).json({
        error: 'No hay preguntas falladas para repasar en este tema'
      });
    }

    const topicQuestions = allFailedQuestions[topicId].questions;

    // Formatear preguntas al formato de test (sin mostrar respuestas del usuario)
    const reviewQuestions = topicQuestions.map((q, index) => {
      // Aleatorizar opciones para que no estén siempre en el mismo orden
      const randomizedQuestion = randomizeQuestionOptions({
        question: q.question,
        options: q.options,
        correct: q.correct,
        explanation: q.explanation,
        difficulty: q.difficulty,
        page_reference: q.page_reference
      });

      return {
        ...randomizedQuestion,
        id: q.id, // Mantener el ID para tracking
        isReview: true // Flag para indicar que es una pregunta de repaso
      };
    });

    console.log(`✅ Test de repaso generado: ${reviewQuestions.length} preguntas del tema ${topicId}`);

    res.json({
      examId: Date.now(),
      questions: reviewQuestions,
      topics: [topicId],
      questionCount: reviewQuestions.length,
      isReview: true // Indicar que es un test de repaso
    });

  } catch (error) {
    console.error('❌ Error generando test de repaso:', error);
    res.status(500).json({ error: 'Error al generar test de repaso' });
  }
});

// ========================
// EXAMEN OFICIAL (SIMULACRO)
// ========================

app.post('/api/exam/official', requireAuth, examLimiter, async (req, res) => {
  try {
    const { questionCount } = req.body; // 25, 50, 75, 100
    const userId = req.user.id;

    // Validar questionCount
    if (![25, 50, 75, 100].includes(questionCount)) {
      return res.status(400).json({ error: 'Número de preguntas inválido. Use 25, 50, 75 o 100.' });
    }

    console.log(`🎓 Usuario ${userId} solicita EXAMEN OFICIAL de ${questionCount} preguntas`);

    // Obtener todos los temas disponibles (solo los activos)
    const enabledIds = new Set(db.getEnabledTopicIds());
    const allTopics = Object.keys(TOPIC_CONFIG).filter(id => enabledIds.has(id));

    if (allTopics.length === 0) {
      return res.status(503).json({ error: 'No hay temas activos disponibles para examen' });
    }

    // Calcular cuántas preguntas por tema (distribución equitativa)
    const questionsPerTopic = Math.ceil(questionCount / allTopics.length);

    console.log(`📚 Generando ${questionsPerTopic} preguntas por tema de ${allTopics.length} temas activos`);

    // Obtener todo el contenido mezclado de todos los temas
    const allContent = await getDocumentsByTopics(allTopics);

    if (!allContent || !allContent.trim()) {
      return res.status(404).json({
        error: 'No se encontró contenido para los temas'
      });
    }

    // Dividir en chunks de 1000 caracteres (optimizado)
    const chunks = splitIntoChunks(allContent, 1000);
    console.log(`📄 Documento dividido en ${chunks.length} chunks de todos los temas`);

    if (chunks.length === 0) {
      return res.status(404).json({ error: 'No hay contenido suficiente' });
    }

    const topicId = 'examen-oficial'; // ID especial para examen oficial
    let allGeneratedQuestions = [];

    // 🔴 SOBRE-GENERAR 10% para asegurar que lleguemos al mínimo después de filtrar inválidas
    // Ejemplo: piden 100 → generamos 110 → devolvemos 100 válidas
    const bufferPercentage = 0.10; // 10% extra
    const totalToGenerate = Math.ceil(questionCount * (1 + bufferPercentage));

    // SISTEMA 3 NIVELES: 20% simples / 60% medias / 20% elaboradas
    const simpleNeeded = Math.round(totalToGenerate * 0.20);
    const mediaNeeded = Math.round(totalToGenerate * 0.60);
    const elaboratedNeeded = totalToGenerate - simpleNeeded - mediaNeeded;

    const simpleCalls = Math.ceil(simpleNeeded / 2);
    const mediaCalls = Math.ceil(mediaNeeded / 2);
    const elaboratedCalls = Math.ceil(elaboratedNeeded / 2);

    console.log(`🎯 Plan con buffer del ${Math.round(bufferPercentage * 100)}%: ${totalToGenerate} preguntas (${simpleNeeded} simples + ${mediaNeeded} medias + ${elaboratedNeeded} elaboradas) para entregar ${questionCount}`);

    // 🚀 OPTIMIZACIÓN: Intentar obtener preguntas del CACHÉ primero (que el usuario NO ha visto)
    console.log(`💾 Intentando obtener preguntas del caché...`);

    const cachedSimple = [];
    const cachedMedia = [];
    const cachedElaborada = [];

    // FIX: Rastrear IDs ya usados en esta request para prevenir duplicados por race condition
    const usedIds = [];

    // Intentar obtener preguntas simples del caché
    for (let i = 0; i < simpleNeeded && cachedSimple.length < simpleNeeded; i++) {
      const cached = db.getCachedQuestion(userId, allTopics, 'simple', usedIds);
      if (cached) {
        usedIds.push(cached.cacheId); // Agregar a lista de exclusión para próximas queries
        cached.question._cacheId = cached.cacheId;
        cachedSimple.push(cached.question);
        db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
      } else {
        break; // No más en caché
      }
    }

    // Intentar obtener preguntas medias del caché
    for (let i = 0; i < mediaNeeded && cachedMedia.length < mediaNeeded; i++) {
      const cached = db.getCachedQuestion(userId, allTopics, 'media', usedIds);
      if (cached) {
        usedIds.push(cached.cacheId); // Agregar a lista de exclusión para próximas queries
        cached.question._cacheId = cached.cacheId;
        cachedMedia.push(cached.question);
        db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
      } else {
        break; // No más en caché
      }
    }

    // Intentar obtener preguntas elaboradas del caché
    for (let i = 0; i < elaboratedNeeded && cachedElaborada.length < elaboratedNeeded; i++) {
      const cached = db.getCachedQuestion(userId, allTopics, 'elaborada', usedIds);
      if (cached) {
        usedIds.push(cached.cacheId); // Agregar a lista de exclusión para próximas queries
        cached.question._cacheId = cached.cacheId;
        cachedElaborada.push(cached.question);
        db.markQuestionAsSeen(userId, cached.cacheId, 'exam');
      } else {
        break; // No más en caché
      }
    }

    console.log(`✅ Obtenidas del caché: ${cachedSimple.length} simples, ${cachedMedia.length} medias, ${cachedElaborada.length} elaboradas`);
    allGeneratedQuestions.push(...cachedSimple, ...cachedMedia, ...cachedElaborada);

    // Calcular cuántas faltan por generar
    const simpleMissing = simpleNeeded - cachedSimple.length;
    const mediaMissing = mediaNeeded - cachedMedia.length;
    const elaboratedMissing = elaboratedNeeded - cachedElaborada.length;

    const totalMissing = simpleMissing + mediaMissing + elaboratedMissing;
    console.log(`🔨 Faltan por generar: ${simpleMissing} simples, ${mediaMissing} medias, ${elaboratedMissing} elaboradas (total: ${totalMissing})`);

    // Si faltan preguntas, generarlas en PARALELO CONTROLADO (más rápido pero sin saturar API)
    if (totalMissing > 0) {
      const promiseFunctions = [];
      const MAX_CONCURRENT_CALLS = 20; // Máximo 20 llamadas simultáneas (sincronizado con claudeLimiter)

      // Generar preguntas SIMPLES faltantes en paralelo
      const simpleCallsMissing = Math.ceil(simpleMissing / 2);
      for (let i = 0; i < simpleCallsMissing; i++) {
        const promiseFn = async () => {
          const chunk1Index = Math.floor(Math.random() * chunks.length);
          const minDistance = Math.max(3, Math.floor(chunks.length * 0.5));
          let chunk2Index;
          do {
            chunk2Index = Math.floor(Math.random() * chunks.length);
          } while (Math.abs(chunk2Index - chunk1Index) < minDistance && chunks.length > 1);

          const chunk1 = chunks[chunk1Index];
          const chunk2 = chunks[chunk2Index];
          const fullPrompt = renderPrompt(CLAUDE_PROMPT_SIMPLE, chunk1, chunk2, userId, null);

          try {
            const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.simple, 'simple', 2);
            const responseText = extractClaudeResponseText(response);
            const questionsData = parseClaudeResponse(responseText);
            console.log(`⚪ SIMPLE ${i + 1}/${simpleCallsMissing} generadas`);
            return questionsData?.questions || [];
          } catch (error) {
            console.error(`❌ Error en simple ${i + 1}:`, error.message);
            return [];
          }
        };
        promiseFunctions.push(promiseFn);
      }

      // Generar preguntas MEDIAS faltantes en paralelo
      const mediaCallsMissing = Math.ceil(mediaMissing / 2);
      for (let i = 0; i < mediaCallsMissing; i++) {
        const promiseFn = async () => {
          const chunk1Index = Math.floor(Math.random() * chunks.length);
          const minDistance = Math.max(3, Math.floor(chunks.length * 0.5));
          let chunk2Index;
          do {
            chunk2Index = Math.floor(Math.random() * chunks.length);
          } while (Math.abs(chunk2Index - chunk1Index) < minDistance && chunks.length > 1);

          const chunk1 = chunks[chunk1Index];
          const chunk2 = chunks[chunk2Index];
          const fullPrompt = renderPrompt(CLAUDE_PROMPT_MEDIA, chunk1, chunk2, userId, null);

          try {
            const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.media, 'media', 2);
            const responseText = extractClaudeResponseText(response);
            const questionsData = parseClaudeResponse(responseText);
            console.log(`🔵 MEDIA ${i + 1}/${mediaCallsMissing} generadas`);
            return questionsData?.questions || [];
          } catch (error) {
            console.error(`❌ Error en media ${i + 1}:`, error.message);
            return [];
          }
        };
        promiseFunctions.push(promiseFn);
      }

      // Generar preguntas ELABORADAS faltantes en paralelo
      const elaboratedCallsMissing = Math.ceil(elaboratedMissing / 2);
      for (let i = 0; i < elaboratedCallsMissing; i++) {
        const promiseFn = async () => {
          const chunk1Index = Math.floor(Math.random() * chunks.length);
          const minDistance = Math.max(3, Math.floor(chunks.length * 0.5));
          let chunk2Index;
          do {
            chunk2Index = Math.floor(Math.random() * chunks.length);
          } while (Math.abs(chunk2Index - chunk1Index) < minDistance && chunks.length > 1);

          const chunk1 = chunks[chunk1Index];
          const chunk2 = chunks[chunk2Index];
          const fullPrompt = renderPrompt(CLAUDE_PROMPT_ELABORADA, chunk1, chunk2, userId, null);

          try {
            const response = await callClaudeWithImprovedRetry(fullPrompt, MAX_TOKENS_CONFIG.elaborada, 'elaborada', 2);
            const responseText = extractClaudeResponseText(response);
            const questionsData = parseClaudeResponse(responseText);
            console.log(`🔴 ELABORADA ${i + 1}/${elaboratedCallsMissing} generadas`);
            return questionsData?.questions || [];
          } catch (error) {
            console.error(`❌ Error en elaborada ${i + 1}:`, error.message);
            return [];
          }
        };
        promiseFunctions.push(promiseFn);
      }

      // Ejecutar con límite de concurrencia para no saturar Claude API
      console.log(`⏳ Ejecutando ${promiseFunctions.length} llamadas con límite de ${MAX_CONCURRENT_CALLS} concurrentes...`);
      const results = await executeWithConcurrencyLimit(promiseFunctions, MAX_CONCURRENT_CALLS);

      // Agregar todas las preguntas generadas
      for (const questions of results) {
        allGeneratedQuestions.push(...questions);
      }

      console.log(`✅ Generación paralela completada: ${results.flat().length} preguntas nuevas generadas`);
    }

    // Validar que tenemos AL MENOS las preguntas solicitadas (gracias al buffer del 10%)
    console.log(`📊 Generadas ${allGeneratedQuestions.length} preguntas (solicitadas: ${questionCount})`);

    if (allGeneratedQuestions.length < questionCount) {
      return res.status(500).json({
        error: 'No se pudieron generar suficientes preguntas',
        details: `Solo se generaron ${allGeneratedQuestions.length} de ${questionCount} preguntas solicitadas (incluso con buffer del 10%). Por favor, intenta de nuevo en unos minutos.`,
        generated: allGeneratedQuestions.length,
        requested: questionCount
      });
    }

    // Éxito: tenemos suficientes preguntas gracias al buffer
    if (allGeneratedQuestions.length > questionCount) {
      const surplus = allGeneratedQuestions.length - questionCount;
      console.log(`✅ Buffer funcionó: ${allGeneratedQuestions.length} generadas, usando ${questionCount}, guardando ${surplus} sobrantes en caché`);

      // Guardar preguntas sobrantes en el caché para reutilizarlas
      const surplusQuestions = allGeneratedQuestions.slice(questionCount);
      let savedCount = 0;

      for (const question of surplusQuestions) {
        try {
          const cacheId = db.saveToCache(topicId, question.difficulty || 'media', question);
          if (cacheId) savedCount++;
        } catch (error) {
          console.error('Error guardando pregunta sobrante en caché:', error);
        }
      }

      console.log(`💾 ${savedCount}/${surplus} preguntas sobrantes guardadas en caché para uso futuro`);
    } else {
      console.log(`✅ Generación exacta: ${allGeneratedQuestions.length} preguntas`);
    }

    // 🔴 FIX: Eliminar preguntas duplicadas antes de enviar al usuario
    const uniqueQuestions = [];
    const seenQuestions = new Set();

    for (const q of allGeneratedQuestions) {
      // Usar el texto de la pregunta como identificador único
      const questionKey = q.question?.trim().toLowerCase();

      if (questionKey && !seenQuestions.has(questionKey)) {
        seenQuestions.add(questionKey);
        uniqueQuestions.push(q);
      }
    }

    const duplicatesRemoved = allGeneratedQuestions.length - uniqueQuestions.length;
    if (duplicatesRemoved > 0) {
      console.log(`🗑️ Eliminadas ${duplicatesRemoved} preguntas duplicadas`);
    }

    // Verificar que aún tenemos suficientes después de eliminar duplicadas
    if (uniqueQuestions.length < questionCount) {
      return res.status(500).json({
        error: 'No se pudieron generar suficientes preguntas únicas',
        details: `Solo se generaron ${uniqueQuestions.length} preguntas únicas de ${questionCount} solicitadas (se encontraron ${duplicatesRemoved} duplicadas). Por favor, intenta de nuevo.`,
        generated: uniqueQuestions.length,
        requested: questionCount,
        duplicates: duplicatesRemoved
      });
    }

    // Validar y aleatorizar todas las preguntas generadas
    const finalQuestions = uniqueQuestions.slice(0, questionCount).map((q, index) => {
      if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) {
        q.options = q.options || ["A) Opción 1", "B) Opción 2", "C) Opción 3", "D) Opción 4"];
      }
      q.correct = q.correct ?? 0;
      q.explanation = q.explanation || "Explicación no disponible.";
      q.difficulty = q.difficulty || "media";
      q.page_reference = q.page_reference || "Examen Oficial";

      // Aleatorizar orden de las opciones
      return randomizeQuestionOptions(q);
    });

    // Mezclar aleatoriamente las preguntas (shuffle Fisher-Yates)
    for (let i = finalQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [finalQuestions[i], finalQuestions[j]] = [finalQuestions[j], finalQuestions[i]];
    }

    console.log(`✅ Examen oficial generado: ${finalQuestions.length} preguntas mezcladas`);

    res.json({
      examId: Date.now(),
      questions: finalQuestions,
      questionCount: finalQuestions.length,
      isOfficial: true,
      topics: allTopics,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error generando examen oficial:', error);
    res.status(500).json({ error: 'Error al generar examen oficial' });
  }
});

// Guardar preguntas falladas del examen oficial
app.post('/api/exam/save-failed', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const { examId, examName, failedQuestions } = req.body;

    console.log(`💾 Usuario ${userId} guardando ${failedQuestions.length} preguntas falladas del "${examName}"`);

    // Guardar cada pregunta fallada con el examId como topic_id
    let savedCount = 0;
    for (const answer of failedQuestions) {
      const questionData = {
        question: answer.question,
        options: answer.options,
        correct: answer.correctAnswer,
        explanation: answer.explanation,
        difficulty: answer.difficulty || 'media',
        page_reference: answer.page_reference || ''
      };

      const result = db.addFailedQuestion(
        userId,
        examId,  // Usar examId como topic_id (ej: "examen-25-1234567890")
        questionData,
        answer.userAnswer
      );

      if (result.success && !result.duplicate) {
        savedCount++;
      }
    }

    console.log(`✅ Guardadas ${savedCount} preguntas nuevas del examen (${failedQuestions.length - savedCount} duplicadas omitidas)`);

    res.json({
      success: true,
      savedCount,
      examId,
      examName
    });

  } catch (error) {
    console.error('❌ Error guardando preguntas falladas del examen:', error);
    res.status(500).json({ error: 'Error al guardar preguntas falladas' });
  }
});

app.post('/api/resolve-failed-question', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const { questionId } = req.body;

    // Eliminar pregunta fallada de la base de datos
    db.removeFailedQuestion(userId, questionId);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error resolviendo pregunta:', error);
    res.status(500).json({ error: 'Error al resolver pregunta' });
  }
});

app.get('/api/documents-status', async (req, res) => {
  try {
    const status = {};
    
    for (const [topicId, config] of Object.entries(TOPIC_CONFIG)) {
      status[topicId] = {
        title: config.title,
        description: config.description,
        files: []
      };
      
      for (const fileName of config.files) {
        const filePath = path.join(DOCUMENTS_DIR, fileName);
        try {
          await fs.access(filePath);
          status[topicId].files.push({ name: fileName, exists: true });
        } catch {
          status[topicId].files.push({ name: fileName, exists: false });
        }
      }
    }
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Error verificando documentos' });
  }
});

app.get('/api/health', (req, res) => {
  try {
    // Contar usuarios activos en la base de datos
    const users = db.db.prepare('SELECT COUNT(*) as count FROM users WHERE estado = ?').get('activo');
    const totalUsers = db.db.prepare('SELECT COUNT(*) as count FROM users').get();

    res.json({
      status: 'OK',
      message: 'Servidor funcionando',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      topics: Object.keys(TOPIC_CONFIG).length,
      totalUsers: totalUsers.count,
      activeUsers: users.count,
      database: 'SQLite - Conectado'
    });
  } catch (error) {
    res.json({
      status: 'OK',
      message: 'Servidor funcionando',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      topics: Object.keys(TOPIC_CONFIG).length,
      database: 'Error al conectar'
    });
  }
});

// Middleware de errores
app.use((error, req, res, next) => {
  console.error('❌ Error:', error);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

// 404 para rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.originalUrl
  });
});

// ========================
// PRE-GENERACIÓN MENSUAL DE CACHÉ
// ========================

/**
 * Pre-generar 15 preguntas de cada tema para caché mensual con sistema robusto
 * Distribución: 3 simple, 9 media, 3 elaborada (20/60/20)
 * GARANTIZA 15 preguntas por tema con reintentos automáticos
 */
async function preGenerateMonthlyCache() {
  console.log('\n🚀 ========================================');
  console.log('🚀 INICIO PRE-GENERACIÓN MENSUAL DE CACHÉ');
  console.log('🚀 ========================================\n');

  const startTime = Date.now();
  // Solo pre-generar para temas activos (evita gastar tokens en temas desactivados)
  const enabledIds = new Set(db.getEnabledTopicIds());
  const allTopics = Object.keys(TOPIC_CONFIG).filter(id => enabledIds.has(id));
  if (allTopics.length === 0) {
    console.log('⏭️  No hay temas activos. Pre-generación mensual cancelada.');
    return;
  }
  const SYSTEM_USER_ID = 0; // Usuario especial para pre-generación
  const QUESTIONS_PER_TOPIC = 100; // 100 preguntas por tema para 90% cache hit rate
  const MAX_RETRIES_PER_DIFFICULTY = 3; // Reintentos máximos por dificultad

  // Distribución 20/60/20
  const distribution = {
    'simple': 20,      // 20% de 100 = 20
    'media': 60,       // 60% de 100 = 60
    'elaborada': 20    // 20% de 100 = 20
  };

  let totalGenerated = 0;
  let totalExpected = allTopics.length * QUESTIONS_PER_TOPIC;
  const topicResults = [];

  // Procesar cada tema
  for (const topicId of allTopics) {
    const topicTitle = TOPIC_CONFIG[topicId].title;
    console.log(`\n📚 Procesando: ${topicTitle}`);
    console.log(`   Objetivo: ${QUESTIONS_PER_TOPIC} preguntas (20S + 60M + 20E)`);

    let topicGenerated = 0;
    const difficultyResults = {};

    // Generar por dificultad con reintentos
    for (const [difficulty, targetCount] of Object.entries(distribution)) {
      console.log(`\n   🎯 Generando ${targetCount} preguntas ${difficulty.toUpperCase()}...`);

      let generated = 0;
      let attempts = 0;

      // Reintentos hasta conseguir todas las preguntas o agotar intentos
      while (generated < targetCount && attempts < MAX_RETRIES_PER_DIFFICULTY) {
        attempts++;
        const remaining = targetCount - generated;

        try {
          console.log(`   🔄 Intento ${attempts}/${MAX_RETRIES_PER_DIFFICULTY} (faltan ${remaining})...`);

          // Usar generateQuestionBatch con cacheProb=0 (siempre genera nuevas)
          const questions = await generateQuestionBatch(SYSTEM_USER_ID, topicId, remaining, 0);

          if (questions && questions.length > 0) {
            generated += questions.length;
            topicGenerated += questions.length;
            totalGenerated += questions.length;

            console.log(`   ✅ ${questions.length} preguntas generadas (total: ${generated}/${targetCount})`);

            if (generated >= targetCount) {
              console.log(`   🎉 ${difficulty.toUpperCase()} completado!`);
              break;
            }
          } else {
            console.warn(`   ⚠️  generateQuestionBatch retornó 0 preguntas`);
          }

        } catch (error) {
          console.error(`   ❌ Error en intento ${attempts}:`, error.message);

          // Si es error de rate limit, pausar más tiempo
          if (error.message.includes('rate') || error.message.includes('429')) {
            const backoffTime = attempts * 5000; // 5s, 10s, 15s
            console.log(`   ⏳ Rate limit detectado - Pausa de ${backoffTime/1000}s...`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
          }
        }

        // Pausa entre intentos (progresiva)
        if (generated < targetCount && attempts < MAX_RETRIES_PER_DIFFICULTY) {
          const pauseTime = 2000 + (attempts * 1000); // 2s, 3s, 4s
          await new Promise(resolve => setTimeout(resolve, pauseTime));
        }
      }

      // Guardar resultado de esta dificultad
      difficultyResults[difficulty] = {
        expected: targetCount,
        generated: generated,
        success: generated === targetCount
      };

      if (generated < targetCount) {
        console.error(`   ⚠️  ${difficulty.toUpperCase()} incompleto: ${generated}/${targetCount} (faltan ${targetCount - generated})`);
      }

      // Pausa entre dificultades
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Resultado del tema
    const topicSuccess = topicGenerated === QUESTIONS_PER_TOPIC;
    topicResults.push({
      topicId,
      topicTitle,
      expected: QUESTIONS_PER_TOPIC,
      generated: topicGenerated,
      success: topicSuccess,
      details: difficultyResults
    });

    if (topicSuccess) {
      console.log(`   ✅ Tema completado: ${topicGenerated}/${QUESTIONS_PER_TOPIC} preguntas`);
    } else {
      console.error(`   ⚠️  Tema incompleto: ${topicGenerated}/${QUESTIONS_PER_TOPIC} preguntas (faltan ${QUESTIONS_PER_TOPIC - topicGenerated})`);
    }
  }

  // Resumen final
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const cost = (totalGenerated * 0.0025).toFixed(2);
  const successfulTopics = topicResults.filter(t => t.success).length;
  const successRate = ((totalGenerated / totalExpected) * 100).toFixed(1);

  console.log('\n🎉 ========================================');
  console.log('🎉 PRE-GENERACIÓN COMPLETADA');
  console.log('🎉 ========================================');
  console.log(`📊 Temas procesados: ${allTopics.length}`);
  console.log(`✅ Temas completos (100/100): ${successfulTopics}/${allTopics.length}`);
  console.log(`📈 Tasa de éxito: ${successRate}%`);
  console.log(`✅ Preguntas generadas: ${totalGenerated}/${totalExpected}`);
  console.log(`⏱️  Tiempo total: ${duration} minutos`);
  console.log(`💰 Costo estimado: $${cost}`);

  // Mostrar temas incompletos
  const incompleteTopics = topicResults.filter(t => !t.success);
  if (incompleteTopics.length > 0) {
    console.log('\n⚠️  TEMAS INCOMPLETOS:');
    incompleteTopics.forEach(topic => {
      console.log(`   - ${topic.topicTitle}: ${topic.generated}/${topic.expected}`);
      Object.entries(topic.details).forEach(([diff, result]) => {
        if (!result.success) {
          console.log(`     • ${diff}: ${result.generated}/${result.expected}`);
        }
      });
    });
  }

  console.log('🎉 ========================================\n');

  // Retornar resultados para posible logging/alertas
  return {
    success: successfulTopics === allTopics.length,
    totalGenerated,
    totalExpected,
    successRate: parseFloat(successRate),
    duration: parseFloat(duration),
    cost: parseFloat(cost),
    topicResults
  };
}

// ========================
// INICIALIZACIÓN OPTIMIZADA
// ========================

async function startServer() {
  try {
    // Verificar API key
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ ANTHROPIC_API_KEY no encontrada');
      process.exit(1);
    }
    
    // Crear directorio de documentos
    await ensureDocumentsDirectory();
    
    // Contar archivos disponibles
    let availableFiles = 0;
    let totalFiles = Object.keys(TOPIC_CONFIG).length;
    
    for (const [topicId, config] of Object.entries(TOPIC_CONFIG)) {
      for (const fileName of config.files) {
        try {
          await fs.access(path.join(DOCUMENTS_DIR, fileName));
          availableFiles++;
          break;
        } catch {}
      }
    }
    
    // Iniciar servidor
    app.listen(port, '0.0.0.0', () => {
      console.log('\n🚀 ========================================');
      console.log('   SERVIDOR DE OPOSICIONES ONLINE');
      console.log('========================================');
      console.log(`📡 Puerto: ${port}`);
      console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🤖 Claude API: ✅ Configurada`);
      console.log(`📚 Temas: ${Object.keys(TOPIC_CONFIG).length}`);
      console.log(`📄 Archivos: ${availableFiles}/${totalFiles}`);
      console.log(`\n✅ Aplicación disponible en:`);
      console.log(`   Local: http://localhost:${port}`);
      console.log(`   Render: Tu URL de Render`);
      console.log('\n🎯 ¡Sistema listo para generar exámenes!');
      console.log('========================================\n');

      // FASE 2: Limpiar buffers expirados cada 6 horas
      // 🔴 FIX: Caché NO se limpia por tiempo, solo por límite (10,000 → elimina 1000)
      setInterval(() => {
        console.log('🧹 Ejecutando limpieza periódica de buffers...');
        const buffersDeleted = db.cleanExpiredBuffers();
        // cleanExpiredCache() REMOVIDO - caché nunca expira por tiempo
        console.log(`✅ Limpieza completada: ${buffersDeleted} buffers eliminados`);
      }, 6 * 60 * 60 * 1000); // 6 horas

      // 🔴 FIX: Limpiar documentsCache Map cada 15 minutos (previene memory leak)
      setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, value] of documentsCache.entries()) {
          if (now - value.timestamp > DOCUMENT_CACHE_TTL) {
            documentsCache.delete(key);
            cleaned++;
          }
        }
        if (cleaned > 0) {
          console.log(`🧹 Limpieza documentsCache: ${cleaned} temas eliminados (${documentsCache.size} restantes)`);
        }
      }, 15 * 60 * 1000); // 15 minutos

      console.log('⏰ Limpieza automática de buffers cada 6 horas\n');
      console.log('⏰ Limpieza automática de documentsCache cada 15 minutos\n');
      console.log('💾 Caché de preguntas: sin expiración por tiempo (solo límite 75,000)\n');

      // PRE-GENERACIÓN MENSUAL: DESHABILITADO - Ejecutar manualmente si es necesario
      // El caché persiste indefinidamente (expires_at = año 2100, max 75,000 preguntas)
      // Para ejecutar manualmente, llamar a preGenerateMonthlyCache() desde Node.js
      /*
      cron.schedule('0 3 1 * *', async () => {
        console.log('📅 Cron: Iniciando pre-generación mensual...');
        try {
          await preGenerateMonthlyCache();
        } catch (error) {
          console.error('❌ Error en pre-generación mensual:', error);
        }
      }, {
        timezone: "Europe/Madrid"  // Ajusta a tu zona horaria
      });
      */

      console.log('📅 Pre-generación mensual: DESHABILITADA (caché persiste indefinidamente)\n');
    });
    
  } catch (error) {
    console.error('❌ Error iniciando servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando servidor...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido...');
  process.exit(0);
});

// Iniciar servidor
startServer();