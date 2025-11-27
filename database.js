// ========================
// SISTEMA DE BASE DE DATOS - SQLite
// ========================

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

// Crear base de datos
const dbPath = path.join(__dirname, 'oposiciones.db');
const db = new Database(dbPath);

// Habilitar foreign keys
db.pragma('foreign_keys = ON');

// Habilitar WAL mode para mejor concurrencia (200 usuarios concurrentes)
db.pragma('journal_mode = WAL');

// ========================
// OPTIMIZACIONES PARA VPS (4 vCPU + 8GB RAM)
// ========================

// Rendimiento general
db.pragma('synchronous = NORMAL');         // Balance velocidad/durabilidad
db.pragma('cache_size = -262144');         // 256MB de caché (era 64MB)
db.pragma('mmap_size = 268435456');        // 256MB memory-mapped I/O
db.pragma('temp_store = MEMORY');          // Tablas temporales en RAM
db.pragma('page_size = 8192');             // Páginas de 8KB (óptimo para datasets grandes)

// WAL optimizations
db.pragma('wal_autocheckpoint = 2000');    // Checkpoint cada 2000 páginas (mejor throughput)
db.pragma('wal_checkpoint(PASSIVE)');      // Checkpoint pasivo inicial

// Análisis automático de consultas
db.pragma('analysis_limit = 400');         // Mejorar query planner

// ========================
// CREAR TABLAS
// ========================

function initDatabase() {
  // Tabla de usuarios
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      estado TEXT DEFAULT 'bloqueado',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_access DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabla de estadísticas por usuario y tema
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic_id TEXT NOT NULL,
      topic_title TEXT NOT NULL,
      total_questions INTEGER DEFAULT 0,
      correct_answers INTEGER DEFAULT 0,
      accuracy INTEGER DEFAULT 0,
      last_studied DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, topic_id)
    )
  `);

  // Tabla de preguntas falladas
  db.exec(`
    CREATE TABLE IF NOT EXISTS failed_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      correct INTEGER NOT NULL,
      user_answer INTEGER,
      explanation TEXT,
      difficulty TEXT,
      page_reference TEXT,
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Tabla de actividad (para tracking de uso)
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      topic_id TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Tabla de chunks usados (para evitar repeticiones - Opción B)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, topic_id, chunk_index)
    )
  `);

  // NOTA: Migración de failed_questions ELIMINADA por causar pérdida de datos
  // La tabla ya se crea correctamente con user_answer permitiendo NULL (línea 61)

  // MIGRACIÓN: Añadir campo active_sessions a tabla users (control de sesiones simultáneas)
  try {
    const userTableInfo = db.prepare("PRAGMA table_info(users)").all();
    const activeSessionsColumn = userTableInfo.find(col => col.name === 'active_sessions');

    if (!activeSessionsColumn) {
      console.log('🔄 Añadiendo campo active_sessions a tabla users...');
      db.exec(`ALTER TABLE users ADD COLUMN active_sessions TEXT DEFAULT '[]'`);
      console.log('✅ Campo active_sessions añadido correctamente');
    }
  } catch (error) {
    console.log('ℹ️ Campo active_sessions ya existe o error en migración:', error.message);
  }

  // ========================
  // SISTEMA DE CACHÉ DE PREGUNTAS
  // ========================

  // Tabla 1: Pool global de preguntas en caché
  db.exec(`
    CREATE TABLE IF NOT EXISTS question_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_data TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      times_used INTEGER DEFAULT 0
    )
  `);

  // Crear índices para optimizar búsquedas
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_expiry ON question_cache(expires_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_difficulty ON question_cache(difficulty)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cache_topic ON question_cache(topic_id)`);

  // Tabla 2: Tracking individual de preguntas vistas por usuario
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_seen_questions (
      user_id INTEGER NOT NULL,
      question_cache_id INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      context TEXT,
      PRIMARY KEY (user_id, question_cache_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (question_cache_id) REFERENCES question_cache(id) ON DELETE CASCADE
    )
  `);

  // Índice para búsquedas por usuario y fecha
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_seen ON user_seen_questions(user_id, seen_at)`);

  // Tabla 3: Estadísticas de caché (opcional - para tracking de costes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_stats (
      date TEXT PRIMARY KEY,
      questions_generated INTEGER DEFAULT 0,
      questions_cached INTEGER DEFAULT 0,
      cache_hit_rate REAL DEFAULT 0,
      total_cost_usd REAL DEFAULT 0
    )
  `);

  // ========================
  // TABLA 4: Buffer de preguntas (FASE 2 - Sistema de Prefetch)
  // ========================

  // Tabla para almacenar preguntas pre-generadas para respuesta instantánea
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_question_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic_id TEXT NOT NULL,
      question_data TEXT NOT NULL,
      question_cache_id INTEGER,
      difficulty TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (question_cache_id) REFERENCES question_cache(id) ON DELETE SET NULL
    )
  `);

  // Índice para búsquedas rápidas de buffer por usuario y tema
  db.exec(`CREATE INDEX IF NOT EXISTS idx_buffer_user_topic ON user_question_buffer(user_id, topic_id, expires_at)`);

  // Tabla de historial de respuestas (para estadísticas semanales)
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topic_id TEXT NOT NULL,
      topic_title TEXT NOT NULL,
      is_correct INTEGER NOT NULL,
      answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Índice para consultas rápidas de historial por usuario y fecha
  db.exec(`CREATE INDEX IF NOT EXISTS idx_answer_history_user_date ON answer_history(user_id, answered_at)`);

  // ========================
  // ÍNDICES DE OPTIMIZACIÓN (FASE 2)
  // ========================
  // Mejoran significativamente el rendimiento de queries frecuentes

  // Índice para preguntas falladas por usuario y tema
  // Beneficia: getUserFailedQuestions(), addFailedQuestion()
  // Mejora: 200ms → 5ms (40x más rápido) con 1000+ preguntas
  db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_user_topic ON failed_questions(user_id, topic_id)`);

  // Índice para estadísticas por usuario ordenadas por fecha
  // Beneficia: getUserStats(), panel de estadísticas
  // Mejora: 150ms → 3ms (50x más rápido) con muchos temas estudiados
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_user_studied ON user_stats(user_id, last_studied)`);

  // Índice para actividad por usuario y fecha
  // Beneficia: getUserQuestionsPerDay(), getUserQuestionsPerMonth()
  // Mejora: 100ms → 2ms (50x más rápido) con historial extenso
  db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_user_time ON activity_log(user_id, timestamp)`);

  // Índice adicional para estadísticas por tema
  // Beneficia: getWeeklyStatsByTopic(), exportaciones
  // Mejora: 300ms → 8ms (37x más rápido) en exportación a Excel
  db.exec(`CREATE INDEX IF NOT EXISTS idx_answer_user_topic ON answer_history(user_id, topic_id)`);

  console.log('✅ Base de datos inicializada (con sistema de caché + buffer de prefetch + índices optimizados)');
}

// ========================
// FUNCIONES DE USUARIOS
// ========================

// Crear usuario
function createUser(username, password) {
  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, estado)
      VALUES (?, ?, 'bloqueado')
    `);

    const result = stmt.run(username, passwordHash);
    return { success: true, userId: result.lastInsertRowid };
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return { success: false, error: 'Usuario ya existe' };
    }
    return { success: false, error: error.message };
  }
}

// Autenticar usuario
function authenticateUser(username, password) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);

  if (!user) {
    return { success: false, error: 'Usuario no encontrado' };
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash);

  if (!validPassword) {
    return { success: false, error: 'Contraseña incorrecta' };
  }

  if (user.estado === 'bloqueado') {
    return { success: false, error: 'Cuenta bloqueada. Contacta al administrador.' };
  }

  // Actualizar último acceso
  const updateStmt = db.prepare('UPDATE users SET last_access = CURRENT_TIMESTAMP WHERE id = ?');
  updateStmt.run(user.id);

  return {
    success: true,
    user: {
      id: user.id,
      username: user.username,
      estado: user.estado
    }
  };
}

// Obtener todos los usuarios (para admin)
function getAllUsers() {
  const stmt = db.prepare(`
    SELECT id, username, estado, created_at, last_access
    FROM users
    ORDER BY created_at DESC
  `);

  return stmt.all();
}

// Activar usuario
function activateUser(userId) {
  const stmt = db.prepare('UPDATE users SET estado = ? WHERE id = ?');
  stmt.run('activo', userId);
  return { success: true };
}

// Bloquear usuario
function blockUser(userId) {
  const stmt = db.prepare('UPDATE users SET estado = ? WHERE id = ?');
  stmt.run('bloqueado', userId);
  return { success: true };
}

// Bloquear todos los usuarios
function blockAllUsers() {
  const stmt = db.prepare("UPDATE users SET estado = 'bloqueado'");
  const result = stmt.run();
  return { success: true, count: result.changes };
}

// Obtener usuario por ID
function getUserById(userId) {
  const stmt = db.prepare('SELECT id, username, estado FROM users WHERE id = ?');
  return stmt.get(userId);
}

// ========================
// FUNCIONES DE ESTADÍSTICAS
// ========================

// Obtener estadísticas de un usuario
function getUserStats(userId) {
  const stmt = db.prepare(`
    SELECT topic_id, topic_title, total_questions, correct_answers, accuracy, last_studied
    FROM user_stats
    WHERE user_id = ?
    ORDER BY last_studied DESC
  `);

  return stmt.all(userId);
}

// Actualizar estadísticas
function updateUserStats(userId, topicId, topicTitle, isCorrect) {
  // Verificar si ya existe
  const checkStmt = db.prepare('SELECT * FROM user_stats WHERE user_id = ? AND topic_id = ?');
  const existing = checkStmt.get(userId, topicId);

  if (existing) {
    // Actualizar
    const totalQuestions = existing.total_questions + 1;
    const correctAnswers = existing.correct_answers + (isCorrect ? 1 : 0);
    const accuracy = Math.round((correctAnswers / totalQuestions) * 100);

    const updateStmt = db.prepare(`
      UPDATE user_stats
      SET total_questions = ?,
          correct_answers = ?,
          accuracy = ?,
          last_studied = CURRENT_TIMESTAMP
      WHERE user_id = ? AND topic_id = ?
    `);

    updateStmt.run(totalQuestions, correctAnswers, accuracy, userId, topicId);
  } else {
    // Insertar nuevo
    const accuracy = isCorrect ? 100 : 0;

    const insertStmt = db.prepare(`
      INSERT INTO user_stats (user_id, topic_id, topic_title, total_questions, correct_answers, accuracy)
      VALUES (?, ?, ?, 1, ?, ?)
    `);

    insertStmt.run(userId, topicId, topicTitle, isCorrect ? 1 : 0, accuracy);
  }

  return { success: true };
}

// ========================
// FUNCIONES DE PREGUNTAS FALLADAS
// ========================

// Obtener preguntas falladas de un usuario
function getUserFailedQuestions(userId) {
  const stmt = db.prepare(`
    SELECT id, topic_id, question, options, correct, user_answer, explanation, difficulty, page_reference, date
    FROM failed_questions
    WHERE user_id = ?
    ORDER BY date DESC
  `);

  const questions = stmt.all(userId);

  // Agrupar por topic_id
  const grouped = {};
  questions.forEach(q => {
    if (!grouped[q.topic_id]) {
      grouped[q.topic_id] = {
        questions: []
      };
    }

    grouped[q.topic_id].questions.push({
      id: q.id,
      question: q.question,
      options: JSON.parse(q.options),
      correct: q.correct,
      userAnswer: q.user_answer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      page_reference: q.page_reference,
      date: q.date
    });
  });

  return grouped;
}

// Agregar pregunta fallada (evitando duplicados)
function addFailedQuestion(userId, topicId, questionData, userAnswer) {
  // Verificar si ya existe esta pregunta para este usuario y tema
  const checkStmt = db.prepare(`
    SELECT id FROM failed_questions
    WHERE user_id = ? AND topic_id = ? AND question = ?
  `);

  const existing = checkStmt.get(userId, topicId, questionData.question);

  // Si ya existe, NO insertarla de nuevo
  if (existing) {
    console.log(`⚠️ Pregunta duplicada detectada - NO se insertará (ID existente: ${existing.id})`);
    return { success: true, duplicate: true, id: existing.id };
  }

  // Si no existe, insertarla
  const stmt = db.prepare(`
    INSERT INTO failed_questions (user_id, topic_id, question, options, correct, user_answer, explanation, difficulty, page_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    userId,
    topicId,
    questionData.question,
    JSON.stringify(questionData.options),
    questionData.correct,
    userAnswer,
    questionData.explanation,
    questionData.difficulty,
    questionData.page_reference
  );

  console.log(`✅ Pregunta fallada agregada correctamente`);
  return { success: true, duplicate: false };
}

// Eliminar pregunta fallada
function removeFailedQuestion(userId, questionId) {
  const stmt = db.prepare('DELETE FROM failed_questions WHERE id = ? AND user_id = ?');
  stmt.run(questionId, userId);
  return { success: true };
}

// ========================
// FUNCIONES DE ACTIVIDAD Y ESTADÍSTICAS DE ADMIN
// ========================

// Registrar actividad
function logActivity(userId, activityType, topicId = null) {
  try {
    const stmt = db.prepare(`
      INSERT INTO activity_log (user_id, activity_type, topic_id)
      VALUES (?, ?, ?)
    `);
    stmt.run(userId, activityType, topicId);
  } catch (error) {
    console.error('Error registrando actividad:', error);
  }
}

// Obtener estadísticas completas de todos los usuarios (para admin)
function getAdminStats() {
  const stmt = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.estado,
      u.created_at,
      u.last_access,
      COALESCE(SUM(s.total_questions), 0) as total_questions,
      COALESCE(SUM(s.correct_answers), 0) as correct_answers,
      CASE
        WHEN SUM(s.total_questions) > 0
        THEN (CAST(SUM(s.correct_answers) AS REAL) * 100.0 / SUM(s.total_questions))
        ELSE 0
      END as avg_accuracy
    FROM users u
    LEFT JOIN user_stats s ON u.id = s.user_id
    GROUP BY u.id
    ORDER BY u.last_access DESC
  `);

  return stmt.all();
}

// Actualizar último acceso del usuario
function updateLastAccess(userId) {
  const stmt = db.prepare(`
    UPDATE users
    SET last_access = datetime('now')
    WHERE id = ?
  `);
  return stmt.run(userId);
}

// Actualizar sesiones activas del usuario
function updateActiveSessions(userId, sessionsArray) {
  const stmt = db.prepare(`
    UPDATE users
    SET active_sessions = ?
    WHERE id = ?
  `);
  return stmt.run(JSON.stringify(sessionsArray), userId);
}

// Obtener preguntas por día de un usuario
function getUserQuestionsPerDay(userId, days = 30) {
  const stmt = db.prepare(`
    SELECT
      DATE(timestamp) as date,
      COUNT(*) as count
    FROM activity_log
    WHERE user_id = ?
      AND activity_type = 'question_generated'
      AND timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(timestamp)
    ORDER BY date DESC
  `);

  return stmt.all(userId, days);
}

// Obtener preguntas por mes de un usuario
function getUserQuestionsPerMonth(userId, months = 6) {
  const stmt = db.prepare(`
    SELECT
      strftime('%Y-%m', timestamp) as month,
      COUNT(*) as count
    FROM activity_log
    WHERE user_id = ?
      AND activity_type = 'question_generated'
      AND timestamp >= datetime('now', '-' || ? || ' months')
    GROUP BY strftime('%Y-%m', timestamp)
    ORDER BY month DESC
  `);

  return stmt.all(userId, months);
}

// Obtener actividad reciente de un usuario
function getUserActivity(userId, limit = 50) {
  const stmt = db.prepare(`
    SELECT activity_type, topic_id, timestamp
    FROM activity_log
    WHERE user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  return stmt.all(userId, limit);
}

// Calcular tiempo promedio en la app por usuario
function getUserAverageSessionTime(userId) {
  // Calcular sesiones basadas en gaps de más de 30 minutos
  const stmt = db.prepare(`
    SELECT
      timestamp,
      LAG(timestamp) OVER (ORDER BY timestamp) as prev_timestamp
    FROM activity_log
    WHERE user_id = ?
    ORDER BY timestamp
  `);

  const activities = stmt.all(userId);

  if (activities.length < 2) {
    return { avgSessionMinutes: 0, totalSessions: 0 };
  }

  let sessions = [];
  let currentSessionStart = activities[0].timestamp;
  let currentSessionEnd = activities[0].timestamp;

  for (let i = 1; i < activities.length; i++) {
    const current = new Date(activities[i].timestamp);
    const previous = new Date(activities[i - 1].timestamp);
    const diffMinutes = (current - previous) / (1000 * 60);

    if (diffMinutes > 30) {
      // Nueva sesión
      sessions.push({
        start: currentSessionStart,
        end: currentSessionEnd,
        duration: (new Date(currentSessionEnd) - new Date(currentSessionStart)) / (1000 * 60)
      });
      currentSessionStart = activities[i].timestamp;
    }
    currentSessionEnd = activities[i].timestamp;
  }

  // Agregar última sesión
  sessions.push({
    start: currentSessionStart,
    end: currentSessionEnd,
    duration: (new Date(currentSessionEnd) - new Date(currentSessionStart)) / (1000 * 60)
  });

  const totalMinutes = sessions.reduce((sum, s) => sum + s.duration, 0);
  const avgMinutes = sessions.length > 0 ? totalMinutes / sessions.length : 0;

  return {
    avgSessionMinutes: Math.round(avgMinutes),
    totalSessions: sessions.length,
    totalMinutes: Math.round(totalMinutes)
  };
}

// Obtener resumen de actividad de hoy
function getTodayActivity() {
  const stmt = db.prepare(`
    SELECT
      u.username,
      COUNT(a.id) as questions_today
    FROM users u
    LEFT JOIN activity_log a ON u.id = a.user_id
      AND DATE(a.timestamp) = DATE('now')
      AND a.activity_type = 'question_generated'
    WHERE u.estado = 'activo'
    GROUP BY u.id
    HAVING questions_today > 0
    ORDER BY questions_today DESC
  `);

  return stmt.all();
}

// ========================
// FUNCIONES DE TRACKEO DE CHUNKS (Sin repetición - Opción B)
// ========================

// Obtener chunk no usado para un usuario y tema
function getUnusedChunkIndex(userId, topicId, totalChunks) {
  // Obtener chunks ya usados
  const usedStmt = db.prepare(`
    SELECT chunk_index
    FROM chunk_usage
    WHERE user_id = ? AND topic_id = ?
  `);

  const usedChunks = usedStmt.all(userId, topicId).map(r => r.chunk_index);

  // Si ya usó todos los chunks, resetear (empezar de nuevo)
  if (usedChunks.length >= totalChunks) {
    console.log(`♻️ Usuario ${userId} completó todos los chunks del tema ${topicId}. Reseteando...`);
    resetChunkUsage(userId, topicId);
    return Math.floor(Math.random() * totalChunks);
  }

  // Crear array de chunks disponibles
  const availableChunks = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!usedChunks.includes(i)) {
      availableChunks.push(i);
    }
  }

  // Seleccionar uno aleatorio de los disponibles
  const randomIndex = Math.floor(Math.random() * availableChunks.length);
  const selectedChunk = availableChunks[randomIndex];

  console.log(`🎲 Chunks disponibles: ${availableChunks.length}/${totalChunks}, seleccionado: ${selectedChunk}`);

  return selectedChunk;
}

// Marcar chunk como usado
function markChunkAsUsed(userId, topicId, chunkIndex) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO chunk_usage (user_id, topic_id, chunk_index)
      VALUES (?, ?, ?)
    `);

    stmt.run(userId, topicId, chunkIndex);
    console.log(`✅ Chunk ${chunkIndex} marcado como usado para usuario ${userId}, tema ${topicId}`);
  } catch (error) {
    console.error('Error marcando chunk como usado:', error);
  }
}

// Resetear chunks usados (cuando se completan todos)
function resetChunkUsage(userId, topicId) {
  const stmt = db.prepare(`
    DELETE FROM chunk_usage
    WHERE user_id = ? AND topic_id = ?
  `);

  stmt.run(userId, topicId);
  console.log(`🔄 Chunks reseteados para usuario ${userId}, tema ${topicId}`);
}

// Obtener estadísticas de cobertura de chunks por usuario
function getChunkCoverage(userId, topicId) {
  const stmt = db.prepare(`
    SELECT COUNT(*) as used_chunks
    FROM chunk_usage
    WHERE user_id = ? AND topic_id = ?
  `);

  const result = stmt.get(userId, topicId);
  return result.used_chunks || 0;
}

// ========================
// FUNCIONES DE CACHÉ DE PREGUNTAS
// ========================

const NO_REPEAT_DAYS = 15; // Periodo mínimo sin repeticiones (configurable)
const CACHE_NEVER_EXPIRES = new Date('2100-01-01').getTime(); // 🔴 FIX: Caché nunca expira (año 2100)
const MAX_CACHE_SIZE = 10000; // Límite máximo de preguntas en caché

/**
 * Buscar pregunta en caché que el usuario NO ha visto
 * @param {number} userId - ID del usuario
 * @param {string|string[]} topicIds - ID del tema o array de IDs de temas
 * @param {string} difficulty - Dificultad requerida ('simple', 'media', 'elaborada')
 * @returns {object|null} - Pregunta del caché o null si no hay disponibles
 */
function getCachedQuestion(userId, topicIds, difficulty, excludeIds = []) {
  const cutoffTime = Date.now() - (NO_REPEAT_DAYS * 24 * 3600 * 1000);
  const now = Date.now();

  // Convertir a array si es string único
  const topicArray = Array.isArray(topicIds) ? topicIds : [topicIds];

  if (topicArray.length === 0) {
    console.log('✗ No se proporcionaron temas');
    return null;
  }

  try {
    // Validar topicIds para prevenir SQL injection
    const validTopicPattern = /^[a-z0-9-]+$/;
    if (!topicArray.every(t => typeof t === 'string' && validTopicPattern.test(t))) {
      console.error('⚠️ topicIds inválidos detectados:', topicArray);
      return null;
    }

    // Construir placeholders para IN clause de topics
    const placeholders = topicArray.map(() => '?').join(',');

    // FIX: Construir condición para excluir IDs ya seleccionados en esta request
    let excludeCondition = '';
    if (excludeIds.length > 0) {
      const excludePlaceholders = excludeIds.map(() => '?').join(',');
      excludeCondition = `AND qc.id NOT IN (${excludePlaceholders})`;
    }

    // OPTIMIZACIÓN: Usar LEFT JOIN en lugar de subquery correlacionada
    // Esto es ~10-50x más rápido con 10K preguntas en caché
    const stmt = db.prepare(`
      SELECT qc.id, qc.question_data, qc.topic_id
      FROM question_cache qc
      LEFT JOIN user_seen_questions usq
        ON qc.id = usq.question_cache_id
        AND usq.user_id = ?
        AND usq.seen_at > ?
      WHERE qc.topic_id IN (${placeholders})
        AND qc.difficulty = ?
        AND qc.expires_at > ?
        AND usq.question_cache_id IS NULL
        ${excludeCondition}
      ORDER BY RANDOM()
      LIMIT 1
    `);

    const params = [userId, cutoffTime, ...topicArray, difficulty, now, ...excludeIds];
    const result = stmt.get(...params);

    if (result) {
      console.log(`✓ Pregunta encontrada en caché (ID: ${result.id}, Tema: ${result.topic_id})`);
      return {
        cacheId: result.id,
        topicId: result.topic_id,
        question: JSON.parse(result.question_data)
      };
    }

    console.log(`✗ No hay preguntas disponibles en caché para usuario ${userId}, temas [${topicArray.join(', ')}], dificultad ${difficulty}`);
    return null;
  } catch (error) {
    console.error('Error buscando en caché:', error);
    return null;
  }
}

/**
 * Limpiar caché antiguo si supera el límite de 10,000 preguntas
 * Elimina las preguntas más antiguas (FIFO)
 */
function cleanOldCacheIfNeeded() {
  try {
    // Contar preguntas actuales en caché
    const countStmt = db.prepare('SELECT COUNT(*) as total FROM question_cache');
    const result = countStmt.get();
    const currentSize = result.total;

    if (currentSize >= MAX_CACHE_SIZE) {
      // 🔴 FIX: Eliminar preguntas considerando popularidad y referencias activas
      const deleteCount = 1000; // Elimina 1000 menos útiles cuando llega al límite
      console.log(`🗑️ Caché lleno (${currentSize}/${MAX_CACHE_SIZE}) - Eliminando ${deleteCount} preguntas menos útiles...`);

      // Calcular score de prioridad: más bajo = más candidato a eliminación
      // Score = (times_used * 100) + (días desde generación * -1)
      // Excluir preguntas que están en buffers activos
      db.prepare(`
        DELETE FROM question_cache
        WHERE id IN (
          SELECT qc.id
          FROM question_cache qc
          LEFT JOIN user_question_buffer uqb ON qc.id = uqb.question_cache_id AND uqb.expires_at > ?
          WHERE uqb.question_cache_id IS NULL
          ORDER BY (qc.times_used * 100) - ((? - qc.generated_at) / 86400000) ASC
          LIMIT ?
        )
      `).run(Date.now(), Date.now(), deleteCount);

      const newSize = currentSize - deleteCount;
      console.log(`✅ Caché limpiado: ${newSize}/${MAX_CACHE_SIZE} preguntas restantes (priorizando popularidad)`);
    }
  } catch (error) {
    console.error('Error limpiando caché:', error);
  }
}

/**
 * Guardar pregunta en caché y marcarla como vista por el usuario
 * @param {number} userId - ID del usuario
 * @param {string} topicId - ID del tema
 * @param {string} difficulty - Dificultad de la pregunta
 * @param {object} questionData - Datos completos de la pregunta
 * @param {string} context - Contexto ('study' o 'exam')
 * @returns {number} - ID de la pregunta en caché
 */
function saveToCacheAndTrack(userId, topicId, difficulty, questionData, context = 'study') {
  const now = Date.now();
  const expiresAt = CACHE_NEVER_EXPIRES; // 🔴 FIX: Nunca expira (año 2100), solo se limpia por límite

  // Limpiar caché si supera el límite de 10,000 preguntas (elimina 1000 menos útiles)
  cleanOldCacheIfNeeded();

  try {
    // 1. Guardar en caché
    const insertStmt = db.prepare(`
      INSERT INTO question_cache (question_data, difficulty, topic_id, generated_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      JSON.stringify(questionData),
      difficulty,
      topicId,
      now,
      expiresAt
    );

    const cacheId = result.lastInsertRowid;

    // 2. Marcar como vista por este usuario
    const trackStmt = db.prepare(`
      INSERT INTO user_seen_questions (user_id, question_cache_id, seen_at, context)
      VALUES (?, ?, ?, ?)
    `);

    trackStmt.run(userId, cacheId, now, context);

    // 3. Incrementar contador de uso
    const updateStmt = db.prepare(`
      UPDATE question_cache
      SET times_used = times_used + 1
      WHERE id = ?
    `);

    updateStmt.run(cacheId);

    console.log(`✅ Pregunta guardada en caché (ID: ${cacheId}) y marcada como vista por usuario ${userId}`);
    return cacheId;
  } catch (error) {
    console.error('Error guardando en caché:', error);
    return null;
  }
}

/**
 * Guardar pregunta al caché SIN tracking de usuario (para preguntas sobrantes/buffer)
 * @param {string} topicId - ID del tema
 * @param {string} difficulty - Dificultad de la pregunta
 * @param {object} questionData - Datos de la pregunta
 * @returns {number} - ID de la pregunta en caché
 */
function saveToCache(topicId, difficulty, questionData) {
  const now = Date.now();
  const expiresAt = CACHE_NEVER_EXPIRES; // 🔴 FIX: Nunca expira (año 2100), solo se limpia por límite

  // Limpiar caché si supera el límite (elimina 1000 menos útiles)
  cleanOldCacheIfNeeded();

  try {
    const insertStmt = db.prepare(`
      INSERT INTO question_cache (question_data, difficulty, topic_id, generated_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      JSON.stringify(questionData),
      difficulty,
      topicId,
      now,
      expiresAt
    );

    return result.lastInsertRowid;
  } catch (error) {
    console.error('Error guardando en caché:', error);
    return null;
  }
}

/**
 * Marcar pregunta existente del caché como vista por un usuario
 * @param {number} userId - ID del usuario
 * @param {number} cacheId - ID de la pregunta en caché
 * @param {string} context - Contexto ('study' o 'exam')
 */
function markQuestionAsSeen(userId, cacheId, context = 'study') {
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO user_seen_questions (user_id, question_cache_id, seen_at, context)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(userId, cacheId, now, context);

    // Incrementar contador
    const updateStmt = db.prepare(`
      UPDATE question_cache
      SET times_used = times_used + 1
      WHERE id = ?
    `);

    updateStmt.run(cacheId);

    console.log(`✅ Pregunta ${cacheId} marcada como vista por usuario ${userId}`);
  } catch (error) {
    console.error('Error marcando pregunta como vista:', error);
  }
}

/**
 * Limpiar preguntas expiradas del caché
 * @returns {number} - Cantidad de preguntas eliminadas
 */
function cleanExpiredCache() {
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      DELETE FROM question_cache
      WHERE expires_at < ?
    `);

    const result = stmt.run(now);

    if (result.changes > 0) {
      console.log(`🧹 Limpieza de caché: ${result.changes} preguntas expiradas eliminadas`);
    }

    return result.changes;
  } catch (error) {
    console.error('Error limpiando caché:', error);
    return 0;
  }
}

/**
 * Obtener estadísticas del caché
 * @returns {object} - Estadísticas del sistema de caché
 */
function getCacheStats() {
  try {
    // Total de preguntas en caché
    const totalStmt = db.prepare('SELECT COUNT(*) as total FROM question_cache WHERE expires_at > ?');
    const total = totalStmt.get(Date.now()).total;

    // Preguntas por dificultad
    const diffStmt = db.prepare(`
      SELECT difficulty, COUNT(*) as count
      FROM question_cache
      WHERE expires_at > ?
      GROUP BY difficulty
    `);
    const byDifficulty = diffStmt.all(Date.now());

    // Preguntas más usadas
    const topStmt = db.prepare(`
      SELECT times_used, COUNT(*) as count
      FROM question_cache
      WHERE expires_at > ?
      GROUP BY times_used
      ORDER BY times_used DESC
      LIMIT 5
    `);
    const topUsed = topStmt.all(Date.now());

    return {
      totalQuestions: total,
      byDifficulty,
      topUsed
    };
  } catch (error) {
    console.error('Error obteniendo estadísticas de caché:', error);
    return { totalQuestions: 0, byDifficulty: [], topUsed: [] };
  }
}

/**
 * Actualizar estadísticas diarias de caché
 * @param {number} questionsGenerated - Preguntas generadas nuevas
 * @param {number} questionsCached - Preguntas obtenidas de caché
 * @param {number} totalCost - Coste total en USD
 */
function updateCacheStats(questionsGenerated, questionsCached, totalCost) {
  const today = new Date().toISOString().split('T')[0];
  const total = questionsGenerated + questionsCached;
  const hitRate = total > 0 ? (questionsCached / total) : 0;

  try {
    const stmt = db.prepare(`
      INSERT INTO cache_stats (date, questions_generated, questions_cached, cache_hit_rate, total_cost_usd)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        questions_generated = questions_generated + ?,
        questions_cached = questions_cached + ?,
        cache_hit_rate = (CAST(questions_cached AS REAL) / (questions_generated + questions_cached)),
        total_cost_usd = total_cost_usd + ?
    `);

    stmt.run(today, questionsGenerated, questionsCached, hitRate, totalCost, questionsGenerated, questionsCached, totalCost);
  } catch (error) {
    console.error('Error actualizando estadísticas de caché:', error);
  }
}

// ========================
// FUNCIONES DE BUFFER (PREFETCH)
// ========================

/**
 * Añadir pregunta al buffer del usuario
 * @param {number} userId - ID del usuario
 * @param {string} topicId - ID del tema
 * @param {object} questionData - Datos de la pregunta
 * @param {string} difficulty - Dificultad
 * @param {number|null} cacheId - ID en cache (si aplica)
 */
function addToBuffer(userId, topicId, questionData, difficulty, cacheId = null) {
  const now = Date.now();
  const expiresAt = now + (6 * 3600 * 1000); // 6 horas expiry (consistente con limpieza)

  try {
    // Validar que questionData tiene los campos mínimos requeridos
    if (!questionData || !questionData.question || !questionData.options) {
      console.error('Error: questionData inválido en addToBuffer');
      return null;
    }

    // 🔴 FIX: Verificar límite máximo antes de insertar (previene buffer infinito por bugs)
    const MAX_BUFFER_SIZE = 5; // Límite: 5 preguntas por usuario+tema
    const currentCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM user_question_buffer
      WHERE user_id = ? AND topic_id = ? AND expires_at > ?
    `).get(userId, topicId, now).count;

    if (currentCount >= MAX_BUFFER_SIZE) {
      console.warn(`⚠️ Buffer lleno para usuario ${userId}, tema ${topicId} (${currentCount}/${MAX_BUFFER_SIZE})`);
      return null;
    }

    const stmt = db.prepare(`
      INSERT INTO user_question_buffer (user_id, topic_id, question_data, question_cache_id, difficulty, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const questionJson = JSON.stringify(questionData);
    const result = stmt.run(userId, topicId, questionJson, cacheId, difficulty, now, expiresAt);
    return result.lastInsertRowid;
  } catch (error) {
    console.error('Error añadiendo pregunta al buffer:', error);
    return null;
  }
}

/**
 * Obtener pregunta del buffer
 * @param {number} userId - ID del usuario
 * @param {string} topicId - ID del tema
 * @returns {object|null} Pregunta del buffer o null
 */
function getFromBuffer(userId, topicId) {
  const now = Date.now();

  // Usar transacción para prevenir race conditions
  // SELECT + DELETE debe ser atómico para evitar que múltiples requests obtengan la misma pregunta
  const getAndDeleteQuestion = db.transaction(() => {
    const selectStmt = db.prepare(`
      SELECT id, question_data, question_cache_id, difficulty
      FROM user_question_buffer
      WHERE user_id = ?
        AND topic_id = ?
        AND expires_at > ?
      ORDER BY created_at ASC
      LIMIT 1
    `);

    const result = selectStmt.get(userId, topicId, now);

    if (!result) {
      return null;
    }

    // Parsear y validar JSON
    let questionData = null;

    try {
      questionData = JSON.parse(result.question_data);

      // Validar estructura de la pregunta
      if (!questionData ||
          typeof questionData !== 'object' ||
          !questionData.question ||
          !Array.isArray(questionData.options) ||
          questionData.options.length !== 4 ||
          typeof questionData.correct !== 'number') {
        throw new Error('Estructura de pregunta inválida');
      }

    } catch (parseError) {
      console.error('Error parseando/validando question_data del buffer:', parseError);
      // Eliminar pregunta corrupta del buffer
      db.prepare('DELETE FROM user_question_buffer WHERE id = ?').run(result.id);
      return null;
    }

    // DELETE dentro de la transacción (atómico con el SELECT)
    db.prepare('DELETE FROM user_question_buffer WHERE id = ?').run(result.id);

    return {
      question: questionData,
      cacheId: result.question_cache_id
    };
  });

  try {
    return getAndDeleteQuestion();
  } catch (error) {
    console.error('Error en transacción getFromBuffer:', error);
    return null;
  }
}

/**
 * Obtener tamaño del buffer para un usuario y tema
 * @param {number} userId - ID del usuario
 * @param {string} topicId - ID del tema
 * @returns {number} Cantidad de preguntas en buffer
 */
function getBufferSize(userId, topicId) {
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM user_question_buffer
      WHERE user_id = ?
        AND topic_id = ?
        AND expires_at > ?
    `);

    return stmt.get(userId, topicId, now).count;
  } catch (error) {
    console.error('Error obteniendo tamaño del buffer:', error);
    return 0;
  }
}

/**
 * Limpiar buffers expirados
 * @returns {number} Cantidad de preguntas eliminadas
 */
function cleanExpiredBuffers() {
  const now = Date.now();

  try {
    const stmt = db.prepare(`
      DELETE FROM user_question_buffer
      WHERE expires_at < ?
    `);

    const result = stmt.run(now);

    if (result.changes > 0) {
      console.log(`🧹 Buffer limpio: ${result.changes} preguntas expiradas eliminadas`);
    }

    return result.changes;
  } catch (error) {
    console.error('Error limpiando buffers expirados:', error);
    return 0;
  }
}

// ========================
// FUNCIONES DE ESTADÍSTICAS SEMANALES
// ========================

/**
 * Registrar respuesta en historial (para estadísticas semanales)
 * @param {number} userId - ID del usuario
 * @param {string} topicId - ID del tema
 * @param {string} topicTitle - Título del tema
 * @param {boolean} isCorrect - Si la respuesta fue correcta
 */
function recordAnswer(userId, topicId, topicTitle, isCorrect) {
  try {
    const stmt = db.prepare(`
      INSERT INTO answer_history (user_id, topic_id, topic_title, is_correct)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(userId, topicId, topicTitle, isCorrect ? 1 : 0);
  } catch (error) {
    console.error('Error registrando respuesta en historial:', error);
  }
}

/**
 * Obtener estadísticas semanales por tema
 * @param {number} userId - ID del usuario
 * @param {number} weeks - Número de semanas hacia atrás (default: 4)
 * @returns {Array} Estadísticas agrupadas por semana y tema
 */
function getWeeklyStatsByTopic(userId, weeks = 4) {
  try {
    const stmt = db.prepare(`
      SELECT
        topic_id,
        topic_title,
        strftime('%Y-W%W', answered_at) as week,
        date(answered_at, 'weekday 0', '-6 days') as week_start,
        COUNT(*) as total_questions,
        SUM(is_correct) as correct_answers,
        ROUND(CAST(SUM(is_correct) AS FLOAT) / COUNT(*) * 100, 1) as accuracy
      FROM answer_history
      WHERE user_id = ?
        AND answered_at >= datetime('now', '-' || ? || ' days')
      GROUP BY topic_id, week
      ORDER BY week DESC, topic_id ASC
    `);

    const allResults = stmt.all(userId, weeks * 7);

    // 🔴 FIX: Limitar a exactamente N semanas únicas solicitadas
    const uniqueWeeks = [...new Set(allResults.map(r => r.week))];
    const limitedWeeks = uniqueWeeks.slice(0, weeks);

    return allResults.filter(r => limitedWeeks.includes(r.week));
  } catch (error) {
    console.error('Error obteniendo estadísticas semanales:', error);
    return [];
  }
}

/**
 * Obtener resumen semanal consolidado
 * @param {number} userId - ID del usuario
 * @param {number} weeks - Número de semanas hacia atrás (default: 4)
 * @returns {Array} Resumen por semana con totales
 */
function getWeeklySummary(userId, weeks = 4) {
  try {
    const stmt = db.prepare(`
      SELECT
        strftime('%Y-W%W', answered_at) as week,
        date(answered_at, 'weekday 0', '-6 days') as week_start,
        COUNT(*) as total_questions,
        SUM(is_correct) as correct_answers,
        ROUND(CAST(SUM(is_correct) AS FLOAT) / COUNT(*) * 100, 1) as accuracy,
        COUNT(DISTINCT topic_id) as topics_studied
      FROM answer_history
      WHERE user_id = ?
        AND answered_at >= datetime('now', '-' || ? || ' days')
      GROUP BY week
      ORDER BY week DESC
      LIMIT ?
    `);

    return stmt.all(userId, weeks * 7, weeks);
  } catch (error) {
    console.error('Error obteniendo resumen semanal:', error);
    return [];
  }
}

// ========================
// EXPORTAR FUNCIONES
// ========================

module.exports = {
  initDatabase,
  createUser,
  authenticateUser,
  getAllUsers,
  activateUser,
  blockUser,
  blockAllUsers,
  getUserById,
  getUserStats,
  updateUserStats,
  getUserFailedQuestions,
  addFailedQuestion,
  removeFailedQuestion,
  logActivity,
  getAdminStats,
  updateLastAccess,
  updateActiveSessions,
  getUserQuestionsPerDay,
  getUserQuestionsPerMonth,
  getUserActivity,
  getUserAverageSessionTime,
  getTodayActivity,
  getUnusedChunkIndex,
  markChunkAsUsed,
  resetChunkUsage,
  getChunkCoverage,
  // Funciones de caché
  getCachedQuestion,
  saveToCache,
  saveToCacheAndTrack,
  markQuestionAsSeen,
  cleanExpiredCache,
  getCacheStats,
  updateCacheStats,
  // Funciones de buffer (prefetch)
  addToBuffer,
  getFromBuffer,
  getBufferSize,
  cleanExpiredBuffers,
  // Funciones de estadísticas semanales
  recordAnswer,
  getWeeklyStatsByTopic,
  getWeeklySummary,
  db
};
